'use strict';

// Phase 2 Stage A — device audit trail: the write path (recordDeviceEvent, used
// by the device:report-event socket handler) and the read path
// (buildDeviceAuditTrail, used by GET /api/dashboard/devices/:id/audit-trail).
//
// The trail merges three sources into one reverse-chronological list of
// { timestamp, type, message } in plain English:
//   1. device_status_log   -> "Screen came online" / "Screen went offline"
//   2. device_events        -> event_type + message translated to a sentence
//   3. device_telemetry     -> Wi-Fi / storage threshold CROSSINGS, computed on
//      read by walking consecutive readings (never stored as discrete rows)
//
// device_status_log and device_telemetry are pruned to ~3 days, so the depth of
// (1) and (3) is bounded by that; device_events (2) is kept longer.

const config = require('../config');

// --- (2) event_type -> sentence -----------------------------------------
// Extensible: add a key as new event types land on the Android side. An unknown
// type still renders (generic phrasing) so nothing is silently dropped.
const EVENT_PHRASING = {
  playlist_resumed: (m) => 'Playback resumed' + (m ? ` (${m})` : ''),
  playlist_paused: (m) => 'Playback paused' + (m ? ` (${m})` : ''),
  update_started: (m) => 'Software update started' + (m ? ` (${m})` : ''),
  update_installed: (m) => 'Software update installed' + (m ? ` — now on ${m}` : ''),
  update_failed: (m) => 'Software update failed' + (m ? `: ${m}` : ''),
  app_restarted: (m) => 'Player app restarted' + (m ? ` (${m})` : ''),
};

function phraseEvent(eventType, message) {
  const msg = message ? String(message).trim() : '';
  const fn = EVENT_PHRASING[eventType];
  if (fn) return fn(msg);
  const label = String(eventType || 'event').replace(/_/g, ' ').trim() || 'event';
  return `Device reported "${label}"` + (msg ? `: ${msg}` : '');
}

// --- write path -------------------------------------------------------
// Insert one device_events row, snapshotting workspace_id from the device, then
// bound the table to the newest N rows for this device (insert-time, same shape
// as db/database.js pruneTelemetry). `dbh` is a db handle ({ prepare }).
// Returns the inserted row's id. eventType is required; message is optional.
async function recordDeviceEvent(dbh, deviceId, eventType, message) {
  const type = String(eventType || '').trim().slice(0, 64);
  if (!deviceId || !type) return null;
  const msg = typeof message === 'string' && message.trim() ? message.trim().slice(0, 2000) : null;

  const dev = await dbh.prepare('SELECT workspace_id FROM devices WHERE id = ?').get(deviceId);
  const res = await dbh
    .prepare(
      'INSERT INTO device_events (device_id, workspace_id, event_type, message, occurred_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(deviceId, dev ? dev.workspace_id : null, type, msg, Math.floor(Date.now() / 1000));

  // Keep only the newest `deviceEventsMaxPerDevice` rows for this device.
  await dbh
    .prepare(
      `DELETE FROM device_events WHERE id IN (
         SELECT id FROM (
           SELECT id FROM device_events WHERE device_id = ?
           ORDER BY occurred_at DESC, id DESC LIMIT ? OFFSET ?
         ) x
       )`,
    )
    .run(deviceId, config.statusLogPruneBatch, config.deviceEventsMaxPerDevice);

  return res.lastInsertRowid;
}

// --- read path -------------------------------------------------------
// dbh: db handle. opts: { limit = 200 (1..1000), sinceEpoch }.
// Returns [{ timestamp, type, message }] newest-first. `sinceEpoch` filters the
// OUTPUT, not the telemetry walk — a threshold crossing that happened inside the
// window is still detected using the readings just before it. All three source
// tables are retention-bounded per device, so the un-limited reads are cheap.
async function buildDeviceAuditTrail(dbh, deviceId, opts = {}) {
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 200, 1), 1000);
  const since = Number.isFinite(opts.sinceEpoch) ? opts.sinceEpoch : null;
  const entries = [];

  // (1) online / offline transitions. 'offline' and 'offline_timeout' both mean
  // the screen dropped off.
  const statusRows = await dbh
    .prepare('SELECT status, timestamp FROM device_status_log WHERE device_id = ? ORDER BY timestamp DESC')
    .all(deviceId);
  for (const r of statusRows) {
    entries.push({
      timestamp: r.timestamp,
      type: 'status',
      message: r.status === 'online' ? 'Screen came online' : 'Screen went offline',
    });
  }

  // (2) reported events.
  const eventRows = await dbh
    .prepare('SELECT event_type, message, occurred_at FROM device_events WHERE device_id = ? ORDER BY occurred_at DESC')
    .all(deviceId);
  for (const r of eventRows) {
    entries.push({ timestamp: r.occurred_at, type: 'event', message: phraseEvent(r.event_type, r.message) });
  }

  // (3) Wi-Fi / storage threshold crossings, derived from consecutive telemetry.
  // Walk OLDEST -> newest so "previous state" is defined. A null reading does NOT
  // change the tracked state, so a gap in telemetry can never fake a crossing.
  const teleRows = await dbh
    .prepare(
      'SELECT wifi_rssi, storage_free_mb, reported_at FROM device_telemetry WHERE device_id = ? ORDER BY reported_at ASC',
    )
    .all(deviceId);
  const WEAK = config.weakWifiRssiDbm;
  const LOWSTOR = config.lowStorageFreeMb;
  let wifiWeak = null; // null until the first non-null reading
  let storLow = null;
  for (const r of teleRows) {
    if (r.wifi_rssi != null) {
      const nowWeak = r.wifi_rssi < WEAK;
      if (wifiWeak !== null && nowWeak !== wifiWeak) {
        entries.push({
          timestamp: r.reported_at,
          type: 'telemetry',
          message: nowWeak
            ? `Wi-Fi signal dropped to weak (${r.wifi_rssi} dBm)`
            : `Wi-Fi signal recovered (${r.wifi_rssi} dBm)`,
        });
      }
      wifiWeak = nowWeak;
    }
    if (r.storage_free_mb != null) {
      const nowLow = r.storage_free_mb < LOWSTOR;
      if (storLow !== null && nowLow !== storLow) {
        entries.push({
          timestamp: r.reported_at,
          type: 'telemetry',
          message: nowLow
            ? `Storage space running low (${r.storage_free_mb} MB free)`
            : `Storage space recovered (${r.storage_free_mb} MB free)`,
        });
      }
      storLow = nowLow;
    }
  }

  // newest first; deterministic tiebreak for equal timestamps.
  entries.sort(
    (a, b) => b.timestamp - a.timestamp || a.type.localeCompare(b.type) || a.message.localeCompare(b.message),
  );
  const windowed = since !== null ? entries.filter((e) => e.timestamp >= since) : entries;
  return windowed.slice(0, limit);
}

// --- Phase 2 Stage C: 7-day online/offline heatmap ---------------------
// Buckets device_status_log into a day x hour grid of online-% per hour, plus a
// simple "same hours bad on 3+ consecutive days" pattern flag. Bucketing is done
// here (server-side) so the wire payload is ~168 small cells, not the raw
// transition log. Only cells with real coverage are returned; hours with no
// status_log data (older than the ~3-day retention, or gaps) are simply absent
// and the client renders them as "no data".

const OFFLINE_STATES = new Set(['offline', 'offline_timeout']);
const HEATMAP_PROBLEM_PCT = 50; // an hour with online_pct below this is "a problem"
const HEATMAP_MIN_RUN = 3; // consecutive problem days needed to call it a pattern

function utcMidnight(sec) {
  return Math.floor(sec / 86400) * 86400;
}
function pad2(n) {
  return String(n).padStart(2, '0');
}

// dbh: db handle. opts: { days = 7 (1..14), nowMs }.
// Returns { days, start, cells: [{day,hour,online_pct,covered_sec}], pattern|null }.
async function buildStatusHeatmap(dbh, deviceId, opts = {}) {
  const days = Math.min(Math.max(parseInt(opts.days, 10) || 7, 1), 14);
  const nowSec = Math.floor((opts.nowMs != null ? opts.nowMs : Date.now()) / 1000);
  const startSec = utcMidnight(nowSec) - (days - 1) * 86400; // 00:00 UTC, (days-1) days back
  const startIso = isoDayFromSec(startSec);

  // state as of `startSec`: the last transition strictly before the window.
  const prior = await dbh
    .prepare(
      'SELECT status FROM device_status_log WHERE device_id = ? AND timestamp < ? ORDER BY timestamp DESC LIMIT 1',
    )
    .get(deviceId, startSec);
  const inWindow = await dbh
    .prepare(
      'SELECT status, timestamp FROM device_status_log WHERE device_id = ? AND timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC, id ASC',
    )
    .all(deviceId, startSec, nowSec);

  // Build [state, from, to) segments across [coverageStart, nowSec].
  const online = new Float64Array(days * 24);
  const offline = new Float64Array(days * 24);
  let coverageStart = startSec;
  let state = prior ? !OFFLINE_STATES.has(prior.status) : null; // null = unknown until first row
  if (state === null && inWindow.length) {
    coverageStart = inWindow[0].timestamp;
    state = !OFFLINE_STATES.has(inWindow[0].status);
  }
  const addSegment = (from, to, isOnline) => {
    if (to <= from) return;
    let t = from;
    while (t < to) {
      const idx = Math.floor((t - startSec) / 3600);
      const bucketEnd = startSec + (idx + 1) * 3600;
      const chunkEnd = Math.min(to, bucketEnd);
      if (idx >= 0 && idx < days * 24) (isOnline ? online : offline)[idx] += chunkEnd - t;
      t = chunkEnd;
    }
  };
  if (state !== null) {
    let cursor = coverageStart;
    for (const row of inWindow) {
      if (row.timestamp <= cursor) {
        state = !OFFLINE_STATES.has(row.status);
        continue;
      }
      addSegment(cursor, row.timestamp, state);
      state = !OFFLINE_STATES.has(row.status);
      cursor = row.timestamp;
    }
    addSegment(cursor, nowSec, state);
  }

  const cells = [];
  const grid = Array.from({ length: days }, () => new Array(24).fill(null));
  for (let i = 0; i < days * 24; i++) {
    const covered = online[i] + offline[i];
    if (covered <= 0) continue;
    const d = Math.floor(i / 24);
    const h = i % 24;
    const pct = Math.round((online[i] / covered) * 100);
    grid[d][h] = pct;
    cells.push({
      day: isoDayFromSec(startSec + d * 86400),
      hour: h,
      online_pct: pct,
      covered_sec: Math.round(covered),
    });
  }

  return { days, start: startIso, cells, pattern: detectHeatmapPattern(grid, days) };
}

function isoDayFromSec(sec) {
  return new Date(sec * 1000).toISOString().slice(0, 10);
}

// Simple pattern match: for each hour, the longest run of CONSECUTIVE days whose
// cell is present and below the problem threshold. If any hour hits the minimum
// run, collapse the qualifying hours into a contiguous range and describe it.
function detectHeatmapPattern(grid, days) {
  const runByHour = new Array(24).fill(0);
  for (let h = 0; h < 24; h++) {
    let run = 0;
    let best = 0;
    for (let d = 0; d < days; d++) {
      const v = grid[d][h];
      if (v != null && v < HEATMAP_PROBLEM_PCT) {
        run += 1;
        if (run > best) best = run;
      } else {
        run = 0;
      }
    }
    runByHour[h] = best;
  }

  const badHours = [];
  for (let h = 0; h < 24; h++) if (runByHour[h] >= HEATMAP_MIN_RUN) badHours.push(h);
  if (!badHours.length) return null;

  // pick the contiguous block containing the hour with the biggest run
  let peakHour = badHours[0];
  for (const h of badHours) if (runByHour[h] > runByHour[peakHour]) peakHour = h;
  let lo = peakHour;
  let hi = peakHour;
  while (lo - 1 >= 0 && runByHour[lo - 1] >= HEATMAP_MIN_RUN) lo -= 1;
  while (hi + 1 < 24 && runByHour[hi + 1] >= HEATMAP_MIN_RUN) hi += 1;

  const consecutive = runByHour[peakHour];
  return {
    detected: true,
    hour_start: lo,
    hour_end: hi + 1, // exclusive end, so a 15–16 block reads "15:00–17:00"
    consecutive_days: consecutive,
    message: `Repeated issue detected: offline around ${pad2(lo)}:00–${pad2(hi + 1)}:00 on ${consecutive} of the last ${days} days`,
  };
}

module.exports = {
  recordDeviceEvent,
  buildDeviceAuditTrail,
  buildStatusHeatmap,
  detectHeatmapPattern,
  phraseEvent,
  EVENT_PHRASING,
};
