'use strict';

// #142 step 4 — global device_status_log retention sweep. Deterministic, in-process
// (no server/port). Isolate the DB and set retention BEFORE requiring the module
// (config reads env at load; database.js initialises a DB on load).

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-statusprune-' + crypto.randomBytes(4).toString('hex'));
process.env.STATUS_LOG_RETENTION_DAYS = '2';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { db, pruneStatusLog } = require('../db/database');
const config = require('../config');   // same instance pruneStatusLog reads (env set above)

// Runs against the REAL MySQL database: every device/status row this file creates
// carries a per-run prefix, and only prefixed rows are ever deleted.
const PREFIX = `sl-prune-${crypto.randomBytes(4).toString('hex')}-`;
const LIKE = `${PREFIX}%`;
const dev = (name) => PREFIX + name;
async function addDevices(...names) {
  const now = Math.floor(Date.now() / 1000);
  for (const n of names) await db.prepare("INSERT INTO devices (id, status, created_at) VALUES (?, 'offline', ?)").run(dev(n), now);
}
// pruneStatusLog() is a GLOBAL sweep (retention + per-device cap over every device).
// Run immediately before each call: skip if it would delete rows this file didn't
// create. The retention cutoff is a minute later than the sweep's own, so a row
// crossing the line between this check and the sweep is counted too.
async function skipIfForeignPrunable(t) {
  const cutoff = Math.floor(Date.now() / 1000) - config.statusLogRetentionDays * 86400 + 60;
  const foreignOld = Number((await db.prepare('SELECT COUNT(*) AS n FROM device_status_log WHERE device_id NOT LIKE ? AND timestamp < ?').get(LIKE, cutoff)).n);
  const foreignOverCap = config.statusLogMaxRowsPerDevice > 0
    ? Number((await db.prepare('SELECT COUNT(*) AS n FROM (SELECT device_id FROM device_status_log WHERE device_id NOT LIKE ? GROUP BY device_id HAVING COUNT(*) > ?) x').get(LIKE, config.statusLogMaxRowsPerDevice)).n)
    : 0;
  if (foreignOld > 0 || foreignOverCap > 0) {
    t.skip(`pruneStatusLog would touch rows this test didn't create: ${foreignOld} over-retention row(s), ${foreignOverCap} over-cap device(s)`);
    return true;
  }
  return false;
}

after(async () => {
  try {
    await db.prepare('DELETE FROM device_status_log WHERE device_id LIKE ?').run(LIKE);
    await db.prepare('DELETE FROM devices WHERE id LIKE ?').run(LIKE);   // cascades any status rows
  } finally {
    await db.close();
  }
});

test('global sweep deletes rows older than retention across ALL devices, keeps recent', async (t) => {
  await db.prepare('DELETE FROM device_status_log WHERE device_id LIKE ?').run(LIKE); // clean slate (own rows)
  await addDevices('live-dev', 'removed-idle-dev', 'hb-dev');
  const old = db.prepare('INSERT INTO device_status_log (device_id, status, timestamp) VALUES (?, ?, ?)');
  const now = Math.floor(Date.now() / 1000);

  // 5 days old (> 2d retention): an active device, a device NOT in the devices
  // table (removed/idle — what the per-device insert-time prune never revisits),
  // and the heartbeat offline_timeout status that bypasses logDeviceStatus.
  old.run(dev('live-dev'), 'online', now - 5 * 86400);
  old.run(dev('removed-idle-dev'), 'offline', now - 5 * 86400);
  old.run(dev('hb-dev'), 'offline_timeout', now - 5 * 86400);
  // recent (< retention): must survive, regardless of device existence / status.
  old.run(dev('live-dev'), 'online', now);
  old.run(dev('hb-dev'), 'offline_timeout', now - 3600);

  assert.equal(db.prepare('SELECT COUNT(*) c FROM device_status_log WHERE device_id LIKE ?').get(LIKE).c, 5, 'seeded 5 rows');

  if (await skipIfForeignPrunable(t)) return;
  const deleted = await pruneStatusLog();
  assert.equal(deleted, 3, 'the 3 over-retention rows pruned (incl. removed-idle + offline_timeout paths)');

  const remaining = db.prepare('SELECT device_id, status FROM device_status_log WHERE device_id LIKE ? ORDER BY device_id').all(LIKE);
  assert.equal(remaining.length, 2);
  // both survivors are the recent rows; no old row of any device/status survived
  assert.deepEqual(remaining.map(r => r.device_id).sort(), [dev('hb-dev'), dev('live-dev')]);
  const oldestNow = db.prepare('SELECT MIN(timestamp) m FROM device_status_log WHERE device_id LIKE ?').get(LIKE).m;
  const cutoff = Math.floor(Date.now() / 1000) - 2 * 86400;
  assert.ok(oldestNow >= cutoff, 'no surviving row is older than the retention cutoff');
});

test('sweep is safe and idempotent on an empty/already-clean table', async (t) => {
  await db.prepare('DELETE FROM device_status_log WHERE device_id LIKE ?').run(LIKE);
  if (await skipIfForeignPrunable(t)) return;
  assert.equal(await pruneStatusLog(), 0, 'nothing to delete -> 0, no throw');
});
