const express = require("express");
const router = express.Router();
const { db } = require('../db/database');
const { asyncHandler } = require('../lib/async-handler');
const {
  getWorkspaceDeviceFilter,
  getWorkspaceDeviceSubquery,
} = require('../lib/workspace-scope');
const { renderCsv, renderXlsx, renderPdf } = require('../lib/report-export');
const { getProofOfPlaySummary } = require('../lib/proof-of-play');
const { publicFieldList, DOMAIN_LABELS } = require('../lib/report-fields');
const { buildCustomReportQuery, ReportQueryError } = require('../lib/report-query-builder');

// Ref 74 Stage 1: the custom-report field catalog. Frontend-safe shape only
// (id/label/domain/type) - never the internal SQL column expression, which
// lib/report-fields.js keeps server-side.
router.get(
  '/custom/fields',
  asyncHandler(async (req, res) => {
    res.json({ domains: DOMAIN_LABELS, fields: publicFieldList() });
  }),
);

const CUSTOM_PREVIEW_ROW_LIMIT = 20;

// Ref 74 Stage 2: runs a user's { fields, filters, dateRange } selection
// through the safe query builder and returns a small preview. Same
// workspace-scoping and field/operator validation as the full export
// (Stage 3) - this is the exact query export will run, just LIMIT 20.
router.post(
  '/custom/preview',
  asyncHandler(async (req, res) => {
    let query;
    try {
      query = buildCustomReportQuery(req.body, req, { limit: CUSTOM_PREVIEW_ROW_LIMIT });
    } catch (e) {
      if (e instanceof ReportQueryError) return res.status(400).json({ error: e.message });
      throw e;
    }
    const rows = await db.prepare(query.sql).all(...query.params);
    res.json({
      columns: query.headers,
      fieldIds: query.fieldIds,
      rows: rows.map((r) => query.fieldIds.map((id) => r[id])),
    });
  }),
);

// Ref 74 Stage 3: same safety-checked query as preview, uncapped-in-shape but
// row-capped for real export, run through the SAME renderCsv/renderXlsx/renderPdf
// the rest of the reporting surface uses (report-export.js) - no format-specific
// code path of its own.
const CUSTOM_EXPORT_ROW_CAP = 5000; // matches the cap other list exports use (docs/data-export.md)

router.post(
  '/custom/export',
  asyncHandler(async (req, res) => {
    const { format } = req.body || {};
    const safeFormat = ['csv', 'xlsx', 'pdf', 'json'].includes(format) ? format : 'csv';

    let query;
    try {
      query = buildCustomReportQuery(req.body, req, { limit: CUSTOM_EXPORT_ROW_CAP });
    } catch (e) {
      if (e instanceof ReportQueryError) return res.status(400).json({ error: e.message });
      throw e;
    }
    const rows = await db.prepare(query.sql).all(...query.params);
    const dataRows = rows.map((r) => query.fieldIds.map((id) => r[id]));

    if (safeFormat === 'json') {
      res.json({ columns: query.headers, rows: dataRows });
      return;
    }
    if (safeFormat === 'xlsx') {
      const buffer = await renderXlsx('Custom Report', query.headers, dataRows);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename=custom-report.xlsx');
      res.send(buffer);
      return;
    }
    if (safeFormat === 'pdf') {
      const buffer = await renderPdf('Custom Report', query.headers, dataRows);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename=custom-report.pdf');
      res.send(buffer);
      return;
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=custom-report.csv');
    res.send(renderCsv(query.headers, dataRows));
  }),
);

// Ref 73: page-size ceiling shared by /plays and /export - a BI tool paging
// through a large historical range gets capped requests either way, matching
// the cap other list exports use elsewhere (docs/data-export.md).
const PROOF_OF_PLAY_PAGE_CAP = 5000;

// Query play logs
router.get(
  "/plays",
  asyncHandler(async (req, res) => {
    const { device_id, content_id, start, end, limit: lim, offset: off } = req.query;
    const scope = getWorkspaceDeviceFilter(req);
    let whereSql = `WHERE 1=1${scope.sql}`;
    const whereParams = [...scope.params];

    if (device_id) {
      whereSql += " AND pl.device_id = ?";
      whereParams.push(device_id);
    }
    if (content_id) {
      whereSql += " AND pl.content_id = ?";
      whereParams.push(content_id);
    }
    if (start) {
      whereSql += " AND pl.started_at >= ?";
      whereParams.push(Math.floor(new Date(start).getTime() / 1000));
    }
    if (end) {
      whereSql += " AND pl.started_at <= ?";
      whereParams.push(Math.floor(new Date(end).getTime() / 1000));
    }

    // Ref 73: limit's default (500) and behavior when omitted are unchanged;
    // offset is new (defaults to 0, also unchanged behavior). Both are now
    // capped so a caller can't request an unbounded page.
    const limit = Math.min(parseInt(lim) || 500, PROOF_OF_PLAY_PAGE_CAP);
    const offset = Math.max(parseInt(off) || 0, 0);

    const total = (
      await db
        .prepare(`SELECT COUNT(*) AS n FROM play_logs pl JOIN devices d ON pl.device_id = d.id ${whereSql}`)
        .get(...whereParams)
    ).n;

    const rows = await db
      .prepare(
        `SELECT pl.*, d.name as device_name FROM play_logs pl JOIN devices d ON pl.device_id = d.id ${whereSql} ORDER BY pl.started_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...whereParams, limit, offset);

    // X-Total-Count lets a paging caller know when it has everything, without
    // changing the documented response body (still a bare array - see
    // docs/openapi.yaml's /reports/plays).
    res.setHeader("X-Total-Count", String(total));
    res.json(rows);
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
    const { device_id, start, end, limit: lim, offset: off } = req.query;
    const startEpoch = start ? Math.floor(new Date(start).getTime() / 1000) : 0;
    const endEpoch = end
      ? Math.floor(new Date(end + "T23:59:59").getTime() / 1000)
      : Math.floor(Date.now() / 1000);

    const scope = getWorkspaceDeviceFilter(req);
    let whereSql = `WHERE pl.started_at >= ? AND pl.started_at <= ?${scope.sql}`;
    const whereParams = [startEpoch, endEpoch, ...scope.params];
    if (device_id) {
      whereSql += " AND pl.device_id = ?";
      whereParams.push(device_id);
    }

    // Ref 73: pagination is OPT-IN via limit/offset. Omitting BOTH (as the
    // desktop Reports page's CSV/XLSX/PDF download always does -
    // frontend/js/views/reports.js never sends either) preserves the exact
    // pre-existing behavior: every row in the date range, unbounded. A caller
    // that sends either one (e.g. a BI tool paging JSON) gets a capped page.
    const paginated = lim !== undefined || off !== undefined;
    const limit = paginated ? Math.min(parseInt(lim) || PROOF_OF_PLAY_PAGE_CAP, PROOF_OF_PLAY_PAGE_CAP) : null;
    const offset = paginated ? Math.max(parseInt(off) || 0, 0) : 0;

    const total = (
      await db
        .prepare(`SELECT COUNT(*) AS n FROM play_logs pl JOIN devices d ON pl.device_id = d.id ${whereSql}`)
        .get(...whereParams)
    ).n;

    let sql = `SELECT pl.*, d.name as device_name FROM play_logs pl JOIN devices d ON pl.device_id = d.id ${whereSql} ORDER BY pl.started_at ASC`;
    const params = [...whereParams];
    if (paginated) {
      sql += " LIMIT ? OFFSET ?";
      params.push(limit, offset);
    }

    const rows = await db.prepare(sql).all(...params);
    // Same additive header as /plays - present regardless of format, since
    // headers are independent of the CSV/XLSX/PDF/JSON body.
    res.setHeader("X-Total-Count", String(total));

    const format = ["csv", "xlsx", "pdf", "json"].includes(req.query.format)
      ? req.query.format
      : "csv";

    const headers = ["Device", "Content", "Started", "Ended", "Duration (sec)", "Completed"];
    const dataRows = rows.map((r) => {
      const started = new Date(r.started_at * 1000).toISOString();
      const ended = r.ended_at ? new Date(r.ended_at * 1000).toISOString() : "";
      return [r.device_name, r.content_name, started, ended, r.duration_sec || "", r.completed ? "Yes" : "No"];
    });

    if (format === "json") {
      // total/limit/offset are additive fields alongside the existing
      // columns/rows contract (docs/data-export.md) - an existing consumer
      // reading only .columns/.rows is unaffected.
      res.json({ columns: headers, rows: dataRows, total, limit, offset });
      return;
    }

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
