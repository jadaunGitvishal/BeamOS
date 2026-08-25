const express = require("express");
const router = express.Router();
const { db } = require("../db/database");
const { asyncHandler } = require("../lib/async-handler");
const { getWorkspaceDeviceSubquery } = require("../lib/workspace-scope");
const { isOrgWideRole } = require("../lib/tenancy");

// GET /api/dashboard/overview?start=&end=
// Bundles blueprint widgets 1.1-1.4 into one round trip (Performance
// Checklist item 3: "bundle small independent aggregates into one response"),
// plus a 1.5 org block gated to platform-admin / org-owner / org-admin.
// Merged in from BeamOS-Dashboard's routes/dashboard.js.
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { start, end } = req.query;
    const startEpoch = start
      ? Math.floor(new Date(start).getTime() / 1000)
      : Math.floor(Date.now() / 1000) - 30 * 86400;
    const endEpoch = end
      ? Math.floor(new Date(end + "T23:59:59").getTime() / 1000)
      : Math.floor(Date.now() / 1000);

    // 1.1 + 1.2: fleet size and live status split.
    const fleet = req.workspaceId
      ? await db
          .prepare(
            `
      SELECT
        COUNT(*) AS total_devices,
        SUM(CASE WHEN status = 'online' THEN 1 ELSE 0 END) AS online,
        SUM(CASE WHEN status = 'offline' THEN 1 ELSE 0 END) AS offline
      FROM devices WHERE workspace_id = ?
    `,
          )
          .get(req.workspaceId)
      : { total_devices: 0, online: 0, offline: 0 };

    // 1.3 + 1.4: play volume + completion rate for the period.
    const wsScope = getWorkspaceDeviceSubquery(req);
    const plays = await db
      .prepare(
        `
      SELECT
        COUNT(*) AS total_plays,
        SUM(completed) AS completed_plays
      FROM play_logs
      WHERE started_at >= ? AND started_at <= ?${wsScope.sql}
    `,
      )
      .get(startEpoch, endEpoch, ...wsScope.params);
    const totalPlays = plays.total_plays || 0;
    const completedPlays = plays.completed_plays || 0;

    const overview = {
      period: {
        start: new Date(startEpoch * 1000).toISOString(),
        end: new Date(endEpoch * 1000).toISOString(),
      },
      total_devices: fleet.total_devices || 0,
      online: fleet.online || 0,
      offline: fleet.offline || 0,
      total_plays: totalPlays,
      completed_plays: completedPlays,
      completion_pct: totalPlays > 0 ? Math.round((completedPlays / totalPlays) * 1000) / 10 : null,
    };

    // 1.5: org-wide scope, only for platform admins / org owners / org admins.
    const canSeeOrg = req.isPlatformAdmin || isOrgWideRole(req.orgRole);
    if (canSeeOrg && req.organizationId) {
      const org = await db
        .prepare(
          `
        SELECT
          (SELECT COUNT(*) FROM workspaces WHERE organization_id = ?) AS workspace_count,
          (SELECT COUNT(*) FROM devices d JOIN workspaces w ON d.workspace_id = w.id WHERE w.organization_id = ?) AS device_count
      `,
        )
        .get(req.organizationId, req.organizationId);
      overview.org = { workspace_count: org.workspace_count, device_count: org.device_count };
    }

    res.json(overview);
  }),
);

module.exports = router;
