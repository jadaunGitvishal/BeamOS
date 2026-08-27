const express = require("express");
const router = express.Router();
const { db } = require('../db/database');
const { asyncHandler } = require('../lib/async-handler');
const {
  getWorkspaceDeviceFilter,
  getWorkspaceDeviceSubquery,
} = require('../lib/workspace-scope');
const { renderXlsx, renderPdf } = require('../lib/report-export');
const { getProofOfPlaySummary } = require('../lib/proof-of-play');

// Query play logs
router.get(
  "/plays",
  asyncHandler(async (req, res) => {
    const { device_id, content_id, start, end, limit: lim } = req.query;
    const scope = getWorkspaceDeviceFilter(req);
    let sql = `SELECT pl.*, d.name as device_name
    FROM play_logs pl
    JOIN devices d ON pl.device_id = d.id
    WHERE 1=1${scope.sql}`;
    const params = [...scope.params];

    if (device_id) {
      sql += " AND pl.device_id = ?";
      params.push(device_id);
    }
    if (content_id) {
      sql += " AND pl.content_id = ?";
      params.push(content_id);
    }
    if (start) {
      sql += " AND pl.started_at >= ?";
      params.push(Math.floor(new Date(start).getTime() / 1000));
    }
    if (end) {
      sql += " AND pl.started_at <= ?";
      params.push(Math.floor(new Date(end).getTime() / 1000));
    }

    sql += " ORDER BY pl.started_at DESC LIMIT ?";
    params.push(parseInt(lim) || 500);

    res.json(await db.prepare(sql).all(...params));
  }),
);

// Summary report
router.get(
  "/summary",
  asyncHandler(async (req, res) => {
    const { device_id, start, end, group_by } = req.query;
    const startEpoch = start
      ? Math.floor(new Date(start).getTime() / 1000)
      : Math.floor(Date.now() / 1000) - 30 * 86400;
    const endEpoch = end
      ? Math.floor(new Date(end + "T23:59:59").getTime() / 1000)
      : Math.floor(Date.now() / 1000);

    // Phase 2.2g: workspace-scope all summary queries, no admin bypass.
    // MySQL note (byHour): HOUR(FROM_UNIXTIME(x)) converts using the DB session/global
    // time_zone (SYSTEM by default) - the closest match to SQLite's old 'localtime'.
    // byDay uses DATE_FORMAT (not DATE()) so `day` stays a plain 'YYYY-MM-DD' string.
    const wsScope = getWorkspaceDeviceSubquery(req);
    let scopeSql = wsScope.sql;
    const scopeParams = [...wsScope.params];
    if (device_id) {
      scopeSql += " AND device_id = ?";
      scopeParams.push(device_id);
    }

    res.json(
      await getProofOfPlaySummary({ scopeSql, scopeParams, startEpoch, endEpoch }),
    );
  }),
);

// Export CSV. Phase 2.2g: workspace-scoped. Previously this route had no scope
// filter at all - any authenticated user could export the entire platform's
// play_logs. The added WHERE clause closes that pre-existing cross-tenant leak.
router.get(
  "/export",
  asyncHandler(async (req, res) => {
    const { device_id, start, end } = req.query;
    const startEpoch = start ? Math.floor(new Date(start).getTime() / 1000) : 0;
    const endEpoch = end
      ? Math.floor(new Date(end + "T23:59:59").getTime() / 1000)
      : Math.floor(Date.now() / 1000);

    const scope = getWorkspaceDeviceFilter(req);
    let sql = `SELECT pl.*, d.name as device_name FROM play_logs pl JOIN devices d ON pl.device_id = d.id WHERE pl.started_at >= ? AND pl.started_at <= ?${scope.sql}`;
    const params = [startEpoch, endEpoch, ...scope.params];
    if (device_id) {
      sql += " AND pl.device_id = ?";
      params.push(device_id);
    }
    sql += " ORDER BY pl.started_at ASC";

    const rows = await db.prepare(sql).all(...params);

    const format = ["csv", "xlsx", "pdf"].includes(req.query.format)
      ? req.query.format
      : "csv";

    const headers = ["Device", "Content", "Started", "Ended", "Duration (sec)", "Completed"];
    const dataRows = rows.map((r) => {
      const started = new Date(r.started_at * 1000).toISOString();
      const ended = r.ended_at ? new Date(r.ended_at * 1000).toISOString() : "";
      return [r.device_name, r.content_name, started, ended, r.duration_sec || "", r.completed ? "Yes" : "No"];
    });

    if (format === "xlsx") {
      const buffer = await renderXlsx("Proof of Play", headers, dataRows);
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      res.setHeader("Content-Disposition", "attachment; filename=proof-of-play.xlsx");
      res.send(buffer);
      return;
    }

    if (format === "pdf") {
      const buffer = await renderPdf("Proof of Play", headers, dataRows);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", "attachment; filename=proof-of-play.pdf");
      res.send(buffer);
      return;
    }

    const header = "Device,Content,Started,Ended,Duration (sec),Completed\n";
    const csv =
      header +
      dataRows
        .map(([device, content, started, ended, duration, completed]) => {
          return `"${device}","${content}","${started}","${ended}",${duration},${completed}`;
        })
        .join("\n");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=proof-of-play.csv",
    );
    res.send(csv);
  }),
);

// Device uptime report. Phase 2.2g: workspace-scoped. Previously this route
// had no scope filter at all - any authenticated user could see telemetry
// summaries for every device on the platform. The added WHERE clause closes
// that pre-existing cross-tenant leak.
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

    // Estimate uptime: heartbeats are every 15s, so heartbeat_count * 15 / total_period
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
