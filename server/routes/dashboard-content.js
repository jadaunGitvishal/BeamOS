const express = require("express");
const router = express.Router();
const { db } = require("../db/database");
const { asyncHandler } = require("../lib/async-handler");
const { getWorkspaceDeviceSubquery } = require("../lib/workspace-scope");

// Merged in from BeamOS-Dashboard's routes/content.js.

// GET /api/dashboard/content?start=&end=
// by_content query ported verbatim from BeamOS's server/routes/reports.js
// /summary endpoint, workspace-scoped the same way reports.js scopes
// play_logs (getWorkspaceDeviceSubquery, no admin bypass).
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

    const wsScope = getWorkspaceDeviceSubquery(req);
    const rows = await db
      .prepare(
        `
      SELECT content_id, content_name, COUNT(*) as plays,
             COALESCE(SUM(duration_sec), 0) as total_seconds,
             SUM(completed) as completed_plays
      FROM play_logs
      WHERE started_at >= ? AND started_at <= ?${wsScope.sql}
      GROUP BY content_id, content_name
      ORDER BY plays DESC LIMIT 50
    `,
      )
      .all(startEpoch, endEpoch, ...wsScope.params);

    const content = rows.map((r) => ({
      ...r,
      completion_pct:
        r.plays > 0
          ? Math.round((r.completed_plays / r.plays) * 1000) / 10
          : null,
    }));

    res.json({
      period: {
        start: new Date(startEpoch * 1000).toISOString(),
        end: new Date(endEpoch * 1000).toISOString(),
      },
      content,
    });
  }),
);

module.exports = router;
