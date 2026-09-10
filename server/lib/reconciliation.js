'use strict';

// Ref 49 (reconciliation reporting), Stage A — identifies real, long-lived
// device discrepancies for one workspace. Two categories, both about devices
// that are CONFIGURED in the system but not actually being used:
//
//   ghost  - a row in `devices` that has NEVER had a `device_telemetry` row:
//            it was registered / paired but has never once reported. (A device
//            that merely opened a socket without ever sending a heartbeat
//            payload still counts as a ghost - the telemetry row is the proof
//            it actually reported.)
//
//   stale  - HAS reported before (>= 1 telemetry row) but its last heartbeat is
//            older than `staleAfterDays`. This is deliberately far longer than
//            the offline-detection window (config.heartbeatTimeout, seconds) -
//            it's about long-term abandonment, not routine connectivity blips.
//            "Last heartbeat" is the most recent of devices.last_heartbeat and
//            MAX(device_telemetry.reported_at), so a device that still checks in
//            (even without a telemetry payload) is NOT flagged.
//
// Blocked devices are excluded from both: a blocked device is intentionally
// disabled, so its silence is expected, not a discrepancy. Devices with no
// workspace (unpaired) are naturally out of scope - this is called per workspace.
//
// All times are UNIX epoch SECONDS (the schema's convention for devices.created_at
// / last_heartbeat and device_telemetry.reported_at).

const { db: defaultDb } = require('../db/database');
const config = require('../config');

// One workspace's reconciliation snapshot.
//   workspaceId   - required
//   now           - Date | epoch-ms | epoch-seconds (default: Date.now())
//   staleAfterDays - override the config default (used by tests)
async function getReconciliation(
  db,
  { workspaceId, now = Date.now(), staleAfterDays = config.reconciliationStaleAfterDays } = {},
) {
  if (!workspaceId) throw new Error('getReconciliation requires a workspaceId');

  const nowSec = toEpochSec(now);
  const staleBefore = nowSec - Math.round(staleAfterDays * 86400);

  const ghosts = await db
    .prepare(
      `SELECT d.id, d.name, d.created_at, d.last_heartbeat
         FROM devices d
        WHERE d.workspace_id = ?
          AND d.blocked = 0
          AND NOT EXISTS (SELECT 1 FROM device_telemetry t WHERE t.device_id = d.id)
        ORDER BY d.created_at ASC, d.id ASC`,
    )
    .all(workspaceId);

  const staleRows = await db
    .prepare(
      `SELECT d.id, d.name, d.created_at, d.last_heartbeat,
              MAX(t.reported_at) AS last_telemetry_at
         FROM devices d
         JOIN device_telemetry t ON t.device_id = d.id
        WHERE d.workspace_id = ?
          AND d.blocked = 0
        GROUP BY d.id, d.name, d.created_at, d.last_heartbeat
       HAVING GREATEST(COALESCE(d.last_heartbeat, 0), MAX(t.reported_at)) < ?
        ORDER BY GREATEST(COALESCE(d.last_heartbeat, 0), MAX(t.reported_at)) ASC, d.id ASC`,
    )
    .all(workspaceId, staleBefore);

  return {
    workspace_id: workspaceId,
    generated_at: nowSec,
    stale_after_days: staleAfterDays,
    ghosts: ghosts.map((r) => ({
      device_id: r.id,
      name: r.name,
      registered_at: numOrNull(r.created_at),
      last_heartbeat: numOrNull(r.last_heartbeat), // usually null for a true ghost
    })),
    stale: staleRows.map((r) => {
      const lastSeen = Math.max(Number(r.last_heartbeat || 0), Number(r.last_telemetry_at || 0));
      return {
        device_id: r.id,
        name: r.name,
        registered_at: numOrNull(r.created_at),
        last_heartbeat: lastSeen || null,
        days_since_heartbeat: lastSeen ? Math.floor((nowSec - lastSeen) / 86400) : null,
      };
    }),
  };
}

function toEpochSec(t) {
  if (t instanceof Date) return Math.floor(t.getTime() / 1000);
  const n = Number(t);
  // > ~1e11 is clearly milliseconds; anything smaller is already seconds.
  return n > 1e11 ? Math.floor(n / 1000) : Math.floor(n);
}
function numOrNull(v) {
  return v == null ? null : Number(v);
}

module.exports = { getReconciliation };
