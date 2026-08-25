const express = require("express");
const router = express.Router();
const { db } = require("../db/database");
const { asyncHandler } = require("../lib/async-handler");

// Merged in from BeamOS-Dashboard's routes/content.js (split out from
// dashboard-content.js into its own mount - the frontend calls this at
// /api/dashboard/issues, a sibling of /content rather than a sub-path of it).

// GET /api/dashboard/issues?start=&end=
// Groups player_debug_logs by error_fingerprint. player_debug_logs has no
// workspace_id column and device_id has no FK to devices — it's a public,
// unauthenticated ingestion sink (the player may not have paired yet when
// an error fires), so there's no tenant boundary to join through. BeamOS's
// own admin routes for this table (server/routes/player-debug.js — GET
// /list, GET /summary, DELETE /older-than) are gated by requireSuperAdmin
// with zero workspace filtering rather than scoped via devices. Same rule
// here: platform-admin only, no workspace scope.
router.get(
  "/",
  asyncHandler(async (req, res) => {
    if (!req.isPlatformAdmin)
      return res.status(403).json({ error: "Forbidden" });

    const { start, end } = req.query;
    const startEpoch = start
      ? Math.floor(new Date(start).getTime() / 1000)
      : Math.floor(Date.now() / 1000) - 30 * 86400;
    const endEpoch = end
      ? Math.floor(new Date(end + "T23:59:59").getTime() / 1000)
      : Math.floor(Date.now() / 1000);

    const rows = await db
      .prepare(
        `
      SELECT error_fingerprint,
             COUNT(*) AS occurrence_count,
             COUNT(DISTINCT device_id) AS affected_devices,
             MAX(created_at) AS last_seen
      FROM player_debug_logs
      WHERE error_fingerprint IS NOT NULL
        AND created_at >= ? AND created_at <= ?
      GROUP BY error_fingerprint
      ORDER BY affected_devices DESC LIMIT 50
    `,
      )
      .all(startEpoch, endEpoch);

    res.json(rows);
  }),
);

module.exports = router;
