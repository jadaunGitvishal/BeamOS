const express = require("express");
const router = express.Router();
const { db } = require("../db/database");
const { asyncHandler } = require("../lib/async-handler");
const { getWorkspaceDeviceSubquery } = require("../lib/workspace-scope");
const { isOrgWideRole } = require("../lib/tenancy");
const { toCsvRow } = require("../lib/csv");
const { renderXlsx, renderPdf } = require("../lib/report-export");
const { buildSlaOverview } = require("../lib/sla-overview");

// GET /api/dashboard/overview?start=&end=
// Bundles blueprint widgets 1.1-1.4 into one round trip (Performance
// Checklist item 3: "bundle small independent aggregates into one response"),
// plus a 1.5 org block gated to platform-admin / org-owner / org-admin.
// Merged in from BeamOS-Dashboard's routes/dashboard.js.
// Computed in buildOverview() so GET /export reports the exact same numbers.
async function buildOverview(req) {
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

  return overview;
}

router.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await buildOverview(req));
  }),
);

// GET /api/dashboard/overview/export?format=csv|xlsx|pdf&start=YYYY-MM-DD
// The Overview page's headline numbers as a two-column (Metric, Value) report.
// Same output shapes as dashboard-devices.js's /export. Every figure comes
// from the logic the page itself reads:
//   - fleet / completion: buildOverview() (this router's GET /)
//   - fleet uptime vs target: lib/sla-overview.js buildSlaOverview() (GET
//     /api/dashboard/reports/sla-overview), averaged the way OverviewView does
//     (plain mean of per-device availability_pct, devices with no data skipped)
//   - open tickets: open + in_progress, as rankOpenTickets / sla-summary count
//   - open issues: distinct error fingerprints in the period, the grouping
//     GET /api/dashboard/issues uses - platform-admin only, same as that route
// `start` must be date-only (buildSlaOverview appends a UTC time to it).
function fmtPct(v) {
  return v === null || v === undefined ? "" : `${Number(v).toFixed(1)}%`;
}

router.get(
  "/export",
  asyncHandler(async (req, res) => {
    const overview = await buildOverview(req);

    const sla = await buildSlaOverview(db, req);
    const uptimeVals = (sla.devices || [])
      .filter((d) => d.availability_pct != null)
      .map((d) => Number(d.availability_pct))
      .filter((v) => Number.isFinite(v));
    const fleetUptime = uptimeVals.length ? uptimeVals.reduce((a, v) => a + v, 0) / uptimeVals.length : null;
    const target = sla.target?.uptime_target_pct ?? null;

    const tickets = req.workspaceId
      ? await db
          .prepare("SELECT COUNT(*) AS n FROM tickets WHERE workspace_id = ? AND status IN ('open', 'in_progress')")
          .get(req.workspaceId)
      : { n: 0 };

    let openIssues = null;
    if (req.isPlatformAdmin) {
      const startEpoch = Math.floor(new Date(overview.period.start).getTime() / 1000);
      const endEpoch = Math.floor(new Date(overview.period.end).getTime() / 1000);
      const row = await db
        .prepare(
          `SELECT COUNT(DISTINCT error_fingerprint) AS n FROM player_debug_logs
           WHERE error_fingerprint IS NOT NULL AND created_at >= ? AND created_at <= ?`,
        )
        .get(startEpoch, endEpoch);
      openIssues = row.n || 0;
    }

    const headers = ["Metric", "Value"];
    const rows = [
      ["Period start (UTC)", overview.period.start.slice(0, 10)],
      ["Period end (UTC)", overview.period.end.slice(0, 10)],
      ["Total devices", overview.total_devices],
      ["Online", overview.online],
      ["Offline", overview.offline],
      ["Total plays", overview.total_plays],
      ["Completed plays", overview.completed_plays],
      ["Play completion", fmtPct(overview.completion_pct)],
      ["Fleet uptime (SLA)", fmtPct(fleetUptime)],
      ["Uptime target", fmtPct(target)],
      ["Devices with uptime data", uptimeVals.length],
      ["Open tickets", tickets.n || 0],
      ["Open issues", openIssues === null ? "platform admin only" : openIssues],
    ];

    const format = ["csv", "xlsx", "pdf"].includes(req.query.format) ? req.query.format : "csv";
    const date = new Date().toISOString().slice(0, 10);

    if (format === "xlsx") {
      const buffer = await renderXlsx("Overview", headers, rows);
      res.set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.set("Content-Disposition", `attachment; filename="overview-${date}.xlsx"`);
      res.send(buffer);
      return;
    }

    if (format === "pdf") {
      const buffer = await renderPdf(
        "Overview",
        headers,
        rows.map(([k, v]) => [k, v === "" ? "—" : v]),
      );
      res.set("Content-Type", "application/pdf");
      res.set("Content-Disposition", `attachment; filename="overview-${date}.pdf"`);
      res.send(buffer);
      return;
    }

    const header = toCsvRow(headers);
    const csvRows = rows.map((row) => toCsvRow(row));
    res.set("Content-Type", "text/csv; charset=utf-8");
    res.set("Content-Disposition", `attachment; filename="overview-${date}.csv"`);
    res.send("﻿" + [header, ...csvRows].join("\r\n"));
  }),
);

module.exports = router;
