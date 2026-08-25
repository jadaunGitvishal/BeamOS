// #146 — batched, coalescing writer for device_status_log.
//
// Before: every device status transition (online/offline/offline_timeout) did its
// own synchronous INSERT on the hot path (deviceSocket.logDeviceStatus + the
// heartbeat checker). Under a reconnect storm that is one row PER flap, which both
// (a) bloats the table — it reached 1.1M rows in prod — and (b) makes each write
// slower as the table grows, lagging status processing further. A textbook feedback
// loop, the connection-layer twin of the OTA loop #144 contained.
//
// After: transitions are buffered in memory and flushed on an interval. The buffer
// keeps only the LATEST (net) status per device, so a device that flaps
// online->offline->online within a flush window collapses to at most one row — and
// if it ends where it started, zero rows. devices.status (the dashboard's source of
// truth) is still updated immediately by the callers; only the AUDIT log is batched,
// so coalescing storm noise loses nothing the uptime view needs.
//
// State is in-memory and resets on restart (like the throttle / breaker buckets).

const { db } = require('../db/database');
const config = require('../config');

const pending = new Map();      // deviceId -> latest desired status (net state)
const lastWritten = new Map();  // deviceId -> last status actually inserted
let timer = null;


// Record a transition. Cheap and allocation-light: just remembers the latest state.
function record(deviceId, status) {
  if (!deviceId || !status) return;
  pending.set(deviceId, status);
}

// Write all buffered transitions whose net state differs from what's on disk.
// Returns the number of rows actually inserted (for tests/observability).
async function flush() {
  if (pending.size === 0) return 0;
  const batch = [];
  for (const [deviceId, status] of pending) {
    if (lastWritten.get(deviceId) !== status) batch.push([deviceId, status]);
  }
  pending.clear();
  if (batch.length === 0) return 0;

  try {
    const ageSec = Math.round(config.statusLogRetentionDays * 86400);
    // db.transaction()'s callback gets a TRANSACTION-SCOPED handle (tx) - every statement
    // must be prepared from tx, not the outer db, or it would run on a different pooled
    // connection and NOT be part of this transaction (see db/database.js's transaction()).
    const writeAll = db.transaction(async (tx, rows) => {
      const ins = tx.prepare('INSERT INTO device_status_log (device_id, status) VALUES (?, ?)');
      const prune = tx.prepare("DELETE FROM device_status_log WHERE device_id = ? AND timestamp < UNIX_TIMESTAMP() - ?");
      for (const [deviceId, status] of rows) {
        await ins.run(deviceId, status);
        lastWritten.set(deviceId, status);
        await prune.run(deviceId, ageSec);
      }
    });
    await writeAll(batch);
    // #146 Item E: bound lastWritten so it can't grow unbounded over churned device_ids.
    // It only suppresses a redundant consecutive same-status row, so evicting the oldest
    // entries is safe (worst case: one extra row later). Keep it to the newest ~5k ids.
    if (lastWritten.size > 5000) {
      const excess = lastWritten.size - 5000;
      let i = 0;
      for (const k of lastWritten.keys()) { if (i++ >= excess) break; lastWritten.delete(k); }
    }
    return batch.length;
  } catch (_) {
    // table might not exist yet (early boot) — drop silently, same as the old path
    return 0;
  }
}

function start() {
  if (timer) return timer;
  // flush() is async; setInterval doesn't await its callback, so a rejection would
  // otherwise become an unhandled rejection (server.js's crash handler treats that as
  // fatal). flush() already catches its own errors internally, but wrap defensively in
  // case that ever changes.
  timer = setInterval(() => { flush().catch((e) => console.error('[status-log-writer] flush failed:', e.message)); }, config.statusLogFlushMs);
  if (timer.unref) timer.unref();  // don't keep the process alive on the flush timer
  return timer;
}

// Test-only: force a flush and clear coalescing memory.
async function flushNow() { return flush(); }
function __reset() { pending.clear(); lastWritten.clear(); }

module.exports = { record, flush, flushNow, start, __reset };
