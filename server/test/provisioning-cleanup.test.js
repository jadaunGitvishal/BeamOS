'use strict';

// #142 (cut 2) — provisioning-row cleanup window correctness. The sweep deletes
// UNCLAIMED provisioning devices older than 24h (it previously used 365*86400 — a
// year — contradicting its own comment). Imported devices (user_id set) and
// non-provisioning devices are preserved. Deterministic, in-process (no server).
//
// Runs against the REAL MySQL database, so it only ever touches rows it created:
// every seeded id carries a per-run prefix, assertions and cleanup are scoped to it,
// and because pruneProvisioningDevices() is a GLOBAL sweep (services/heartbeat.js),
// each test first checks that no OTHER row matches the sweep's criteria and skips
// if one does, rather than letting the sweep delete it.

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-provclean-' + crypto.randomBytes(4).toString('hex'));

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const { pruneProvisioningDevices } = require('../services/heartbeat');

const PREFIX = `pc-test-${crypto.randomBytes(4).toString('hex')}-`;
const LIKE = `${PREFIX}%`;
const USER_ID = `${PREFIX}user`;
const now = () => Math.floor(Date.now() / 1000);

// Rows OTHER than this test's that the global sweep would delete. The cutoff is a
// minute later than the sweep's own (now - 24h), so a row crossing the 24h line
// between this check and the sweep is counted too.
async function foreignSweepable() {
  const cutoff = now() - 24 * 3600 + 60;
  const row = await db.prepare(`
    SELECT COUNT(*) AS n FROM devices
    WHERE status = 'provisioning' AND user_id IS NULL AND created_at < ? AND id NOT LIKE ?
  `).get(cutoff, LIKE);
  return Number(row.n);
}

const ownIds = async () =>
  (await db.prepare('SELECT id FROM devices WHERE id LIKE ? ORDER BY id').all(LIKE)).map((r) => r.id);

after(async () => {
  try {
    // devices.user_id -> users(id) has no ON DELETE, so devices go first.
    await db.prepare('DELETE FROM devices WHERE id LIKE ?').run(LIKE);
    await db.prepare('DELETE FROM users WHERE id = ?').run(USER_ID);
  } finally {
    await db.close();
  }
});

test('sweeps unclaimed provisioning devices older than 24h, keeps the rest', async (t) => {
  const foreign = await foreignSweepable();
  if (foreign > 0) {
    t.skip(`${foreign} device row(s) not created by this test match the global sweep's criteria; skipping so the sweep can't delete them`);
    return;
  }

  // A real owner for the "imported" device, so the user_id FK holds without disabling checks.
  await db.prepare('INSERT INTO users (id, email, name) VALUES (?, ?, ?)')
    .run(USER_ID, `${PREFIX}imported@pc-test.local`, 'provisioning-cleanup test');
  const ins = db.prepare('INSERT INTO devices (id, status, user_id, created_at) VALUES (?, ?, ?, ?)');
  const t0 = now();
  await ins.run(`${PREFIX}old-unclaimed`, 'provisioning', null, t0 - 25 * 3600);   // >24h, unclaimed  -> SWEPT
  await ins.run(`${PREFIX}new-unclaimed`, 'provisioning', null, t0 - 1 * 3600);    // <24h, unclaimed  -> kept
  await ins.run(`${PREFIX}old-imported`, 'provisioning', USER_ID, t0 - 25 * 3600); // >24h but imported (user_id) -> kept
  await ins.run(`${PREFIX}old-online`, 'online', null, t0 - 25 * 3600);            // >24h but not provisioning -> kept

  assert.equal((await ownIds()).length, 4, 'seeded 4');

  const deleted = await pruneProvisioningDevices();
  assert.equal(deleted, 1, 'only the >24h unclaimed provisioning device is swept');

  assert.deepEqual(await ownIds(), [`${PREFIX}new-unclaimed`, `${PREFIX}old-imported`, `${PREFIX}old-online`]);
  // regression guard: a 25h-old row sits well inside the OLD 365-day window, so this
  // would have survived before the fix.
});

test('idempotent: a second sweep with nothing stale deletes nothing', async (t) => {
  const foreign = await foreignSweepable();
  if (foreign > 0) {
    t.skip(`${foreign} device row(s) not created by this test match the global sweep's criteria; skipping so the sweep can't delete them`);
    return;
  }
  const before = await ownIds();
  assert.equal(await pruneProvisioningDevices(), 0);
  assert.deepEqual(await ownIds(), before, "this test's remaining rows are untouched");
});
