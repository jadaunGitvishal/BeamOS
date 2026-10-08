'use strict';

// PMI Ref 66 (shared with Ref 71): screen runtime / uptime for a set of screens over
// one UTC period, from the device_usage_daily accrual (online seconds per device per
// UTC day, UPSERTed by services/heartbeat.js).
//
// Two pieces, kept apart so callers can test and reuse them independently:
//
//   summarizeRuntime(input)   PURE. No DB, no clock. Given screens + usage rows + a
//                             period, returns per-screen, per-workspace and overall
//                             figures. This is the single source of truth for the
//                             zero-runtime rule below.
//
//   loadRuntimeInputs(db, …)  Loads exactly the rows summarizeRuntime needs for ONE
//                             organisation and an EXPLICIT workspace id list. Every
//                             query is constrained by both workspaces.organization_id
//                             and the workspace ids, so an id from another org (or a
//                             stale list) can never pull a foreign screen in. It does
//                             NOT decide which workspaces a person may see: the caller
//                             resolves that (for Ref 66, from the recipient's current
//                             regional scopes at send time).
//
//   getRuntimeSummary(db, …)  load + summarize in one call.
//
// ZERO-RUNTIME (the definition; change it here and nowhere else):
//   A screen is zero-runtime for a period when ALL of these hold:
//     - it was registered (devices.created_at, the first-paired time) at or before the
//       period start, i.e. it existed for the whole period;
//     - it is not blocked (devices.blocked = 0);
//     - it has 0 online seconds in the period.
//   Screens registered DURING the period are "new": they are excluded from both the
//   zero-runtime numerator and its denominator, and their uptime % uses the time from
//   registration to the period end as the denominator (not the whole period).
//   Blocked screens are excluded from every figure. Screens registered at or after the
//   period end did not exist yet and are excluded too.
//
// What counts as a screen: a device row in one of the given workspaces (so unpaired
// devices with no workspace are out by construction) that is not still in
// status 'provisioning' (an imported device waiting to be re-paired).
//
// Figures:
//   uptime %       = online seconds / seconds the screen existed in the period, x100,
//                    capped at 100 (accrual is per whole UTC day, so on the
//                    registration day it can slightly exceed the time since pairing).
//   average uptime = time-weighted: total online seconds / total seconds the screens
//                    existed in the period (so a new screen counts for its share only,
//                    and zero-runtime screens pull the average down).
//   runtime hours, uptime % and zero-runtime % are rounded half-up to 1 decimal.
//
// Periods are half-open epoch-second ranges [startEpoch, endEpoch) and are UTC. The
// usage table is keyed by UTC day ('YYYY-MM-DD'), so a period should start and end on
// a UTC midnight; usage rows are matched by day between the first day of the period
// and the day before endEpoch.

const DAY = 86400;

// The screen-eligibility pieces of the rule above, exported so other reports (Ref 68
// field operations: lib/field-ops-summary.js) reuse them instead of restating them:
// a device still in this status is not a screen yet, and a blocked screen is excluded
// from every figure.
const NOT_A_SCREEN_STATUS = 'provisioning';
function isBlockedScreen(sc) {
  return Number(sc.blocked) === 1 || sc.blocked === true;
}

function round1(x) {
  return Math.round((x + Number.EPSILON) * 10) / 10;
}

function utcDay(epochSec) {
  return new Date(epochSec * 1000).toISOString().slice(0, 10);
}

// Inclusive UTC day bounds ('YYYY-MM-DD') for a half-open epoch period.
function periodDays(startEpoch, endEpoch) {
  return { firstDay: utcDay(startEpoch), lastDay: utcDay(endEpoch - 1) };
}

function pct(num, den) {
  return den > 0 ? round1((num / den) * 100) : null;
}

// input:
//   screens:    [{ id, name, workspace_id, registered_at (epoch s), blocked (0/1/bool) }]
//   usage:      [{ device_id, day: 'YYYY-MM-DD', online_seconds }]
//   workspaces: optional [{ id, name }] - totals are produced for every workspace
//               listed here (even with no screens) plus any a screen refers to.
//   startEpoch, endEpoch: the half-open UTC period.
//
// Returns:
//   {
//     period: { start_epoch, end_epoch, first_day, last_day, seconds },
//     screens: [{ id, name, workspace_id, registered_at, is_new, available_seconds,
//                 runtime_seconds, runtime_hours, uptime_pct, zero_runtime }],
//     workspaces: [{ workspace_id, name, ...totals }],
//     overall: totals,
//     excluded: { blocked, not_yet_registered },
//   }
//   totals = { screens, new_screens, runtime_seconds, runtime_hours, available_seconds,
//              avg_uptime_pct, zero_runtime_count, zero_runtime_eligible, zero_runtime_pct }
//   avg_uptime_pct / zero_runtime_pct are null when their denominator is 0.
function summarizeRuntime({ screens = [], usage = [], workspaces = [], startEpoch, endEpoch }) {
  if (!Number.isFinite(startEpoch) || !Number.isFinite(endEpoch) || endEpoch <= startEpoch) {
    throw new Error('summarizeRuntime needs a period with startEpoch < endEpoch');
  }
  const { firstDay, lastDay } = periodDays(startEpoch, endEpoch);

  const secondsByDevice = new Map();
  for (const u of usage) {
    if (!u || u.day < firstDay || u.day > lastDay) continue;
    const s = Number(u.online_seconds) || 0;
    if (s <= 0) continue;
    secondsByDevice.set(u.device_id, (secondsByDevice.get(u.device_id) || 0) + s);
  }

  const excluded = { blocked: 0, not_yet_registered: 0 };
  const outScreens = [];
  for (const sc of screens) {
    if (isBlockedScreen(sc)) {
      excluded.blocked++;
      continue;
    }
    const registered = Number(sc.registered_at) || 0;
    if (registered >= endEpoch) {
      excluded.not_yet_registered++;
      continue;
    }
    const isNew = registered > startEpoch;
    const available = endEpoch - (isNew ? registered : startEpoch);
    const runtime = secondsByDevice.get(sc.id) || 0;
    outScreens.push({
      id: sc.id,
      name: sc.name,
      workspace_id: sc.workspace_id,
      registered_at: registered,
      is_new: isNew,
      available_seconds: available,
      runtime_seconds: runtime,
      runtime_hours: round1(runtime / 3600),
      uptime_pct: Math.min(100, pct(runtime, available)),
      zero_runtime: !isNew && runtime === 0,
    });
  }

  const blank = () => ({ screens: 0, new_screens: 0, runtime_seconds: 0, available_seconds: 0, zero_runtime_count: 0, zero_runtime_eligible: 0 });
  const add = (t, s) => {
    t.screens++;
    if (s.is_new) t.new_screens++;
    else t.zero_runtime_eligible++;
    if (s.zero_runtime) t.zero_runtime_count++;
    t.runtime_seconds += s.runtime_seconds;
    t.available_seconds += s.available_seconds;
  };
  const finish = (t) => ({
    ...t,
    runtime_hours: round1(t.runtime_seconds / 3600),
    avg_uptime_pct: t.available_seconds > 0 ? Math.min(100, pct(t.runtime_seconds, t.available_seconds)) : null,
    zero_runtime_pct: pct(t.zero_runtime_count, t.zero_runtime_eligible),
  });

  const wsTotals = new Map();
  const wsNames = new Map();
  for (const w of workspaces) {
    wsNames.set(w.id, w.name);
    wsTotals.set(w.id, blank());
  }
  const overall = blank();
  for (const s of outScreens) {
    if (!wsTotals.has(s.workspace_id)) wsTotals.set(s.workspace_id, blank());
    add(wsTotals.get(s.workspace_id), s);
    add(overall, s);
  }

  return {
    period: { start_epoch: startEpoch, end_epoch: endEpoch, first_day: firstDay, last_day: lastDay, seconds: endEpoch - startEpoch },
    screens: outScreens,
    workspaces: [...wsTotals.entries()].map(([wid, t]) => ({ workspace_id: wid, name: wsNames.get(wid) ?? null, ...finish(t) })),
    overall: finish(overall),
    excluded,
  };
}

// Loads the inputs for summarizeRuntime for ONE organisation and an explicit list of
// workspace ids. Ids that are not in that organisation are silently dropped (every
// query joins workspaces and matches organization_id). Returns
//   { workspaces: [{ id, name, region_id }], screens: [...], usage: [...] }
// with screens/usage shaped as summarizeRuntime expects. Screens registered at or after
// endEpoch are not loaded; blocked screens ARE loaded (summarizeRuntime excludes them,
// so the rule lives in one place).
async function loadRuntimeInputs(db, { organizationId, workspaceIds, startEpoch, endEpoch }) {
  const ids = [...new Set((workspaceIds || []).filter(Boolean))];
  if (!organizationId || !ids.length) return { workspaces: [], screens: [], usage: [] };
  const marks = ids.map(() => '?').join(',');

  const workspaces = await db
    .prepare(`SELECT id, name, region_id FROM workspaces WHERE organization_id = ? AND id IN (${marks}) ORDER BY name, id`)
    .all(organizationId, ...ids);
  if (!workspaces.length) return { workspaces: [], screens: [], usage: [] };

  const screens = await db
    .prepare(
      `SELECT d.id, d.name, d.workspace_id, d.created_at AS registered_at, d.blocked
         FROM devices d
         JOIN workspaces w ON w.id = d.workspace_id
        WHERE w.organization_id = ? AND d.workspace_id IN (${marks})
          AND d.status <> ?
          AND d.created_at < ?
        ORDER BY d.name, d.id`,
    )
    .all(organizationId, ...ids, NOT_A_SCREEN_STATUS, endEpoch);

  const { firstDay, lastDay } = periodDays(startEpoch, endEpoch);
  const usage = await db
    .prepare(
      `SELECT u.device_id, u.day, u.online_seconds
         FROM device_usage_daily u
         JOIN devices d ON d.id = u.device_id
         JOIN workspaces w ON w.id = d.workspace_id
        WHERE w.organization_id = ? AND d.workspace_id IN (${marks})
          AND u.day BETWEEN ? AND ?`,
    )
    .all(organizationId, ...ids, firstDay, lastDay);

  return {
    workspaces,
    screens: screens.map((s) => ({ ...s, registered_at: Number(s.registered_at), blocked: Number(s.blocked) })),
    usage: usage.map((u) => ({ ...u, online_seconds: Number(u.online_seconds) })),
  };
}

// load + summarize. Same arguments as loadRuntimeInputs; the result is summarizeRuntime's
// plus `workspaces_loaded` (the org-checked workspace rows, with region_id).
async function getRuntimeSummary(db, opts) {
  const inputs = await loadRuntimeInputs(db, opts);
  const summary = summarizeRuntime({ ...inputs, startEpoch: opts.startEpoch, endEpoch: opts.endEpoch });
  return { ...summary, workspaces_loaded: inputs.workspaces };
}

// PMI Ref 71: average runtime as hours online per screen per day, i.e. the
// time-weighted average uptime (total online seconds / total seconds the screens
// existed in the period, as in `totals` above) x 24. Worked from the unrounded
// seconds, capped at 24 and rounded half-up to 1 decimal. null when no screen
// existed in the period (no denominator). `totals` is summarizeRuntime's `overall`
// or one of its `workspaces` entries.
function avgRuntimeHoursPerDay(totals) {
  if (!totals || !(totals.available_seconds > 0)) return null;
  return round1(Math.min(1, totals.runtime_seconds / totals.available_seconds) * 24);
}

// PMI Ref 71: the Overview dashboard's period selector (a day count: 1 "24h",
// 7 "7d", 30 "30d"; the labels are accepted too) mapped to whole COMPLETE UTC days
// ending at today's UTC midnight, so today (still accruing) is never included:
// 1 -> yesterday, 7 -> the 7 days before today, 30 -> the 30 days before today.
// A missing or unknown value falls back to 30 days, the window the other dashboard
// routes use when no start is given (`defaulted: true` says so).
// Returns { days, defaulted, startEpoch, endEpoch (exclusive), first_day, last_day, label }.
const DASHBOARD_PERIOD_DAYS = { 1: 1, '24h': 1, 7: 7, '7d': 7, 30: 30, '30d': 30 };
const DEFAULT_DASHBOARD_PERIOD_DAYS = 30;
function completeUtcDays(period, now = new Date()) {
  const key = String(period ?? '').trim().toLowerCase();
  const known = Object.prototype.hasOwnProperty.call(DASHBOARD_PERIOD_DAYS, key);
  const days = known ? DASHBOARD_PERIOD_DAYS[key] : DEFAULT_DASHBOARD_PERIOD_DAYS;
  const endEpoch = Math.floor(now.getTime() / 1000 / DAY) * DAY;
  const startEpoch = endEpoch - days * DAY;
  const { firstDay, lastDay } = periodDays(startEpoch, endEpoch);
  return {
    days,
    defaulted: !known,
    startEpoch,
    endEpoch,
    first_day: firstDay,
    last_day: lastDay,
    label: days === 1 ? 'last complete day (UTC)' : `last ${days} complete days (UTC)`,
  };
}

module.exports = {
  summarizeRuntime,
  loadRuntimeInputs,
  getRuntimeSummary,
  avgRuntimeHoursPerDay,
  completeUtcDays,
  DASHBOARD_PERIOD_DAYS,
  round1,
  DAY,
  NOT_A_SCREEN_STATUS,
  isBlockedScreen,
};
