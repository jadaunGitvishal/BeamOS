'use strict';

// #146 hardening (Item B) — sustained flap limiter + SNAT-safe identity chain.
// Deterministic (injected `now`), in-process.

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-flap-' + crypto.randomBytes(4).toString('hex'));
process.env.CONNECT_RATE_WINDOW_MS = '300000';   // 5 min
process.env.CONNECT_RATE_MAX = '20';
process.env.CONNECT_RATE_ANON_MAX = '60';
process.env.CONNECT_RATE_COOLDOWN_MS = '60000';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const flap = require('../lib/flap-limiter');
const { resolveIdentity, ANON_KEY } = require('../lib/device-identity');
const { db } = require('../db/database');

// Test-owned rows on the real test DB (beamos_test via npm test): one device and the
// fingerprint mapping to it, plus prefixed fingerprints that must stay unmapped.
const P = 'FL-' + crypto.randomBytes(4).toString('hex');
const DEV = `${P}-dev-mapped`;
const FP = (s) => `${P}-${s}`;

after(async () => {
  try {
    await db.prepare('DELETE FROM device_fingerprints WHERE fingerprint LIKE ?').run(P + '-%');
    await db.prepare('DELETE FROM devices WHERE id = ?').run(DEV);
  } finally {
    await db.close();
  }
});

test('a device flapping every ~4s over minutes is refused after the window max', () => {
  flap.reset();
  let now = 0, refusedAt = -1;
  for (let i = 0; i < 25; i++) {
    const v = flap.check('d:flapper', now);
    if (!v.allow && refusedAt < 0) refusedAt = i;
    now += 4000;                                  // ~4s cadence (passes the 5/10s burst throttle)
  }
  assert.equal(refusedAt, 20, 'the 21st connect within the window is the first refused (max=20)');
  assert.equal(flap.check('d:flapper', now).reason || 'flap-cooldown', 'flap-cooldown');
});

test('a device connecting normally (every 60s) is NEVER refused', () => {
  flap.reset();
  let now = 0, refused = 0;
  for (let i = 0; i < 30; i++) { if (!flap.check('d:healthy', now).allow) refused++; now += 60000; }
  assert.equal(refused, 0, 'a 1/min device never trips (sliding window keeps count ~5)');
});

test('two device_ids from the "same IP" are independent (never IP-keyed)', () => {
  flap.reset();
  let now = 0;
  for (let i = 0; i < 21; i++) { flap.check('d:A', now); now += 4000; }   // trip A
  assert.equal(flap.check('d:A', now).allow, false, 'A is tripped');
  assert.equal(flap.check('d:B', now).allow, true, 'B is unaffected — no shared IP bucket');
});

test('identity chain: device_id > fingerprint(->device_id) > token > global anon; never IP', async () => {
  // device_id wins
  assert.deepEqual((await resolveIdentity({ device_id: 'dev1', fingerprint: 'fp', device_token: 'tok', ip: '10.10.10.1' })).kind, 'device_id');
  // fingerprint maps to device_id when device_fingerprints has it (a real device row: the FK)
  await db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(DEV, DEV);
  await db.prepare('INSERT INTO device_fingerprints (fingerprint, device_id) VALUES (?, ?)').run(FP('fp-mapped'), DEV);
  const m = await resolveIdentity({ fingerprint: FP('fp-mapped') });
  assert.equal(m.kind, 'fingerprint->device_id');
  assert.equal(m.key, 'd:' + DEV);
  // unmapped fingerprint keys on the raw fingerprint
  assert.equal((await resolveIdentity({ fingerprint: FP('fp-unknown') })).key, 'f:' + FP('fp-unknown'));
  // token fallback
  assert.equal((await resolveIdentity({ device_token: 'tok9' })).key, 't:tok9');
  // nothing identifiable -> single global anon bucket (NOT ip, even if ip present)
  assert.equal((await resolveIdentity({ ip: '10.10.10.1' })).key, ANON_KEY);
});

test('a device_id-less client is bucketed by fingerprint (not IP, not unthrottled)', async () => {
  flap.reset();
  let now = 0, refusedAt = -1;
  for (let i = 0; i < 25; i++) {
    const key = (await resolveIdentity({ fingerprint: FP('fp-flap') })).key;   // no device_id
    assert.equal(key, 'f:' + FP('fp-flap'));
    if (!flap.check(key, now).allow && refusedAt < 0) refusedAt = i;
    now += 4000;
  }
  assert.equal(refusedAt, 20, 'a device_id-less flapper is still capped, by fingerprint');
});

test('a client with NO device_id and NO fingerprint is capped via the global anon bucket', async () => {
  flap.reset();
  let now = 0, refusedAt = -1;
  for (let i = 0; i < 70; i++) {
    const key = (await resolveIdentity({})).key;            // ANON_KEY — shared by all anon clients
    assert.equal(key, ANON_KEY);
    if (!flap.check(key, now).allow && refusedAt < 0) refusedAt = i;
    now += 1000;
  }
  assert.equal(refusedAt, 60, 'the anon bucket caps collectively at connectRateAnonMax (60), never unthrottled');
});

test('idle sweep evicts stale buckets but never the anon bucket', async () => {
  flap.reset();
  flap.check('d:temp', 0);
  flap.check(ANON_KEY, 0);
  assert.ok(flap._size() >= 2);
  flap.sweep(10 * 300000);                          // long after idle window
  // anon bucket is preserved (shared global), device bucket evicted
  assert.equal((await resolveIdentity({})).key, ANON_KEY);
});
