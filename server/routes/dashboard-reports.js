const express = require("express");
const router = express.Router();
const { db } = require("../db/database");
const { asyncHandler } = require("../lib/async-handler");
const {
  getWorkspaceDeviceFilter,
  getWorkspaceDeviceSubquery,
} = require("../lib/workspace-scope");

// Merged in from BeamOS-Dashboard's routes/reports.js.

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

// GET /api/dashboard/reports/availability?start=YYYY-MM-DD&end=YYYY-MM-DD
// 2.3 — rollup off device_usage_daily (confirmed populated by BeamOS's
// services/heartbeat.js accrueUsage(), which UPSERTs it every heartbeat
// tick for billing — so this is a real widget, not the blueprint's
// "confirm before building" gap).
router.get(
  "/availability",
  asyncHandler(async (req, res) => {
    const startDate =
      req.query.start || isoDate(new Date(Date.now() - 30 * 86400000));
    const endDate = req.query.end || isoDate(new Date());

    const wsScope = getWorkspaceDeviceSubquery(req);
    const rows = await db
      .prepare(
        `
      SELECT
        device_id,
        SUM(online_seconds) AS total_online_seconds,
        COUNT(*) AS days_counted,
        ROUND(SUM(online_seconds) / (COUNT(*) * 86400) * 100, 1) AS avg_availability_pct
      FROM device_usage_daily
      WHERE day BETWEEN ? AND ?${wsScope.sql}
      GROUP BY device_id
    `,
      )
      .all(startDate, endDate, ...wsScope.params);

    res.json(rows);
  }),
);

// GET /api/dashboard/reports/uptime?start=&end=
// 2.4 — the exact heartbeat-based estimate ported verbatim from BeamOS's
// server/routes/reports.js GET /uptime (a different, already-proven estimate
// from 2.3's availability — see the blueprint's note to label them distinctly
// in the UI). NOTE: this duplicates /api/reports/uptime's query logic under a
// different mount path — left as-is for this structural merge (deliberately
// out of scope per the merge plan's "no reporting-surface unification" note);
// a follow-up could point the Dashboard UI at /api/reports/uptime directly
// and delete this route instead.
router.get(
  "/uptime",
  asyncHandler(async (req, res) => {
    const { device_id, start, end } = req.query;
    const startEpoch = start
      ? Math.floor(new Date(start).getTime() / 1000)
      : Math.floor(Date.now() / 1000) - 30 * 86400;
    const endEpoch = end
      ? Math.floor(new Date(end + "T23:59:59").getTime() / 1000)
      : Math.floor(Date.now() / 1000);

    const scope = getWorkspaceDeviceFilter(req);
    let sql = `SELECT dt.device_id, d.name as device_name,
    COUNT(*) as heartbeat_count,
    MIN(dt.reported_at) as first_seen,
    MAX(dt.reported_at) as last_seen
    FROM device_telemetry dt
    JOIN devices d ON dt.device_id = d.id
    WHERE dt.reported_at >= ? AND dt.reported_at <= ?${scope.sql}`;
    const params = [startEpoch, endEpoch, ...scope.params];
    if (device_id) {
      sql += " AND dt.device_id = ?";
      params.push(device_id);
    }
    sql += " GROUP BY dt.device_id ORDER BY d.name";

    const uptimeData = await db.prepare(sql).all(...params);

    const totalPeriod = endEpoch - startEpoch;
    uptimeData.forEach((d) => {
      d.estimated_uptime_pct = Math.min(
        100,
        Math.round(((d.heartbeat_count * 15) / totalPeriod) * 100 * 10) / 10,
      );
    });

    res.json(uptimeData);
  }),
);

module.exports = router;
