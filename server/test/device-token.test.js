'use strict';

// Ref 2 Stage 3: devices.device_token stored as a one-way 'sha256:' hash
// (lib/device-token.js), legacy plaintext rows still verified, and the
// scripts/hash-device-tokens.js backfill.
//
//   A. lib/device-token.js units.
//   B. backfillDeviceTokens() core against an in-memory SQLite shim - NEVER the
//      real DB: the backfill is irreversible and would hash every real device.
//   C. A REAL server.js subprocess (test/helpers/spawn-server.js) + real socket.io device client:
//      first pairing stores the hash, reconnect with the raw token works and the
//      echoed token is unchanged, a legacy plaintext row still works and is NOT
//      silently rewritten, a wrong token is refused.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const { generateDeviceToken, hashDeviceToken, verifyDeviceToken, isHashed, HASH_PREFIX } = require('../lib/device-token');
const { backfillDeviceTokens } = require('../scripts/hash-device-tokens');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ------------------------------------------------------------------ A. units

test('hashDeviceToken: "sha256:" + SHA-256 hex, distinguishable from a raw 64-hex token', () => {
  const t = generateDeviceToken();
  assert.match(t, /^[0-9a-f]{64}$/);
  assert.equal(hashDeviceToken(t), HASH_PREFIX + sha(t));
  assert.equal(isHashed(hashDeviceToken(t)), true);
  assert.equal(isHashed(t), false, 'a raw token must never look hashed');
});

test('verifyDeviceToken: hashed row and legacy plaintext row both verify the raw token', () => {
  const t = generateDeviceToken();
  assert.equal(verifyDeviceToken(hashDeviceToken(t), t), true);
  assert.equal(verifyDeviceToken(t, t), true, 'legacy plaintext row');
});

test('verifyDeviceToken: rejects wrong/empty/missing values without throwing', () => {
  const t = generateDeviceToken();
  const h = hashDeviceToken(t);
  for (const [stored, presented] of [[h, generateDeviceToken()], [t, generateDeviceToken()], [h, ''], [h, null], [null, t], ['', t], [t, 'short'], [h, 123]]) {
    assert.equal(verifyDeviceToken(stored, presented), false, JSON.stringify([stored, presented]));
  }
  assert.equal(verifyDeviceToken(h, h), false, 'presenting the stored HASH itself must not authenticate');
});

// ---------------------------------------------------- B. backfill core (SQLite)

function shimDb({ onAfterSelect } = {}) {
  const sqlite = new Database(':memory:');
  sqlite.exec('CREATE TABLE devices (id TEXT PRIMARY KEY, device_token TEXT)');
  const db = {
    sqlite,
    prepare(sql) {
      const st = sqlite.prepare(sql);
      return {
        async all(...p) { const r = st.all(...p); if (onAfterSelect) onAfterSelect(sqlite); return r; },
        async get(...p) { return st.get(...p); },
        async run(...p) { return st.run(...p); },
      };
    },
  };
  return db;
}

test('backfill --dry-run counts but writes nothing', async () => {
  const db = shimDb();
  const t1 = generateDeviceToken(), t2 = generateDeviceToken();
  db.sqlite.prepare('INSERT INTO devices VALUES (?, ?)').run('p1', t1);
  db.sqlite.prepare('INSERT INTO devices VALUES (?, ?)').run('h1', hashDeviceToken(t2));
  db.sqlite.prepare('INSERT INTO devices VALUES (?, ?)').run('n1', null);
  const c = await backfillDeviceTokens(db, { dryRun: true });
  assert.deepEqual(c, { total: 3, alreadyHashed: 1, empty: 1, plaintext: 1, converted: 0, changedConcurrently: 0 });
  assert.equal(db.sqlite.prepare("SELECT device_token FROM devices WHERE id='p1'").get().device_token, t1);
});

test('backfill --yes hashes plaintext rows so the SAME raw token still verifies; idempotent', async () => {
  const db = shimDb();
  const raw = { p1: generateDeviceToken(), p2: generateDeviceToken() };
  for (const [id, t] of Object.entries(raw)) db.sqlite.prepare('INSERT INTO devices VALUES (?, ?)').run(id, t);
  const already = generateDeviceToken();
  db.sqlite.prepare('INSERT INTO devices VALUES (?, ?)').run('h1', hashDeviceToken(already));

  const c = await backfillDeviceTokens(db, { dryRun: false });
  assert.equal(c.converted, 2); assert.equal(c.alreadyHashed, 1);
  for (const [id, t] of Object.entries(raw)) {
    const stored = db.sqlite.prepare('SELECT device_token FROM devices WHERE id = ?').get(id).device_token;
    assert.equal(stored, hashDeviceToken(t));
    assert.equal(verifyDeviceToken(stored, t), true);
  }
  assert.equal(db.sqlite.prepare("SELECT device_token FROM devices WHERE id='h1'").get().device_token, hashDeviceToken(already), 'no double-hash');
  assert.deepEqual(await backfillDeviceTokens(db, { dryRun: false }), { total: 3, alreadyHashed: 3, empty: 0, plaintext: 0, converted: 0, changedConcurrently: 0 });
});

test('backfill is compare-and-set: a token re-issued mid-run is not overwritten', async () => {
  const reissued = hashDeviceToken(generateDeviceToken());
  const db = shimDb({ onAfterSelect: (s) => s.prepare("UPDATE devices SET device_token = ? WHERE id = 'p1'").run(reissued) });
  db.sqlite.prepare('INSERT INTO devices VALUES (?, ?)').run('p1', generateDeviceToken());
  const c = await backfillDeviceTokens(db, { dryRun: false });
  assert.equal(c.changedConcurrently, 1); assert.equal(c.converted, 0);
  assert.equal(db.sqlite.prepare("SELECT device_token FROM devices WHERE id='p1'").get().device_token, reissued);
});

// ------------------------------------------- C. real server.js + socket client

let srv, BASE, db, ioClient, cleanupDevices;
const created = [];

function register(payload) {
  return new Promise((resolve) => {
    const sock = ioClient(`${BASE}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
    const got = { registered: false, authError: false, id: null, token: null };
    const finish = () => { try { sock.close(); } catch { /* */ } resolve(got); };
    sock.on('connect', () => sock.emit('device:register', payload));
    sock.on('device:registered', (d) => { got.registered = true; got.id = d.device_id; got.token = d.device_token; setTimeout(finish, 250); });
    sock.on('device:auth-error', () => { got.authError = true; finish(); });
    setTimeout(finish, 4000);
  });
}
const storedToken = async (id) => (await db.prepare('SELECT device_token FROM devices WHERE id = ?').get(id)).device_token;

test.describe('real server: device_token at rest', () => {
  test.before(async () => {
    ({ db } = require('../db/database'));
    ioClient = require('socket.io-client');
    ({ cleanupDevices } = require('./helpers/disposable'));
    const { startServer } = require('./helpers/spawn-server');
    srv = await startServer({ name: 'device-token' });
    BASE = srv.base;
  });
  test.after(async () => {
    if (srv) await srv.stop();
    await cleanupDevices(db, created);
    await db.close();
  });

  let dev;
  test('first pairing: the device gets a raw token; the DB holds only its sha256 hash', async () => {
    const g = await register({ pairing_code: String(crypto.randomInt(100000, 1000000)) });
    assert.equal(g.registered, true);
    created.push(g.id);
    dev = { id: g.id, token: g.token };
    assert.match(g.token, /^[0-9a-f]{64}$/);
    const stored = await storedToken(g.id);
    assert.equal(stored, hashDeviceToken(g.token));
    assert.equal(stored.includes(g.token), false, 'raw token must not be at rest');
  });

  test('reconnect with the raw token authenticates, and the SAME token is echoed back (client unchanged)', async () => {
    const g = await register({ device_id: dev.id, device_token: dev.token });
    assert.equal(g.registered, true);
    assert.equal(g.token, dev.token);
    assert.equal(await storedToken(dev.id), hashDeviceToken(dev.token), 'row unchanged');
  });

  test('presenting the stored HASH (a DB leak) does NOT authenticate', async () => {
    const g = await register({ device_id: dev.id, device_token: hashDeviceToken(dev.token) });
    assert.equal(g.registered, false); assert.equal(g.authError, true);
  });

  test('a wrong token is refused', async () => {
    const g = await register({ device_id: dev.id, device_token: generateDeviceToken() });
    assert.equal(g.registered, false); assert.equal(g.authError, true);
  });

  test('legacy PLAINTEXT row (pre-backfill) still authenticates and is NOT silently rewritten', async () => {
    const legacy = generateDeviceToken();
    await db.prepare('UPDATE devices SET device_token = ? WHERE id = ?').run(legacy, dev.id);
    const g = await register({ device_id: dev.id, device_token: legacy });
    assert.equal(g.registered, true);
    assert.equal(g.token, legacy);
    assert.equal(await storedToken(dev.id), legacy, 'no upgrade-on-auth; only the backfill script converts');
  });
});
