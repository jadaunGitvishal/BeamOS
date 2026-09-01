'use strict';

// Ref 51 (SLA Dashboard) — shared device-outage detection over device_status_log.
//
// This is the ONE implementation of the LAG/LEAD pairing that turns a per-device
// stream of 'online' / 'offline' / 'offline_timeout' rows into discrete outages.
// Both callers use it verbatim so they can never drift:
//   - routes/dashboard-reports.js  GET /sla-overview  (live ongoing / live-breach view)
//   - services/outage-history.js   the long-term completed-outage recorder
//
// --- Normalisation --------------------------------------------------------
// device_status_log.status is 'online', 'offline', or 'offline_timeout' (the
// heartbeat checker writes the last one). 'offline' and 'offline_timeout' mean
// the same thing here, so we collapse to is_online = (status = 'online').
//
// --- Collapse to state changes ------------------------------------------
// We drop any row whose normalised state equals the previous row's (per device,
// time order). This is load-bearing: one outage can log two consecutive
// non-online rows ('offline' then 'offline_timeout'), and pairing every offline
// row with the next online row would double-count that outage (the second pair
// spanning zero / negative time). After collapsing, every is_online = 0 row is
// exactly one outage start and LEAD() gives its recovery row (or NULL).
//
// --- Edge cases --------------------------------------------------------
//   * Device still offline, no recovery row yet -> outage_end is NULL. It is a
//     real ongoing outage: the caller decides what to do with it (the endpoint
//     treats it as a live-breach candidate; the recorder skips it — not a
//     COMPLETED outage).
//   * Device already offline when the window opened, then recovers: the first
//     row seen is the 'online' recovery, which has no preceding offline change
//     row, so NO outage is emitted — no phantom outage back to t=0. We only ever
//     pair FORWARD from a real offline row.
//   * First row seen is 'offline' (device went down at/after window start): a
//     genuine observed outage start, counted from that timestamp.
//
// The JOIN to devices both attaches workspace_id (needed by the recorder) and
// drops device_status_log rows whose device no longer exists (the table has no
// FK — rows survive device deletion for audit — but an outage we can't scope to
// a workspace is not useful to either caller).

// dbh:  a db handle from db/database.js ({ prepare }) — the shared pool handle
//       or a transaction-scoped one.
// opts: { sinceEpoch, untilEpoch, workspaceId? }
//       workspaceId omitted/null  -> every device (the recorder's platform-wide sweep)
//
// Returns rows { device_id, workspace_id, outage_start, outage_end }, ordered by
// (device_id, outage_start). outage_end === null means the outage is still ongoing.
async function detectOutages(dbh, { sinceEpoch, untilEpoch, workspaceId = null }) {
  const params = [sinceEpoch, untilEpoch];
  let scopeSql = '';
  if (workspaceId != null) {
    scopeSql = ' AND d.workspace_id = ?';
    params.push(workspaceId);
  }

  return dbh
    .prepare(
      `
      WITH ordered AS (
        SELECT
          l.device_id AS device_id,
          d.workspace_id AS workspace_id,
          l.timestamp AS ts,
          l.id AS id,
          CASE WHEN l.status = 'online' THEN 1 ELSE 0 END AS is_online
        FROM device_status_log l
        JOIN devices d ON d.id = l.device_id
        WHERE l.timestamp >= ? AND l.timestamp <= ?${scopeSql}
      ),
      flagged AS (
        SELECT device_id, workspace_id, ts, id, is_online,
          LAG(is_online) OVER (PARTITION BY device_id ORDER BY ts, id) AS prev_online
        FROM ordered
      ),
      changes AS (
        SELECT device_id, workspace_id, ts, id, is_online
        FROM flagged
        WHERE prev_online IS NULL OR prev_online <> is_online
      ),
      paired AS (
        SELECT device_id, workspace_id, ts, is_online,
          LEAD(ts) OVER (PARTITION BY device_id ORDER BY ts, id) AS recovered_ts
        FROM changes
      )
      SELECT device_id, workspace_id, ts AS outage_start, recovered_ts AS outage_end
      FROM paired
      WHERE is_online = 0
      ORDER BY device_id, ts
    `,
    )
    .all(...params);
}

module.exports = { detectOutages };
