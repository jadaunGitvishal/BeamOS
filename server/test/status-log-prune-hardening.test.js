'use strict';

// #146 hardening (Item A) — pruneStatusLog must be per-device, chunked, non-blocking,
// band-gated, and re-entrant. The old whole-table ROW_NUMBER sort blocked the loop
// 40-48s on the 1.1M-row incident table (the death-spiral amplifier). Deterministic,
// in-process.

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-pruneharden-' + crypto.randomBytes(4).toString('hex'));
process.env.STATUS_LOG_RETENTION_DAYS = '3';
process.env.STATUS_LOG_MAX_ROWS_PER_DEVICE = '500';
process.env.STATUS_LOG_PRUNE_BATCH = '2000';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { db, pruneStatusLog } = require('../db/database');
const chunked = require('../lib/chunked-prune');
const config = require('../config');   // same instance pruneStatusLog reads (env set above)

// Runs against the REAL MySQL database: every device/status row this file creates
// carries a per-run prefix, and only prefixed rows are ever deleted.
const PREFIX = `sl-harden-${crypto.randomBytes(4).toString('hex')}-`;
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

function seed(deviceId, n, ageSecFn) {
  const ins = db.prepare('INSERT INTO device_status_log (device_id, status, timestamp) VALUES (?, ?, ?)');
  const now = Math.floor(Date.now() / 1000);
  const tx = db.transaction((count) => {
    for (let i = 0; i < count; i++) ins.run(deviceId, i % 2 ? 'online' : 'offline', now - ageSecFn(i));
  });
  tx(n);
}
// With a device: that (prefixed) device's rows. Without one: all of THIS file's rows only.
const count = (d) => (d
  ? db.prepare('SELECT COUNT(*) c FROM device_status_log WHERE device_id = ?').get(d)
  : db.prepare('SELECT COUNT(*) c FROM device_status_log WHERE device_id LIKE ?').get(LIKE)).c;

test('correctness: keeps newest cap per device, drops older-than-retention, devices independent', async (t) => {
  await db.prepare('DELETE FROM device_status_log WHERE device_id LIKE ?').run(LIKE);
  chunked.__setBandForTest(() => 'normal');
  await addDevices('A', 'B', 'C');
  // device A: 800 recent rows -> cap keeps newest 500
  seed(dev('A'), 800, () => 0);
  // device B: 300 recent (< cap, all kept) + 50 older-than-retention (dropped)
  seed(dev('B'), 300, () => 0);
  seed(dev('B'), 50, () => 10 * 86400);
  // device C: 10 rows, all old -> all dropped
  seed(dev('C'), 10, () => 10 * 86400);

  if (await skipIfForeignPrunable(t)) return;
  await pruneStatusLog();

  assert.equal(count(dev('A')), 500, 'A capped to newest 500');
  assert.equal(count(dev('B')), 300, 'B keeps its 300 recent, drops the 50 old');
  assert.equal(count(dev('C')), 0, 'C all older than retention -> gone');
  const cutoff = Math.floor(Date.now() / 1000) - 3 * 86400;
  assert.ok(db.prepare('SELECT MIN(timestamp) m FROM device_status_log WHERE device_id LIKE ?').get(LIKE).m >= cutoff, 'nothing older than retention survives');
});

test('non-blocking: 300k-row single-device backlog trims in many batches, loop stays responsive', async (t) => {
  await db.prepare('DELETE FROM device_status_log WHERE device_id LIKE ?').run(LIKE);
  chunked.__setBandForTest(() => 'normal');
  await addDevices('flapper');
  seed(dev('flapper'), 300000, () => 0);              // all recent -> cap prune must remove ~299500
  assert.equal(count(dev('flapper')), 300000, 'seeded 300k');

  // Guard before the ticker starts (nothing touches the DB in between), so a skip
  // never leaves an interval running.
  if (await skipIfForeignPrunable(t)) return;
  // Event-loop responsiveness probe: a 10ms ticker; the max gap between ticks is the
  // worst synchronous block during the prune. A single unbatched DELETE would freeze
  // it for seconds; chunked+yield keeps every gap small.
  let maxGap = 0, last = Date.now();
  const ticker = setInterval(() => { const n = Date.now(); maxGap = Math.max(maxGap, n - last); last = n; }, 10);

  const deleted = await pruneStatusLog();
  clearInterval(ticker);

  assert.equal(count(dev('flapper')), 500, 'trimmed to the cap');
  assert.ok(deleted >= 299000, `deleted the backlog (${deleted})`);
  assert.ok(maxGap < 250, `no long freeze — max event-loop gap ${maxGap}ms (would be seconds if unbatched)`);
});

test('band-gate: interval run is a no-op when loaded; startup/normal runs', async (t) => {
  await db.prepare('DELETE FROM device_status_log WHERE device_id LIKE ?').run(LIKE);
  await addDevices('X');
  seed(dev('X'), 900, () => 0);

  chunked.__setBandForTest(() => 'critical');
  try {
    if (await skipIfForeignPrunable(t)) return;
    assert.equal(await pruneStatusLog({ bandGate: true }), 0, 'band-gated interval run skips while critical');
    assert.equal(count(dev('X')), 900, 'no rows touched while loaded');

    // startup path is NOT band-gated even under load
    if (await skipIfForeignPrunable(t)) return;
    assert.ok(await pruneStatusLog({ bandGate: false }) > 0, 'un-gated startup run trims even while critical');
    assert.equal(count(dev('X')), 500, 'startup cleared the backlog to cap');
  } finally {
    chunked.__setBandForTest(() => 'normal');
  }
});

test('re-entrancy: two concurrent runs -> work happens once', async (t) => {
  await db.prepare('DELETE FROM device_status_log WHERE device_id LIKE ?').run(LIKE);
  chunked.__setBandForTest(() => 'normal');
  await addDevices('Y');
  seed(dev('Y'), 5000, () => 0);

  if (await skipIfForeignPrunable(t)) return;   // one check covers both concurrent runs
  const [a, b] = await Promise.all([pruneStatusLog(), pruneStatusLog()]);   // fired synchronously
  assert.ok((a > 0) !== (b > 0), 'exactly one run did the work; the other short-circuited to 0');
  assert.equal(count(dev('Y')), 500, 'trimmed to cap exactly once (no double-run corruption)');
});
