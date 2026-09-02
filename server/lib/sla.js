'use strict';

// SLA helpers shared by the workspace-level SLA views (routes/dashboard-reports.js)
// and the org/region-level rollup (routes/organizations.js). Extracted so the
// device_usage_daily uptime calculation and the platform SLA target live in ONE
// place — the region rollup must produce numbers that agree with the per-device
// SLA overview.

const appSettings = require('./app-settings');
const config = require('../config');

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

// The platform-wide uptime target (%). Admin-toggleable app_settings value wins,
// else the config.js env default. Same read the SLA overview endpoint uses.
function slaUptimeTarget() {
  return appSettings.getNum('sla_uptime_target_pct', config.slaUptimeTargetPct);
}

// Per-device availability over [startDate, endDate] ('YYYY-MM-DD' inclusive),
// off the device_usage_daily billing rollup. `scope` narrows which devices are
// included: { sql, params } in the shape lib/workspace-scope.js produces, e.g.
//   { sql: " AND device_id IN (SELECT id FROM devices WHERE workspace_id = ?)", params: [wsId] }
// `* 100.0` forces floating-point division on every SQL engine (SQLite included).
// Returns [{ device_id, total_online_seconds, days_counted, avg_availability_pct }].
async function deviceAvailabilityRows(dbh, { startDate, endDate, scope = { sql: '', params: [] } }) {
  return dbh
    .prepare(
      `SELECT
         device_id,
         SUM(online_seconds) AS total_online_seconds,
         COUNT(*) AS days_counted,
         ROUND(SUM(online_seconds) * 100.0 / (COUNT(*) * 86400), 1) AS avg_availability_pct
       FROM device_usage_daily
       WHERE day BETWEEN ? AND ?${scope.sql}
       GROUP BY device_id`,
    )
    .all(startDate, endDate, ...scope.params);
}

// Mean of the per-device availability percentages, EXCLUDING devices with no
// usage data in the window (avg_availability_pct === null) — matching how the
// dashboard "Fleet uptime" tile aggregates. Returns { avgPct, devicesWithData }.
function meanAvailability(rows) {
  const vals = rows
    .map((r) => (r.avg_availability_pct == null ? null : Number(r.avg_availability_pct)))
    .filter((v) => v != null && Number.isFinite(v));
  if (!vals.length) return { avgPct: null, devicesWithData: 0 };
  return {
    avgPct: Math.round((vals.reduce((a, v) => a + v, 0) / vals.length) * 10) / 10,
    devicesWithData: vals.length,
  };
}

// Compliant / Breach / Unknown for a measured uptime vs the platform target.
function slaStatus(avgPct, target = slaUptimeTarget()) {
  if (avgPct == null) return 'unknown';
  return avgPct >= target ? 'compliant' : 'breach';
}

module.exports = { isoDate, slaUptimeTarget, deviceAvailabilityRows, meanAvailability, slaStatus };
