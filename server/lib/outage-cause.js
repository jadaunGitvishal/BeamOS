'use strict';

// Step 5 Stage A — a permanent, best-effort root-cause hint for a completed
// outage. Computed by services/outage-history.js at the exact moment it records
// the outage: that is the only time the device_telemetry rows from just before
// the outage are still guaranteed to exist (device_telemetry prunes to 6000
// rows/device, ~16-24h at the heartbeat interval).
//
// likely_cause is a plain VARCHAR with a documented value set - NOT an ENUM, so
// a new category can be added here without a schema migration (same philosophy
// as device_events.event_type):
//
//   'correlated_outage' - 2+ devices in the SAME workspace went offline within
//                         CORRELATION_WINDOW_SEC of each other -> a shared
//                         network / power / infrastructure failure.
//   'weak_wifi'          - the device's last telemetry reading at/before the
//                         outage started already had wifi_rssi <=
//                         config.weakWifiRssiDbm.
//   'low_storage'        - ...had storage_free_mb <= config.lowStorageFreeMb.
//   'unknown'            - no signal. Expected for many outages: power loss, app
//                         crash and hardware failure aren't detectable from what
//                         we collect.
//
// PRIORITY when several signals fire for one outage:
//   correlated_outage  >  weak_wifi  >  low_storage  >  unknown
//
// Why correlated_outage first: if a whole store's screens drop within two
// minutes, the ROOT cause is the store's network or power. One of those devices
// also reading -78 dBm is a SYMPTOM of the same failing AP, not an independent
// fault - "fix device X's Wi-Fi" would not have prevented the outage. A
// workspace-wide event is the more actionable, higher-order finding, so it wins
// even when a single-device signal is also present.
//
// Why weak_wifi over low_storage: a weak-signal reading immediately before the
// device loses connectivity is a direct causal story. Low storage is a health
// risk more than a proven outage cause - a device can sit at 400 MB free for
// weeks without an outage - so it only wins when nothing stronger is present.

const config = require('../config');

// How far apart two devices' outage_start may be and still count as "the same
// event". A shared failure drops devices near-simultaneously, but heartbeat
// phase + detection granularity spread the recorded start by up to a minute or
// two, so a few minutes is the right width.
const CORRELATION_WINDOW_SEC = 5 * 60;

// Only trust a telemetry reading as "right before the outage" if it is at most
// this old. The last heartbeat before a device goes offline is normally ~10 s
// prior; a much older reading is stale and not evidence of this outage's cause.
const TELEMETRY_MAX_AGE_SEC = 20 * 60;

const CAUSES = ['correlated_outage', 'weak_wifi', 'low_storage', 'unknown'];

// dbh:         db handle ({ prepare }).
// outage:      { device_id, workspace_id, outage_start, outage_end }.
// peerOutages: every outage detectOutages() returned for this recorder tick
//              (it re-scans the whole retention window, so every possible
//              correlated peer is in here regardless of insert order - including
//              still-ongoing ones). Optional; a DB check backstops it.
// Returns one of CAUSES. Never returns null.
async function classifyOutage(dbh, outage, peerOutages = []) {
  const start = outage.outage_start;

  // (b) correlated_outage — another device in the same workspace within the window
  let correlated = false;
  for (const p of peerOutages) {
    if (p.device_id === outage.device_id) continue;
    if (!p.workspace_id || p.workspace_id !== outage.workspace_id) continue;
    if (Math.abs(p.outage_start - start) <= CORRELATION_WINDOW_SEC) {
      correlated = true;
      break;
    }
  }
  if (!correlated && outage.workspace_id) {
    // Backstop: a peer whose status-log rows aged out but whose outage_history
    // row survives is not in peerOutages; catch it here.
    const peer = await dbh
      .prepare(
        `SELECT 1 FROM outage_history
          WHERE workspace_id = ? AND device_id <> ?
            AND started_at BETWEEN ? AND ?
          LIMIT 1`,
      )
      .get(outage.workspace_id, outage.device_id, start - CORRELATION_WINDOW_SEC, start + CORRELATION_WINDOW_SEC);
    correlated = !!peer;
  }
  if (correlated) return 'correlated_outage';

  // (a) telemetry — the closest reading at/before the outage started
  const t = await dbh
    .prepare(
      `SELECT wifi_rssi, storage_free_mb, reported_at FROM device_telemetry
        WHERE device_id = ? AND reported_at <= ?
        ORDER BY reported_at DESC
        LIMIT 1`,
    )
    .get(outage.device_id, start);
  if (t && start - t.reported_at <= TELEMETRY_MAX_AGE_SEC) {
    if (t.wifi_rssi != null && t.wifi_rssi <= config.weakWifiRssiDbm) return 'weak_wifi';
    if (t.storage_free_mb != null && t.storage_free_mb <= config.lowStorageFreeMb) return 'low_storage';
  }

  // (d) nothing detectable
  return 'unknown';
}

module.exports = { classifyOutage, CAUSES, CORRELATION_WINDOW_SEC, TELEMETRY_MAX_AGE_SEC };
