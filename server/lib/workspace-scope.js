'use strict';

// Phase 2.2g: scope reports/device queries to the caller's current workspace.
// No platform_admin bypass - cross-workspace visibility comes from
// switch-workspace, not a magic role-based "see all" path. This matches
// the precedent set in devices.js. Extracted from routes/reports.js so
// routes/dashboard-*.js (merged in from BeamOS Dashboard) share the same
// scoping logic instead of a second copy drifting out of sync.

function getWorkspaceDeviceFilter(req) {
  if (!req.workspaceId) return { sql: ' AND 1=0', params: [] }; // no workspace -> empty result
  return { sql: ' AND d.workspace_id = ?', params: [req.workspaceId] };
}

function getWorkspaceDeviceSubquery(req) {
  if (!req.workspaceId)
    return {
      sql: ' AND device_id IN (SELECT id FROM devices WHERE 1=0)',
      params: [],
    };
  return {
    sql: ' AND device_id IN (SELECT id FROM devices WHERE workspace_id = ?)',
    params: [req.workspaceId],
  };
}

module.exports = { getWorkspaceDeviceFilter, getWorkspaceDeviceSubquery };
