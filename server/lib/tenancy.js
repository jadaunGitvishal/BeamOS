// Phase 2.1: per-request tenancy resolver.
//
// Runs after requireAuth (which sets req.user and req.jwtWorkspaceId).
// Resolves the active workspace context for this request and attaches:
//
//   req.workspaceId      string | null   the workspace this request operates in
//   req.workspace        object | null   the full workspaces row
//   req.organizationId   string | null   parent org of req.workspace
//   req.workspaceRole    string | null   'workspace_admin' | 'workspace_editor' | 'workspace_viewer'
//   req.orgRole          string | null   'org_owner' | 'org_admin'
//   req.isPlatformAdmin  boolean         true when req.user.role is a platform-owner role
//                                        (isPlatformRole: platform_admin / legacy superadmin)
//   req.actingAs         boolean         true when the user reached this workspace via
//                                        org-level or platform-level access rather than
//                                        a direct workspace_members row
//
// Resolution order, top wins:
//   1. X-Workspace-Id header                (for explicit per-request override)
//   2. ?workspace_id= query param           (same purpose, easier in browser dev)
//   3. JWT current_workspace_id             (the user's last switched-to workspace)
//   4. First workspace_members row for user (sorted by joined_at ASC)
//   5. For platform_admin only: any workspace
//
// Steps 1-3 are validated against access. If a stale value (e.g. user was
// removed from the workspace) is found, it's discarded and we fall through.

'use strict';

const { db } = require('../db/database');
const { isPlatformRole, isPlatformStaff } = require('../middleware/auth');
const { asyncHandler } = require('./async-handler');

// Org roles that get cross-workspace ("acting as") access to every workspace
// in their org, not just ones they're directly a member of. Single source of
// truth for the org_owner/org_admin check that accessContext (below) and
// routes/dashboard.js's org-wide rollup gate both need, so they can't drift
// to different role sets independently.
const ORG_WIDE_ROLES = ['org_owner', 'org_admin'];
function isOrgWideRole(role) {
  return ORG_WIDE_ROLES.includes(role);
}

async function membershipOf(userId, workspaceId) {
  return db.prepare(
    'SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?'
  ).get(workspaceId, userId);
}

async function orgMembershipOf(userId, organizationId) {
  return db.prepare(
    'SELECT role FROM organization_members WHERE organization_id = ? AND user_id = ?'
  ).get(organizationId, userId);
}

async function loadWorkspace(workspaceId) {
  if (!workspaceId) return null;
  return db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId);
}

async function firstAccessibleWorkspace(userId) {
  return db.prepare(`
    SELECT w.* FROM workspaces w
    JOIN workspace_members wm ON wm.workspace_id = w.id
    WHERE wm.user_id = ?
    ORDER BY wm.joined_at ASC
    LIMIT 1
  `).get(userId);
}

// Check whether userId can access workspace via any path (member, org admin,
// or platform staff). Returns the access context: { workspaceRole, actingAs }
// or null if no access.
async function accessContext(userId, role, workspace) {
  const wsMembership = await membershipOf(userId, workspace.id);
  if (wsMembership) {
    return { workspaceRole: wsMembership.role, actingAs: false };
  }
  const orgMembership = await orgMembershipOf(userId, workspace.organization_id);
  if (orgMembership && (orgMembership.role === 'org_owner' || orgMembership.role === 'org_admin')) {
    return { workspaceRole: null, actingAs: true };
  }
  // #14: isPlatformRole (not a bare === 'platform_admin') so a legacy
  // 'superadmin' can act-as too. #13: isPlatformStaff additionally lets
  // platform_operator act-as into any org. actingAs:true (workspaceRole null)
  // is what skips the viewer-deny on resource writes, so staff get read/write
  // in any workspace - while canAdmin()/canAdminWorkspace() stay owner-gated,
  // so operators still can't perform workspace-admin actions.
  if (isPlatformStaff(role)) {
    return { workspaceRole: null, actingAs: true };
  }
  return null;
}

const resolveTenancy = asyncHandler(async function resolveTenancy(req, res, next) {
  if (!req.user) {
    // Should not happen when chained after requireAuth, but tolerate optionalAuth flows.
    return next();
  }

  // isPlatformAdmin = OWNER tier (drives canAdmin/canWrite owner short-circuits).
  // isPlatformStaff = OWNER + platform_operator; drives cross-org visibility and
  // act-as only. Operators get isPlatformStaff=true but isPlatformAdmin=false,
  // so they can see/act-as everywhere yet hold no owner power (#13).
  const isPlatformAdmin = isPlatformRole(req.user.role);
  const isPlatformStaffUser = isPlatformStaff(req.user.role);
  req.isPlatformAdmin = isPlatformAdmin;
  req.isPlatformOperator = isPlatformStaffUser && !isPlatformAdmin;
  req.isPlatformStaff = isPlatformStaffUser;

  // Build the ordered candidate list of workspace_ids to try. header/query
  // candidates are `explicit`: the caller named this workspace on purpose,
  // as opposed to the JWT's current_workspace_id, which is just carried
  // session state the caller didn't type anywhere on this request.
  const candidates = [];
  const headerWs = (req.headers['x-workspace-id'] || '').trim();
  if (headerWs) candidates.push({ id: headerWs, explicit: true });
  if (req.query && req.query.workspace_id) candidates.push({ id: String(req.query.workspace_id), explicit: true });
  if (req.jwtWorkspaceId) candidates.push({ id: req.jwtWorkspaceId, explicit: false });

  let workspace = null;
  let context = null;
  for (const candidate of candidates) {
    const ws = await loadWorkspace(candidate.id);
    if (!ws) continue;
    const ctx = await accessContext(req.user.id, req.user.role, ws);
    if (!ctx) {
      if (candidate.explicit) {
        // Caller explicitly asked for this workspace via X-Workspace-Id or
        // ?workspace_id= and has no path into it (not a member, not
        // org-wide, not platform staff) - reject instead of silently
        // substituting their own workspace. A stale JWT current_workspace_id
        // (not explicit) still falls through to the fallbacks below.
        return res.status(403).json({ error: 'Access denied to that workspace' });
      }
      continue;
    }
    workspace = ws;
    context = ctx;
    break;
  }

  if (!workspace) {
    // Fall back to the user's first workspace_members row.
    const first = await firstAccessibleWorkspace(req.user.id);
    if (first) {
      workspace = first;
      const wm = await membershipOf(req.user.id, first.id);
      context = { workspaceRole: wm.role, actingAs: false };
    } else if (isPlatformStaffUser) {
      // Platform staff (admin or operator) with no direct memberships: pick any
      // workspace (acting-as) so they land in a usable context. #13: operators
      // included here too - they have no memberships of their own but must be
      // able to act-as across orgs.
      const any = await db.prepare('SELECT * FROM workspaces LIMIT 1').get();
      if (any) {
        workspace = any;
        context = { workspaceRole: null, actingAs: true };
      }
    }
  }

  if (workspace) {
    req.workspaceId = workspace.id;
    req.workspace = workspace;
    req.organizationId = workspace.organization_id;
    req.workspaceRole = context.workspaceRole;
    req.actingAs = context.actingAs;
    const orgMembership = await orgMembershipOf(req.user.id, workspace.organization_id);
    req.orgRole = orgMembership ? orgMembership.role : null;
  } else {
    req.workspaceId = null;
    req.workspace = null;
    req.organizationId = null;
    req.workspaceRole = null;
    req.orgRole = null;
    req.actingAs = false;
  }

  next();
});

// Enumerate every workspace_id the given user has any path into:
//   - direct workspace_members rows
//   - any workspace in an org where they are org_owner / org_admin
//   - platform_admin / superadmin: every workspace in the system
// Used by socket.io rooms (Phase 2.3) to scope outbound broadcasts. /me's
// accessible_workspaces query mirrors this access logic but selects full rows
// rather than reusing this helper (different shape needs).
async function accessibleWorkspaceIds(userId, role) {
  if (!userId) return [];
  // #13: platform staff (admin OR operator) see every workspace - visibility,
  // not an owner power.
  if (isPlatformStaff(role)) {
    return (await db.prepare('SELECT id FROM workspaces').all()).map(r => r.id);
  }
  return (await db.prepare(`
    SELECT workspace_id AS id FROM workspace_members WHERE user_id = ?
    UNION
    SELECT w.id FROM workspaces w
    JOIN organization_members om ON om.organization_id = w.organization_id
    WHERE om.user_id = ? AND om.role IN ('org_owner', 'org_admin')
  `).all(userId, userId)).map(r => r.id);
}

module.exports = {
  resolveTenancy,
  // Exported for testing / direct use by routes that need ad-hoc checks.
  accessContext,
  membershipOf,
  orgMembershipOf,
  firstAccessibleWorkspace,
  accessibleWorkspaceIds,
  isOrgWideRole,
  ORG_WIDE_ROLES,
};
