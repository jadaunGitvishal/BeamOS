const express = require("express");
const router = express.Router();
const { db } = require("../db/database");
const { asyncHandler } = require("../lib/async-handler");
const {
  getWorkspaceDeviceFilter,
  getWorkspaceDeviceSubquery,
} = require("../lib/workspace-scope");
const config = require("../config");
const { deviceAvailabilityRows } = require("../lib/sla");
const { buildSlaOverview, buildSlaTrend } = require("../lib/sla-overview");
const { getReconciliation } = require("../lib/reconciliation");
const reconReport = require("../services/reconciliation-report");
const { getPendingInstallations } = require("../lib/pending-installations");
const pendingReport = require("../services/pending-installation-report");

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

    const rows = await deviceAvailabilityRows(db, {
      startDate,
      endDate,
      scope: getWorkspaceDeviceSubquery(req),
    });
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

// GET /api/dashboard/reports/sla-overview?start=YYYY-MM-DD&end=YYYY-MM-DD
// Ref 51 (SLA Dashboard) — backend only, no UI yet. Query logic lives in
// lib/sla-overview.js's buildSlaOverview() (Ref 73 extraction, so it's
// callable without going through Express); see that module for the full
// breakdown of what this combines (uptime %, MTTR, live breaches) and the
// RBAC / warm-up notes.
router.get(
  "/sla-overview",
  asyncHandler(async (req, res) => {
    res.json(await buildSlaOverview(db, req));
  }),
);

// GET /api/dashboard/reports/sla-trend?days=N  (default 30, clamped 1..365)
// Ref 51 Step 4 — fleet-wide uptime trend for the Overview SLA section.
// Query logic lives in lib/sla-overview.js's buildSlaTrend() (Ref 73
// extraction); see that module for the full shape/ordering notes.
router.get(
  "/sla-trend",
  asyncHandler(async (req, res) => {
    res.json(await buildSlaTrend(db, req));
  }),
);

// GET /api/dashboard/reports/reconciliation
// Ref 49 Stage B — the LIVE, on-demand version of the scheduled reconciliation
// report (services/reconciliation-report.js). Runs the same lib/reconciliation.js
// query against the caller's workspace right now, so the dashboard reflects the
// current state on page load rather than whatever the last email captured.
//
// RBAC: workspace-scoped like every sibling route here — resolveTenancy sets
// req.workspaceId; no workspace -> empty payload. Read-only, any workspace
// member (a viewer can already see the device list this derives from).
//
// `frequency_days` / `last_report_date` / `next_report_date` come from
// getReportStatus() so the view can show when the next email fires; changing
// the cadence is a separate platform-admin action (PUT /api/admin/reconciliation-frequency).
router.get(
  "/reconciliation",
  asyncHandler(async (req, res) => {
    const status = await reconReport.getReportStatus(db);

    if (!req.workspaceId) {
      return res.json({
        generated_at: Math.floor(Date.now() / 1000),
        stale_after_days: config.reconciliationStaleAfterDays,
        device_count: 0,
        frequency_days: status.frequency_days,
        last_report_date: status.last_report_date,
        next_report_date: status.next_report_date,
        overdue: status.overdue,
        counts: { ghost: 0, stale: 0, total: 0 },
        ghosts: [],
        stale: [],
      });
    }

    const recon = await getReconciliation(db, { workspaceId: req.workspaceId });
    const dc = await db
      .prepare("SELECT COUNT(*) AS c FROM devices WHERE workspace_id = ? AND blocked = 0")
      .get(req.workspaceId);

    res.json({
      generated_at: recon.generated_at,
      stale_after_days: recon.stale_after_days,
      device_count: Number(dc?.c || 0),
      frequency_days: status.frequency_days,
      last_report_date: status.last_report_date,
      next_report_date: status.next_report_date,
      overdue: status.overdue,
      counts: {
        ghost: recon.ghosts.length,
        stale: recon.stale.length,
        total: recon.ghosts.length + recon.stale.length,
      },
      ghosts: recon.ghosts,
      stale: recon.stale,
    });
  }),
);

// GET /api/dashboard/reports/pending-installations
// Ref 48 Stage B — the LIVE, on-demand version of the scheduled pending-
// installation report (services/pending-installation-report.js). Runs the same
// lib/pending-installations.js query against the caller's workspace right now,
// so the dashboard reflects the current state on page load rather than whatever
// the last email captured.
//
// RBAC: workspace-scoped exactly like the reconciliation sibling above —
// resolveTenancy sets req.workspaceId; no workspace -> empty payload. Read-only,
// any workspace member (a workspace_admin already sees the registration_codes
// list this derives from, and a viewer can be told an install is stuck).
//
// `code_count` is every registration_codes row for the workspace, any status —
// it's the signal the UI uses to tell "this workspace provisions devices some
// other way" (0 -> hide the Overview teaser) apart from "every code this
// workspace cut has been activated" (>0 with nothing flagged -> an "all clear"
// worth confirming). See the empty-state note in OverviewView / the view.
router.get(
  "/pending-installations",
  asyncHandler(async (req, res) => {
    const status = await pendingReport.getReportStatus(db);

    if (!req.workspaceId) {
      return res.json({
        generated_at: Math.floor(Date.now() / 1000),
        grace_days: config.pendingInstallationGraceDays,
        code_count: 0,
        frequency_days: status.frequency_days,
        last_report_date: status.last_report_date,
        next_report_date: status.next_report_date,
        overdue: status.overdue,
        counts: { pending: 0, abandoned: 0, total: 0 },
        pending: [],
        abandoned: [],
      });
    }

    const data = await getPendingInstallations(db, { workspaceId: req.workspaceId });
    const cc = await db
      .prepare("SELECT COUNT(*) AS c FROM registration_codes WHERE workspace_id = ?")
      .get(req.workspaceId);

    res.json({
      generated_at: data.generated_at,
      grace_days: data.grace_days,
      code_count: Number(cc?.c || 0),
      frequency_days: status.frequency_days,
      last_report_date: status.last_report_date,
      next_report_date: status.next_report_date,
      overdue: status.overdue,
      counts: {
        pending: data.pending.length,
        abandoned: data.abandoned.length,
        total: data.pending.length + data.abandoned.length,
      },
      pending: data.pending,
      abandoned: data.abandoned,
    });
  }),
);

module.exports = router;
