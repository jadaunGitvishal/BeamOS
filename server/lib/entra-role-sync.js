'use strict';

// Ref 7: Entra ID app roles -> BeamOS org/workspace roles.
//
// An org admin maps an Entra app role VALUE (entra_role_mappings.claim_value) to
// org_admin on their org, or to a workspace role on one of its workspaces. Entra
// emits the user's assigned app roles (assigned directly or through a group) in
// the id_token `roles` claim. At each Microsoft sign-in whose id_token was
// VERIFIED against SSO_TENANT_ID (routes/auth.js POST /microsoft), syncEntraRoles
// brings the user's memberships in line with that claim. The `groups` claim is
// never read.
//
// Provenance is organization_members.source / workspace_members.source:
//   NULL    = manual (added by hand, by invite, by SCIM, by org bootstrap)
//   'entra' = created and managed by this sync
// The sync only ever creates, changes or removes 'entra' rows. A manual row for a
// target is left exactly as it is and reported as skipped_manual. An admin's
// manual role change on an 'entra' row sets source back to NULL (manual takeover,
// in the member routes), after which the sync leaves it alone too.

const { logActivity } = require('../services/activity');

const SOURCE_ENTRA = 'entra';

// role -> target level. Anything else (org_owner, field_technician, platform
// roles, custom strings) cannot be mapped.
const MAPPABLE_ROLES = {
  org_admin: 'org',
  workspace_admin: 'workspace',
  workspace_editor: 'workspace',
  workspace_viewer: 'workspace',
};
const WORKSPACE_ROLE_RANK = { workspace_viewer: 1, workspace_editor: 2, workspace_admin: 3 };

const MAX_CLAIM_VALUES = 100;
const MAX_CLAIM_LENGTH = 255;

// The validated roles claim: strings only, trimmed, non-empty, at most 255 chars
// (longer values are dropped, not truncated, so they can never match a different
// mapping), de-duplicated, at most the first 100.
function normalizeRoleClaims(roleClaims) {
  if (!Array.isArray(roleClaims)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of roleClaims) {
    if (typeof raw !== 'string') continue;
    const v = raw.trim();
    if (!v || v.length > MAX_CLAIM_LENGTH || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= MAX_CLAIM_VALUES) break;
  }
  return out;
}

// Pure. mappings: rows { organization_id, claim_value, workspace_id, role } from
// every org. Matching is exact (case-sensitive). Returns
//   { org: [{ organization_id, role }], workspace: [{ workspace_id, organization_id, role }] }
// When several mappings hit the same workspace the highest role wins
// (admin > editor > viewer). The only org-level role is org_admin.
function computeTargetMemberships(roleClaims, mappings) {
  const claims = new Set(normalizeRoleClaims(roleClaims));
  const org = new Map();
  const workspace = new Map();
  for (const m of mappings || []) {
    if (!m || !claims.has(m.claim_value)) continue;
    const level = MAPPABLE_ROLES[m.role];
    if (level === 'org' && !m.workspace_id) {
      org.set(m.organization_id, { organization_id: m.organization_id, role: m.role });
    } else if (level === 'workspace' && m.workspace_id) {
      const cur = workspace.get(m.workspace_id);
      if (!cur || WORKSPACE_ROLE_RANK[m.role] > WORKSPACE_ROLE_RANK[cur.role]) {
        workspace.set(m.workspace_id, {
          workspace_id: m.workspace_id,
          organization_id: m.organization_id,
          role: m.role,
        });
      }
    }
  }
  const byId = (k) => (a, b) => String(a[k]).localeCompare(String(b[k]));
  return {
    org: [...org.values()].sort(byId('organization_id')),
    workspace: [...workspace.values()].sort(byId('workspace_id')),
  };
}

// Applies the user's roles claim in ONE transaction. Returns
// { added, updated, removed, skipped_manual }, each a list of "org:<id>:<role>" /
// "ws:<id>:<role>" (updated carries the new role). Writes one 'entra_role_sync'
// audit row (ids and roles only - never the claim values, token or identity
// claims) when added, updated or removed is non-empty; that row also carries
// skipped_manual. A skip-only sync writes nothing. Throws on any DB error, after
// rolling back.
// opts.ip: client IP for the audit row.
async function syncEntraRoles(db, userId, roleClaims, opts = {}) {
  const run = () =>
    db.transaction(async (tx) => {
      // Mappings whose workspace really belongs to the mapping's org (the POST
      // route enforces this; re-checked here so a bad row can never grant access
      // in another org).
      const mappings = await tx
        .prepare(
          `SELECT m.organization_id, m.claim_value, m.workspace_id, m.role
           FROM entra_role_mappings m
           LEFT JOIN workspaces w ON w.id = m.workspace_id
           WHERE m.workspace_id IS NULL OR w.organization_id = m.organization_id`,
        )
        .all();
      const target = computeTargetMemberships(roleClaims, mappings);

      // Lock this user's membership rows (and, via the user_id index, the gaps
      // where new ones would go) so two concurrent sign-ins serialize.
      const orgRows = await tx
        .prepare('SELECT organization_id, role, source FROM organization_members WHERE user_id = ? FOR UPDATE')
        .all(userId);
      const wsRows = await tx
        .prepare('SELECT workspace_id, role, source FROM workspace_members WHERE user_id = ? FOR UPDATE')
        .all(userId);
      const wsOrg = new Map();
      if (wsRows.length) {
        const ids = wsRows.map((r) => r.workspace_id);
        const rows = await tx
          .prepare(`SELECT id, organization_id FROM workspaces WHERE id IN (${ids.map(() => '?').join(',')})`)
          .all(...ids);
        for (const r of rows) wsOrg.set(r.id, r.organization_id);
      }

      const summary = { added: [], updated: [], removed: [], skipped_manual: [] };

      const orgHave = new Map(orgRows.map((r) => [r.organization_id, r]));
      for (const t of target.org) {
        const key = `org:${t.organization_id}:${t.role}`;
        const row = orgHave.get(t.organization_id);
        if (!row) {
          await tx
            .prepare('INSERT INTO organization_members (organization_id, user_id, role, source) VALUES (?, ?, ?, ?)')
            .run(t.organization_id, userId, t.role, SOURCE_ENTRA);
          summary.added.push(key);
        } else if (row.source !== SOURCE_ENTRA) {
          summary.skipped_manual.push(key);
        } else if (row.role !== t.role) {
          await tx
            .prepare("UPDATE organization_members SET role = ? WHERE organization_id = ? AND user_id = ? AND source = 'entra'")
            .run(t.role, t.organization_id, userId);
          summary.updated.push(key);
        }
      }

      const wsHave = new Map(wsRows.map((r) => [r.workspace_id, r]));
      for (const t of target.workspace) {
        const key = `ws:${t.workspace_id}:${t.role}`;
        const row = wsHave.get(t.workspace_id);
        if (!row) {
          await tx
            .prepare('INSERT INTO workspace_members (workspace_id, user_id, role, source) VALUES (?, ?, ?, ?)')
            .run(t.workspace_id, userId, t.role, SOURCE_ENTRA);
          summary.added.push(key);
        } else if (row.source !== SOURCE_ENTRA) {
          summary.skipped_manual.push(key);
        } else if (row.role !== t.role) {
          await tx
            .prepare("UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ? AND source = 'entra'")
            .run(t.role, t.workspace_id, userId);
          summary.updated.push(key);
        }
      }

      // Removal scope: orgs with at least one mapping, plus orgs where the user
      // holds 'entra' rows (so deleting an org's LAST mapping still cleans up).
      const scope = new Set(mappings.map((m) => m.organization_id));
      for (const r of orgRows) if (r.source === SOURCE_ENTRA) scope.add(r.organization_id);
      for (const r of wsRows) if (r.source === SOURCE_ENTRA && wsOrg.has(r.workspace_id)) scope.add(wsOrg.get(r.workspace_id));

      const orgWanted = new Set(target.org.map((t) => t.organization_id));
      for (const r of orgRows) {
        if (r.source !== SOURCE_ENTRA || orgWanted.has(r.organization_id) || !scope.has(r.organization_id)) continue;
        await tx
          .prepare("DELETE FROM organization_members WHERE organization_id = ? AND user_id = ? AND source = 'entra'")
          .run(r.organization_id, userId);
        summary.removed.push(`org:${r.organization_id}:${r.role}`);
      }
      const wsWanted = new Set(target.workspace.map((t) => t.workspace_id));
      for (const r of wsRows) {
        if (r.source !== SOURCE_ENTRA || wsWanted.has(r.workspace_id) || !scope.has(wsOrg.get(r.workspace_id))) continue;
        await tx
          .prepare("DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND source = 'entra'")
          .run(r.workspace_id, userId);
        summary.removed.push(`ws:${r.workspace_id}:${r.role}`);
      }
      return summary;
    })();

  const summary = db.retryOnDeadlock ? await db.retryOnDeadlock(run) : await run();

  // Only when something changed; skipped_manual rides along but never triggers
  // an entry on its own (it would otherwise repeat at every sign-in).
  if (summary.added.length || summary.updated.length || summary.removed.length) {
    await logActivity(userId, 'entra_role_sync', JSON.stringify(summary), null, opts.ip || null, null);
  }
  return summary;
}

module.exports = {
  MAPPABLE_ROLES,
  WORKSPACE_ROLE_RANK,
  MAX_CLAIM_VALUES,
  MAX_CLAIM_LENGTH,
  SOURCE_ENTRA,
  normalizeRoleClaims,
  computeTargetMemberships,
  syncEntraRoles,
};
