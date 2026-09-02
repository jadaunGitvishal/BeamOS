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

module.exports = { recordDeviceEvent, buildDeviceAuditTrail, phraseEvent, EVENT_PHRASING };
