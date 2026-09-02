const express = require("express");
const router = express.Router();
const { db } = require("../db/database");
const { asyncHandler } = require("../lib/async-handler");
const {
  getWorkspaceDeviceFilter,
  getWorkspaceDeviceSubquery,
} = require("../lib/workspace-scope");
const appSettings = require("../lib/app-settings");
const config = require("../config");
const { detectOutages } = require("../lib/outage-detection");

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

// GET /api/dashboard/reports/sla-overview?start=YYYY-MM-DD&end=YYYY-MM-DD
// Ref 51 (SLA Dashboard) — backend only, no UI yet. Combines three things
// into one workspace-scoped payload:
//
//   1. Uptime % per device (same rollup query as GET /availability, off
//      device_usage_daily) compared against the platform SLA target ->
//      Compliant / Breach / Unknown (no usage rows in range).
//
//   2. MTTR per device: the mean duration of COMPLETED outages in the period,
//      read from the durable outage_history table (Stage 2). outage_history is
//      accrued by services/outage-history.js off the SAME shared LAG/LEAD
//      detector this endpoint uses for (3); reading MTTR from the rollup rather
//      than from device_status_log directly is what lifts the old ~3-day cap
//      (status-log retention) — exactly how device_usage_daily lifts it for
//      uptime %.
//
//   3. Live breaches: devices currently in an outage that has already lasted
//      longer than the escalation threshold. Read LIVE from device_status_log
//      via lib/outage-detection.js — never limited by retention, because an
//      ongoing outage's transition rows are by definition recent. "Currently"
//      and the threshold clock are always evaluated as of NOW, independent of
//      start/end (which only bound the uptime % and the completed-outage MTTR).
//
// SLA targets are PLATFORM-WIDE (app_settings, admin-toggleable), not
// per-workspace. RBAC: workspace-scoped exactly like every sibling dashboard
// route - resolveTenancy sets req.workspaceId and every query filters on it;
// no workspace -> empty payload.
//
// Warm-up note: on a brand-new deploy outage_history is empty until the first
// recorder sweep (which startOutageHistoryRecorder kicks within seconds of
// boot), so MTTR can briefly read null / 0 completed outages. Self-heals.
router.get(
  "/sla-overview",
  asyncHandler(async (req, res) => {
    const target = appSettings.getNum(
      "sla_uptime_target_pct",
      config.slaUptimeTargetPct,
    );
    const thresholdHours = appSettings.getNum(
      "sla_escalation_threshold_hours",
      config.slaEscalationThresholdHours,
    );
    const thresholdSeconds = thresholdHours * 3600;

    const startDate =
      req.query.start || isoDate(new Date(Date.now() - 30 * 86400000));
    const endDate = req.query.end || isoDate(new Date());
    const startEpoch = Math.floor(new Date(startDate + "T00:00:00Z").getTime() / 1000);
    const endEpoch = Math.floor(new Date(endDate + "T23:59:59Z").getTime() / 1000);
    const nowEpoch = Math.floor(Date.now() / 1000);

    if (!req.workspaceId) {
      return res.json({
        target: {
          uptime_target_pct: target,
          escalation_threshold_hours: thresholdHours,
        },
        period: { start: startDate, end: endDate },
        devices: [],
        summary: {
          devices_total: 0,
          devices_compliant: 0,
          devices_breach: 0,
          devices_unknown: 0,
          live_breaches: 0,
        },
      });
    }

    // --- devices in scope --------------------------------------------------
    const devices = await db
      .prepare(
        "SELECT id, name FROM devices WHERE workspace_id = ? ORDER BY sort_order ASC, created_at ASC",
      )
      .all(req.workspaceId);

    // --- 1. uptime % (same query as GET /availability) --------------------
    const wsScope = getWorkspaceDeviceSubquery(req);
    const availRows = await db
      .prepare(
        `
      SELECT
        device_id,
        SUM(online_seconds) AS total_online_seconds,
        COUNT(*) AS days_counted,
        ROUND(SUM(online_seconds) * 100.0 / (COUNT(*) * 86400), 1) AS avg_availability_pct
      FROM device_usage_daily
      WHERE day BETWEEN ? AND ?${wsScope.sql}
      GROUP BY device_id
    `,
      )
      .all(startDate, endDate, ...wsScope.params);
    // (mirrors GET /availability; * 100.0 keeps the division floating-point on
    // every SQL engine, not just MySQL.)
    const availByDevice = new Map(availRows.map((r) => [r.device_id, r]));

    // --- 2. completed outages / MTTR — from the durable rollup ------------
    // outage_history is not subject to the 3-day device_status_log prune, so
    // `start` can reach back arbitrarily far.
    const historyRows = await db
      .prepare(
        `
      SELECT device_id,
        COUNT(*) AS completed_outages,
        AVG(duration_seconds) AS avg_duration_seconds
      FROM outage_history
      WHERE workspace_id = ? AND started_at BETWEEN ? AND ?
      GROUP BY device_id
    `,
      )
      .all(req.workspaceId, startEpoch, endEpoch);
    const historyByDevice = new Map(historyRows.map((r) => [r.device_id, r]));

    // --- 3. ongoing outages / live breaches — real-time --------------------
    // Straight off device_status_log via the shared detector. Only a recent
    // window is needed (an ongoing outage's rows are recent by definition);
    // scan the retention horizon so we never miss one.
    const liveLookbackSec = Math.round(config.statusLogRetentionDays * 86400);
    const liveOutages = await detectOutages(db, {
      sinceEpoch: nowEpoch - liveLookbackSec,
      untilEpoch: nowEpoch,
      workspaceId: req.workspaceId,
    });
    const ongoingSinceByDevice = new Map();
    for (const o of liveOutages) {
      if (o.outage_end != null) continue; // completed — counted via outage_history above
      const prev = ongoingSinceByDevice.get(o.device_id);
      if (prev == null || o.outage_start < prev) {
        ongoingSinceByDevice.set(o.device_id, o.outage_start);
      }
    }

    // --- assemble ------------------------------------------------------------
    let compliant = 0;
    let breach = 0;
    let unknown = 0;
    let liveBreaches = 0;

    const deviceReports = devices.map((d) => {
      const a = availByDevice.get(d.id);
      const availabilityPct =
        a && a.avg_availability_pct != null ? Number(a.avg_availability_pct) : null;

      let slaStatus;
      if (availabilityPct == null) {
        slaStatus = "unknown";
        unknown++;
      } else if (availabilityPct >= target) {
        slaStatus = "compliant";
        compliant++;
      } else {
        slaStatus = "breach";
        breach++;
      }

      const h = historyByDevice.get(d.id);
      const completedOutages = h ? Number(h.completed_outages) : 0;
      const mttrSeconds =
        h && h.avg_duration_seconds != null
          ? Math.round(Number(h.avg_duration_seconds))
          : null;

      const ongoingSince = ongoingSinceByDevice.get(d.id) ?? null;
      const ongoingOutageSeconds =
        ongoingSince != null ? nowEpoch - ongoingSince : null;
      const liveBreach =
        ongoingOutageSeconds != null && ongoingOutageSeconds > thresholdSeconds;
      if (liveBreach) liveBreaches++;

      return {
        device_id: d.id,
        device_name: d.name,
        availability_pct: availabilityPct,
        days_counted: a ? a.days_counted : 0,
        sla_status: slaStatus,
        mttr_seconds: mttrSeconds,
        completed_outages: completedOutages,
        ongoing_outage_seconds: ongoingOutageSeconds,
        live_breach: liveBreach,
      };
    });

    res.json({
      target: {
        uptime_target_pct: target,
        escalation_threshold_hours: thresholdHours,
      },
      period: { start: startDate, end: endDate },
      devices: deviceReports,
      summary: {
        devices_total: deviceReports.length,
        devices_compliant: compliant,
        devices_breach: breach,
        devices_unknown: unknown,
        live_breaches: liveBreaches,
      },
    });
  }),
);

// GET /api/dashboard/reports/sla-trend?days=N  (default 30, clamped 1..365)
// Ref 51 Step 4 — fleet-wide uptime trend for the Overview SLA section. One
// point per UTC day: the mean across this workspace's devices of that day's
// online-seconds as a percentage of the whole day. Same device_usage_daily
// rollup + workspace scoping (getWorkspaceDeviceSubquery) as GET /availability;
// * 100.0 keeps the division floating-point on every SQL engine. Returns
// [{ day: 'YYYY-MM-DD', avg_uptime_pct: number }] ordered oldest-first (days
// with no usage rows are simply absent — the client draws a continuous line
// through the points it has).
router.get(
  "/sla-trend",
  asyncHandler(async (req, res) => {
    let days = parseInt(req.query.days, 10);
    if (!Number.isFinite(days) || days < 1) days = 30;
    if (days > 365) days = 365;

    const startDate = isoDate(new Date(Date.now() - (days - 1) * 86400000));
    const endDate = isoDate(new Date());

    const wsScope = getWorkspaceDeviceSubquery(req);
    const rows = await db
      .prepare(
        `
      SELECT day, ROUND(AVG(online_seconds * 100.0 / 86400), 1) AS avg_uptime_pct
      FROM device_usage_daily
      WHERE day BETWEEN ? AND ?${wsScope.sql}
      GROUP BY day
      ORDER BY day
    `,
      )
      .all(startDate, endDate, ...wsScope.params);

    res.json(rows);
  }),
);

module.exports = router;
