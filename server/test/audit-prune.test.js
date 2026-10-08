'use strict';

// Audit-log retention pruning that keeps the hash chain verifiable
// (lib/activity-chain.js pruneChain + verifyChain's checkpoint handling,
// services/activity.js pruneActivityLog, DELETE /api/activity/prune).
//
// Isolation: the whole process runs against a SCRATCH MySQL database created here
// and dropped in after(). MYSQL_DATABASE is pointed at it before config / the db
// module load, so the real initDb() (schema, migrations, schema-check, backfill),
// logActivity and the in-process app all use it - the shared dev database's audit
// log is never pruned or read. Each test resets the scratch chain to empty first.

const crypto = require('node:crypto');

const DB_NAME = `beamos_audit_prune_${crypto.randomBytes(4).toString('hex')}`;
process.env.MYSQL_DATABASE = DB_NAME;

const test = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');

const config = require('../config');
const mysqlTls = require('../lib/mysql-tls');
const { initDb, db } = require('../db/database');
const { GENESIS_PREV_HASH, PRUNED_ACTION, appendEntry, pruneChain, backfillChain, verifyChain } = require('../lib/activity-chain');
const { verifyAndRepairSchema } = require('../lib/schema-check');
const { logActivity, pruneActivityLog } = require('../services/activity');

const DAY = 86400;
const now = () => Math.floor(Date.now() / 1000);
const RETENTION = config.auditLogRetentionDays;
const cutoffNow = () => now() - RETENTION * DAY;
const OLD = () => now() - (RETENTION + 30) * DAY; // outside the window
const NEW = () => now() - 10 * DAY; // inside the window

let app;
let admin, member;

function baseOptions() {
  const o = { host: config.mysqlHost, port: config.mysqlPort, user: config.mysqlUser, password: config.mysqlPassword };
  if (config.mysqlSocketPath) o.socketPath = config.mysqlSocketPath;
  const ssl = mysqlTls.mysqlSslOptions(config);
  if (ssl) o.ssl = ssl;
  return o;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(method, path, { token } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${app.base}${path}`, { method, headers });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}

async function registerUser(prefix) {
  const email = `${prefix}-${crypto.randomBytes(4).toString('hex')}@auditprune.local`;
  const res = await fetch(`${app.base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'audit-prune-pass-1', name: prefix, createOrg: true }),
  });
  const json = await res.json();
  assert.equal(res.status, 201, JSON.stringify(json));
  return { id: json.user.id, token: json.token };
}

// Empty chain, never pruned.
async function reset() {
  await db.exec('DELETE FROM activity_log');
  await db
    .prepare('UPDATE activity_log_chain SET last_hash = ?, entry_count = 0, anchor_id = NULL, anchor_hash = NULL, pruned_count = 0 WHERE id = 1')
    .run(GENESIS_PREV_HASH);
}

async function seed(timestamps) {
  const ids = [];
  for (const created_at of timestamps) {
    const r = await appendEntry(db, { action: 'test:seed', details: `t=${created_at}`, created_at });
    ids.push(Number(r.id));
  }
  return ids;
}

const chainRow = () => db.prepare('SELECT last_hash, entry_count, anchor_id, anchor_hash, pruned_count FROM activity_log_chain WHERE id = 1').get();
const ids = async () => (await db.prepare('SELECT id FROM activity_log ORDER BY id').all()).map((r) => Number(r.id));
const prunedRows = () => db.prepare('SELECT id, user_id, details, prev_hash FROM activity_log WHERE action = ? ORDER BY id').all(PRUNED_ACTION);
const types = (report) => report.failures.map((f) => f.type);

// Injected failure for the audit:pruned append: a CHECK constraint (no SUPER
// needed, unlike a trigger) makes that one INSERT fail inside the prune.
async function withPrunedInsertBlocked(fn) {
  await db.exec(`ALTER TABLE activity_log ADD CONSTRAINT chk_test_no_pruned CHECK (action <> '${PRUNED_ACTION}')`);
  try { return await fn(); } finally { await db.exec('ALTER TABLE activity_log DROP CHECK chk_test_no_pruned'); }
}

test.before(async () => {
  const conn = await mysql.createConnection(baseOptions());
  await conn.query(`CREATE DATABASE \`${DB_NAME}\``);
  await conn.end();
  await initDb();
  const { startInProcessApp } = require('./helpers/inprocess-app');
  app = await startInProcessApp({ only: ['/api/activity'] });
  admin = await registerUser('pruneadmin');
  await db.prepare("UPDATE users SET role = 'platform_admin' WHERE id = ?").run(admin.id);
  member = await registerUser('prunemember');
});

test.after(async () => {
  if (app) await app.server.close();
  try { await db.exec(`DROP DATABASE \`${DB_NAME}\``); } finally { await db.close(); }
});

test('prune: old block removed, full and ranged verification pass', async () => {
  await reset();
  const old = await seed([OLD(), OLD(), OLD(), OLD(), OLD()]);
  const kept = await seed([NEW(), NEW(), NEW(), NEW()]);
  const lastOld = await db.prepare('SELECT entry_hash FROM activity_log WHERE id = ?').get(old[4]);

  const res = await pruneChain(db, { cutoffEpoch: cutoffNow(), userId: admin.id });
  assert.equal(res.pruned, 5);
  assert.equal(res.anchor_id, old[4]);

  const remaining = await ids();
  assert.deepEqual(remaining.slice(0, 4), kept);
  assert.equal(remaining.length, 5);

  const head = await chainRow();
  assert.equal(Number(head.anchor_id), old[4]);
  assert.equal(head.anchor_hash, lastOld.entry_hash);
  assert.equal(Number(head.pruned_count), 5);
  assert.equal(Number(head.entry_count), 10); // 9 seeded + audit:pruned, pruned ones included

  const first = await db.prepare('SELECT prev_hash FROM activity_log WHERE id = ?').get(kept[0]);
  assert.equal(first.prev_hash, lastOld.entry_hash, 'first survivor links to the anchor');

  const [entry] = await prunedRows();
  assert.equal(entry.user_id, admin.id);
  assert.deepEqual(JSON.parse(entry.details), {
    cutoff: res.cutoff, removed: 5, anchor_id: old[4], anchor_hash: lastOld.entry_hash, pruned_count_total: 5,
  });

  const full = await verifyChain(db);
  assert.equal(full.ok, true, JSON.stringify(full.failures));
  assert.equal(full.checked, 5);
  assert.equal(full.chain_head.count_matches, true);
  assert.deepEqual(full.checkpoint, { anchor_id: old[4], anchor_hash: lastOld.entry_hash, pruned_count: 5, entry_count: 10 });

  const ranged = await verifyChain(db, { startId: kept[0] });
  assert.equal(ranged.ok, true, JSON.stringify(ranged.failures));
  assert.equal(ranged.range.start_id, kept[0]);
  const rangedFromPrunedIds = await verifyChain(db, { startId: 1, endId: kept[2] });
  assert.equal(rangedFromPrunedIds.ok, true, JSON.stringify(rangedFromPrunedIds.failures));
  const later = await verifyChain(db, { startId: kept[1] });
  assert.equal(later.ok, true, JSON.stringify(later.failures));
});

test('prune twice: pruned_count accumulates, latest audit:pruned holds the total', async () => {
  await reset();
  await seed([OLD(), OLD(), OLD()]);
  const second = await seed([now() - 20 * DAY, now() - 20 * DAY]);

  const r1 = await pruneChain(db, { cutoffEpoch: cutoffNow(), userId: admin.id });
  assert.equal(r1.pruned, 3);
  // A later cutoff (10 days ago) now also covers the two 20-day-old rows.
  const r2 = await pruneChain(db, { cutoffEpoch: now() - 10 * DAY, userId: admin.id });
  assert.equal(r2.pruned, 2);
  assert.equal(r2.anchor_id, second[1]);

  const head = await chainRow();
  assert.equal(Number(head.pruned_count), 5);
  const entries = await prunedRows();
  assert.equal(entries.length, 2, 'the first audit:pruned entry is inside the window and survives');
  assert.equal(JSON.parse(entries[0].details).pruned_count_total, 3);
  assert.equal(JSON.parse(entries[1].details).pruned_count_total, 5);

  const report = await verifyChain(db);
  assert.equal(report.ok, true, JSON.stringify(report.failures));
});

test('nothing old enough: pruned 0, checkpoint unchanged, no audit:pruned entry', async () => {
  await reset();
  await seed([NEW(), NEW(), NEW()]);
  const before = await chainRow();
  const res = await pruneChain(db, { cutoffEpoch: cutoffNow(), userId: admin.id });
  assert.deepEqual(res, { pruned: 0, cutoff: res.cutoff });
  assert.deepEqual(await chainRow(), before);
  assert.equal((await prunedRows()).length, 0);
  assert.equal((await ids()).length, 3);
  assert.equal((await verifyChain(db)).ok, true);

  await reset();
  assert.deepEqual((await pruneChain(db, { cutoffEpoch: cutoffNow() })).pruned, 0, 'empty table');
  assert.equal((await prunedRows()).length, 0);
});

test('everything old: only the new audit:pruned entry survives and verifies', async () => {
  await reset();
  const old = await seed([OLD(), OLD(), OLD(), OLD()]);
  const res = await pruneChain(db, { cutoffEpoch: cutoffNow(), userId: admin.id });
  assert.equal(res.pruned, 4);
  const rows = await db.prepare('SELECT id, action, prev_hash FROM activity_log').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, PRUNED_ACTION);
  assert.ok(Number(rows[0].id) > old[3]);
  assert.equal(rows[0].prev_hash, (await chainRow()).anchor_hash);
  const report = await verifyChain(db);
  assert.equal(report.ok, true, JSON.stringify(report.failures));
});

test('out-of-order timestamp: block stops at the first in-window row, no middle gap', async () => {
  await reset();
  const [o1, o2] = await seed([OLD(), OLD()]);
  const [n1] = await seed([NEW()]);
  const [late] = await seed([OLD()]); // old timestamp, HIGHER id than n1
  const [n2] = await seed([NEW()]);

  const res = await pruneChain(db, { cutoffEpoch: cutoffNow(), userId: admin.id });
  assert.equal(res.pruned, 2);
  assert.equal(res.anchor_id, o2);
  const remaining = await ids();
  assert.ok(!remaining.includes(o1) && !remaining.includes(o2));
  assert.deepEqual(remaining.slice(0, 3), [n1, late, n2], 'the out-of-order old row survives; no gap');
  const report = await verifyChain(db);
  assert.equal(report.ok, true, JSON.stringify(report.failures));
});

test('concurrency: logActivity calls during a prune all chain correctly', async () => {
  await reset();
  await seed(Array.from({ length: 20 }, () => OLD()));
  await seed([NEW(), NEW(), NEW(), NEW(), NEW()]);

  const writes = (tag, n) => Array.from({ length: n }, (_, i) => logActivity(admin.id, `test:concurrent-${tag}`, `n=${i}`));
  const results = await Promise.all([
    ...writes('a', 15),
    pruneChain(db, { cutoffEpoch: cutoffNow(), userId: admin.id }),
    ...writes('b', 15),
  ]);
  const prune = results[15];
  assert.equal(prune.pruned, 20);

  const n = await db.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE action LIKE 'test:concurrent-%'").get();
  assert.equal(Number(n.n), 30, 'every concurrent write landed');
  const report = await verifyChain(db);
  assert.equal(report.ok, true, JSON.stringify(report.failures));
  assert.equal(report.checked, 5 + 30 + 1);
});

test('atomicity: a failure in the audit:pruned append rolls the whole prune back', async () => {
  await reset();
  await seed([OLD(), OLD(), OLD(), NEW(), NEW()]);
  const rowsBefore = await db.prepare('SELECT id, prev_hash, entry_hash FROM activity_log ORDER BY id').all();
  const chainBefore = await chainRow();

  await withPrunedInsertBlocked(async () => {
    await assert.rejects(pruneChain(db, { cutoffEpoch: cutoffNow(), userId: admin.id }), /chk_test_no_pruned|check constraint/i);
  });

  assert.deepEqual(await db.prepare('SELECT id, prev_hash, entry_hash FROM activity_log ORDER BY id').all(), rowsBefore, 'rows unchanged');
  assert.deepEqual(await chainRow(), chainBefore, 'checkpoint and count unchanged');
  const report = await verifyChain(db);
  assert.equal(report.ok, true, JSON.stringify(report.failures));
});

// A pruned chain with survivors either side of the audit:pruned entry.
async function prunedFixture() {
  await reset();
  await seed([OLD(), OLD(), OLD()]);
  const kept = await seed([NEW(), NEW(), NEW(), NEW()]);
  await pruneChain(db, { cutoffEpoch: cutoffNow(), userId: admin.id });
  const [after] = await seed([now()]);
  const [entry] = await prunedRows();
  assert.equal((await verifyChain(db)).ok, true);
  return { kept, after, entryId: Number(entry.id) };
}

test('tamper: deleting a middle surviving row -> broken_link', async () => {
  const { kept } = await prunedFixture();
  await db.prepare('DELETE FROM activity_log WHERE id = ?').run(kept[2]);
  const report = await verifyChain(db);
  assert.equal(report.ok, false);
  assert.ok(report.failures.some((f) => f.type === 'broken_link' && f.id === kept[3]), JSON.stringify(report.failures));
});

test('tamper: editing the checkpoint -> checkpoint_mismatch', async () => {
  await prunedFixture();
  await db.prepare('UPDATE activity_log_chain SET anchor_hash = ? WHERE id = 1').run('f'.repeat(64));
  let report = await verifyChain(db);
  assert.equal(report.ok, false);
  assert.ok(types(report).includes('checkpoint_mismatch'), JSON.stringify(report.failures));

  await prunedFixture();
  await db.prepare('UPDATE activity_log_chain SET pruned_count = pruned_count + 1 WHERE id = 1').run();
  report = await verifyChain(db);
  assert.equal(report.ok, false);
  assert.ok(types(report).includes('checkpoint_mismatch'), JSON.stringify(report.failures));
  assert.ok(types(report).includes('count_mismatch'));
});

test("tamper: editing the audit:pruned entry's details -> content_altered", async () => {
  const { entryId } = await prunedFixture();
  const row = await db.prepare('SELECT details FROM activity_log WHERE id = ?').get(entryId);
  const d = JSON.parse(row.details);
  d.removed = 1;
  await db.prepare('UPDATE activity_log SET details = ? WHERE id = ?').run(JSON.stringify(d), entryId);
  const report = await verifyChain(db);
  assert.equal(report.ok, false);
  assert.ok(report.failures.some((f) => f.type === 'content_altered' && f.id === entryId), JSON.stringify(report.failures));
});

test('tamper: deleting more rows from the start than the checkpoint records -> failure', async () => {
  const { kept } = await prunedFixture();
  await db.prepare('DELETE FROM activity_log WHERE id <= ?').run(kept[1]);
  const report = await verifyChain(db);
  assert.equal(report.ok, false);
  assert.ok(report.failures.some((f) => f.type === 'broken_link' && f.id === kept[2]), JSON.stringify(report.failures));
  assert.ok(types(report).includes('count_mismatch'));
});

test('tamper: deleting the latest audit:pruned entry -> failure', async () => {
  const { entryId } = await prunedFixture();
  await db.prepare('DELETE FROM activity_log WHERE id = ?').run(entryId);
  const report = await verifyChain(db);
  assert.equal(report.ok, false);
  assert.ok(types(report).includes('checkpoint_mismatch'), JSON.stringify(report.failures));
});

test('tamper: clearing the checkpoint while audit:pruned entries exist -> checkpoint_mismatch', async () => {
  await prunedFixture();
  await db.prepare('UPDATE activity_log_chain SET anchor_id = NULL, anchor_hash = NULL, pruned_count = 0 WHERE id = 1').run();
  const report = await verifyChain(db);
  assert.equal(report.ok, false);
  assert.ok(types(report).includes('checkpoint_mismatch'), JSON.stringify(report.failures));
});

test('never-pruned chain: same report shape and verdicts as before', async () => {
  await reset();
  const seeded = await seed([NEW(), NEW(), NEW(), NEW()]);
  let report = await verifyChain(db);
  assert.deepEqual(Object.keys(report), ['ok', 'checked', 'range', 'failures', 'chain_head'], 'no checkpoint key');
  assert.equal(report.ok, true);
  assert.deepEqual(report.range, { start_id: seeded[0], end_id: seeded[3] });
  assert.deepEqual(Object.keys(report.chain_head), ['stored', 'actual', 'matches', 'stored_count', 'actual_count', 'count_matches']);
  assert.equal(report.chain_head.stored_count, 4);

  const ranged = await verifyChain(db, { startId: seeded[0], endId: seeded[2] });
  assert.deepEqual(Object.keys(ranged), ['ok', 'checked', 'range', 'failures']);
  assert.equal(ranged.ok, true);

  // Pre-existing failure types are reported exactly as before (genesis anchor).
  await db.prepare('DELETE FROM activity_log WHERE id = ?').run(seeded[0]);
  report = await verifyChain(db);
  assert.deepEqual(report.failures.map((f) => [f.type, f.id]), [['broken_link', seeded[1]], ['count_mismatch', null]]);
  assert.match(report.failures[0].detail, new RegExp(GENESIS_PREV_HASH.slice(0, 12)));
});

test('backfillChain at boot keeps a pruned chain verifiable', async () => {
  await prunedFixture();
  const before = await chainRow();
  await backfillChain(db);
  assert.deepEqual(await chainRow(), before, 'entry_count still includes the pruned rows');
  const report = await verifyChain(db);
  assert.equal(report.ok, true, JSON.stringify(report.failures));

  // Everything pruned and the audit:pruned row gone too: the head falls back to
  // the anchor, not genesis (verification still flags the missing entry).
  await reset();
  await seed([OLD()]);
  await pruneChain(db, { cutoffEpoch: cutoffNow() });
  await db.exec('DELETE FROM activity_log');
  await backfillChain(db);
  const head = await chainRow();
  assert.equal(head.last_hash, head.anchor_hash);
});

test('startup repair adds the checkpoint columns once; second run is a no-op', async () => {
  await reset();
  await db.exec('ALTER TABLE activity_log_chain DROP COLUMN anchor_id, DROP COLUMN anchor_hash, DROP COLUMN pruned_count');

  async function run() {
    const logs = [];
    const warn = console.warn;
    const error = console.error;
    console.warn = (...a) => logs.push(a.join(' '));
    console.error = (...a) => logs.push(`ERROR ${a.join(' ')}`);
    let missing;
    try { missing = await verifyAndRepairSchema(db, { onMissing: () => {} }); } finally {
      console.warn = warn;
      console.error = error;
    }
    return { missing, logs: logs.filter((l) => l.includes('activity_log_chain')) };
  }

  const first = await run();
  assert.deepEqual(first.missing, []);
  for (const c of ['anchor_id', 'anchor_hash', 'pruned_count']) {
    assert.ok(first.logs.some((l) => l.includes(`repaired activity_log_chain.${c}`)), `logged ${c}: ${first.logs.join(' | ')}`);
  }
  assert.ok(!first.logs.some((l) => l.startsWith('ERROR')), first.logs.join(' | '));
  const row = await chainRow();
  assert.equal(row.anchor_id, null);
  assert.equal(row.anchor_hash, null);
  assert.equal(Number(row.pruned_count), 0);

  const second = await run();
  assert.deepEqual(second.missing, []);
  assert.deepEqual(second.logs, [], 'second run changes nothing');
});

test('route: admin-only, awaited counts, 500 on failure, audit-logged', async () => {
  await reset();

  // Non-admin: 403, and the refusal itself is audit-logged.
  const denied = await req('DELETE', '/api/activity/prune', { token: member.token });
  assert.equal(denied.status, 403);
  assert.equal(denied.json.success, undefined);

  // Nothing old enough.
  let r = await req('DELETE', '/api/activity/prune', { token: admin.token });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.success, true);
  assert.equal(r.json.pruned, 0);
  assert.equal(r.json.anchor_id, null);
  assert.equal(typeof r.json.cutoff, 'number');

  await waitFor(() => countAction('DELETE /api/activity/prune'), 1);
  await waitFor(() => countAction('ACCESS_DENIED DELETE /api/activity/prune'), 1);

  await reset();
  const old = await seed([OLD(), OLD(), OLD()]);
  await seed([NEW()]);

  // Forced failure: 500, never success:true, nothing removed.
  await withPrunedInsertBlocked(async () => {
    const failed = await req('DELETE', '/api/activity/prune', { token: admin.token });
    assert.equal(failed.status, 500, failed.text);
    assert.equal(failed.json.success, undefined);
    assert.equal(typeof failed.json.error, 'string');
  });
  assert.equal((await ids()).length, 4);

  r = await req('DELETE', '/api/activity/prune', { token: admin.token });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual({ ...r.json, cutoff: undefined }, { success: true, pruned: 3, anchor_id: old[2], cutoff: undefined });
  assert.ok(Math.abs(r.json.cutoff - cutoffNow()) < 60);

  const [entry] = await prunedRows();
  assert.equal(entry.user_id, admin.id, 'audit:pruned is attributed to the acting admin');
  await waitFor(() => countAction('DELETE /api/activity/prune'), 1);
  const logged = await db.prepare("SELECT user_id FROM activity_log WHERE action = 'DELETE /api/activity/prune'").get();
  assert.equal(logged.user_id, admin.id);

  const report = await verifyChain(db);
  assert.equal(report.ok, true, JSON.stringify(report.failures));

  // The service path the route uses computes the cutoff from config.
  const direct = await pruneActivityLog(admin.id);
  assert.equal(direct.pruned, 0);
});

async function countAction(action) {
  return Number((await db.prepare('SELECT COUNT(*) AS n FROM activity_log WHERE action = ?').get(action)).n);
}

// Request audit rows are written fire-and-forget after the response: poll.
async function waitFor(fn, want) {
  const deadline = Date.now() + 8000;
  for (;;) {
    const got = await fn();
    if (got >= want || Date.now() > deadline) {
      assert.ok(got >= want, `expected >= ${want}, got ${got}`);
      return got;
    }
    await sleep(50);
  }
}
