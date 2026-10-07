'use strict';

// Refs 49/67: geographic read-only access for the regional_viewer org role.
//
// Regions form a tree per organization (regions.parent_id, regions.level:
// region > cluster > area > territory). A regional_viewer holds one or more
// scopes (region_viewer_scopes) and may READ every workspace whose region_id is
// one of those regions or anywhere below one. lib/tenancy.accessContext turns
// that into a synthetic { workspaceRole: 'workspace_viewer', actingAs: false }
// (the same read-only shape as an org-wide field_technician), so every existing
// write gate denies them.
//
// Every query here:
//   - carries organization_id through each step and matches it at each join, so a
//     row that pointed across orgs (e.g. a workspace whose region_id names another
//     org's region) can never grant access;
//   - requires the user's organization_members.role to be 'regional_viewer' in
//     that org at query time (scopes left over from an old role grant nothing);
//   - is depth-limited (MAX_REGION_DEPTH). Strictly-higher parent levels already
//     make cycles impossible; the limit is the backstop.
// No caching: scope / region / role changes apply on the next request.
//
// Functions take the db handle explicitly (same shape as lib/permissions.js), so
// callers can pass a transaction handle.

const REGION_LEVELS = ['region', 'cluster', 'area', 'territory']; // highest first
const MAX_REGION_DEPTH = REGION_LEVELS.length;
const REGIONAL_VIEWER = 'regional_viewer';

function levelRank(level) {
  return REGION_LEVELS.indexOf(level);
}

// Cheap guard so the recursive queries only run for users who hold the role.
async function hasRegionalRole(db, userId) {
  if (!userId) return false;
  return !!(await db
    .prepare("SELECT 1 AS hit FROM organization_members WHERE user_id = ? AND role = 'regional_viewer' LIMIT 1")
    .get(userId));
}

// Is this workspace inside one of the user's scopes? Walks UP from the
// workspace's region to the top of its tree and checks each node against the
// user's scopes in the workspace's own org.
async function isWorkspaceInRegionalScope(db, userId, workspace) {
  if (!userId || !workspace || !workspace.region_id || !workspace.organization_id) return false;
  const org = workspace.organization_id;
  const row = await db
    .prepare(
      `WITH RECURSIVE up (id, parent_id, depth) AS (
         SELECT r.id, r.parent_id, 1 FROM regions r
          WHERE r.id = ? AND r.organization_id = ?
         UNION ALL
         SELECT p.id, p.parent_id, up.depth + 1 FROM regions p
           JOIN up ON p.id = up.parent_id
          WHERE p.organization_id = ? AND up.depth < ${MAX_REGION_DEPTH}
       )
       SELECT 1 AS hit FROM up
         JOIN region_viewer_scopes s ON s.region_id = up.id
         JOIN organization_members om ON om.organization_id = s.organization_id AND om.user_id = s.user_id
        WHERE s.organization_id = ? AND s.user_id = ? AND om.role = 'regional_viewer'
        LIMIT 1`,
    )
    .get(workspace.region_id, org, org, org, userId);
  return !!row;
}

// Every workspace id inside any of the user's scopes, across all orgs where they
// are a regional_viewer. Walks DOWN from each scope.
async function regionalWorkspaceIds(db, userId) {
  if (!(await hasRegionalRole(db, userId))) return [];
  const rows = await db
    .prepare(
      `WITH RECURSIVE down (organization_id, id, depth) AS (
         SELECT s.organization_id, s.region_id, 1
           FROM region_viewer_scopes s
           JOIN organization_members om ON om.organization_id = s.organization_id AND om.user_id = s.user_id
          WHERE s.user_id = ? AND om.role = 'regional_viewer'
         UNION ALL
         SELECT c.organization_id, c.id, down.depth + 1
           FROM regions c
           JOIN down ON c.parent_id = down.id AND c.organization_id = down.organization_id
          WHERE down.depth < ${MAX_REGION_DEPTH}
       )
       SELECT DISTINCT w.id FROM workspaces w
         JOIN down ON w.region_id = down.id AND w.organization_id = down.organization_id`,
    )
    .all(userId);
  return rows.map((r) => r.id);
}

// The workspace a regional_viewer with no direct membership lands in (login,
// resolveTenancy fallback): their first in-scope workspace by name, or null.
async function firstRegionalWorkspace(db, userId) {
  const ids = await regionalWorkspaceIds(db, userId);
  if (!ids.length) return null;
  return db
    .prepare(`SELECT * FROM workspaces WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY name, id LIMIT 1`)
    .get(...ids);
}

module.exports = {
  REGION_LEVELS,
  MAX_REGION_DEPTH,
  REGIONAL_VIEWER,
  levelRank,
  hasRegionalRole,
  isWorkspaceInRegionalScope,
  regionalWorkspaceIds,
  firstRegionalWorkspace,
};
