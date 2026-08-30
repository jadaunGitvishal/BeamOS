'use strict';

// Ref 30 Stage 2: device self-claim with a pre-generated registration code.
//
// Drives the REAL claimRouter (routes/registration-codes.js) mounted exactly as
// server.js mounts it - on its own public path, NO requireAuth - against an
// in-memory better-sqlite3 DB. Because claimRouter uses db.transaction(), the DB
// stand-in here reproduces the production db/database.js handle shape
// (async .prepare().{get,all,run} + .transaction(fn) -> async runner that hands
// fn a tx handle), not the raw better-sqlite3 object. Covers:
//   - happy path with and without a planned_device_name (workspace + name assignment)
//   - the device row lands in the exact end state the pairing_code flow produces
//   - fingerprint linking (insert + update-on-reclaim)
//   - error handling: unknown code, already-claimed code, malformed code
//   - a code can be claimed exactly once (no double-claim, no second device row)
//   - device_info persistence + workspace scoping
//   - the Stage 1 admin list then shows the code 'claimed' with the device name

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

process.env.JWT_SECRET = 'test-secret-registration-code-claim';

const raw = new Database(':memory:');
raw.exec(`
  CREATE TABLE users (
    id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT DEFAULT '',
    role TEXT NOT NULL DEFAULT 'user'
  );
  CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_user_id TEXT NOT NULL);
  CREATE TABLE workspaces (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, name TEXT NOT NULL);
  CREATE TABLE workspace_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL
  );
  CREATE TABLE organization_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT, organization_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL
  );
  CREATE TABLE devices (
    id TEXT PRIMARY KEY, user_id TEXT, workspace_id TEXT,
    name TEXT NOT NULL DEFAULT 'Unnamed Display', pairing_code TEXT UNIQUE,
    status TEXT NOT NULL DEFAULT 'offline', blocked INTEGER NOT NULL DEFAULT 0,
    last_heartbeat INTEGER, ip_address TEXT, android_version TEXT, app_version TEXT,
    screen_width INTEGER, screen_height INTEGER, render_width INTEGER, render_height INTEGER,
    device_token TEXT, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE device_fingerprints (
    fingerprint TEXT PRIMARY KEY, device_id TEXT, user_id TEXT,
    first_seen INTEGER NOT NULL DEFAULT 0, last_seen INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE registration_codes (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    workspace_id TEXT NOT NULL,
    planned_device_name TEXT,
    status TEXT NOT NULL DEFAULT 'unused',
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    claimed_by_device_id TEXT,
    claimed_at INTEGER
  );
`);

// Reproduce the db/database.js handle: promise-returning .prepare().{get,all,run}
// (run -> { changes, lastInsertRowid }), .exec, and .transaction(fn) returning an
// async runner that passes fn a tx handle of the same shape and commits/rolls back.
function shimDb(sqlite) {
  const mkStmt = (sql) => ({
    get: async (...p) => sqlite.prepare(sql).get(...p),
    all: async (...p) => sqlite.prepare(sql).all(...p),
    run: async (...p) => {
      const r = sqlite.prepare(sql).run(...p);
      return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
    },
  });
  const handle = { prepare: mkStmt, exec: async (sql) => sqlite.exec(sql) };
  return {
    ...handle,
    transaction(fn) {
      return async (...args) => {
        sqlite.exec('BEGIN');
        try {
          const res = await fn(handle, ...args);
          sqlite.exec('COMMIT');
          return res;
        } catch (e) {
          try { sqlite.exec('ROLLBACK'); } catch (_) { /* */ }
          throw e;
        }
      };
    },
  };
}
const db = shimDb(raw);

const dbModulePath = require.resolve('../db/database');
require.cache[dbModulePath] = { id: dbModulePath, filename: dbModulePath, loaded: true, exports: { db } };

const express = require('express');
const registrationCodes = require('../routes/registration-codes');

// --- Seed ------------------------------------------------------------------
raw.prepare("INSERT INTO users (id, email, role) VALUES ('u-admin', 'admin@a.test', 'user')").run();
raw.prepare("INSERT INTO users (id, email, role) VALUES ('u-admin-b', 'admin@b.test', 'user')").run();
raw.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES ('org-a', 'Org A', 'u-admin')").run();
raw.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES ('org-b', 'Org B', 'u-admin-b')").run();
raw.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES ('ws-a', 'org-a', 'Workspace A')").run();
raw.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES ('ws-b', 'org-b', 'Workspace B')").run();
raw.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('ws-a', 'u-admin', 'workspace_admin')").run();
raw.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('ws-b', 'u-admin-b', 'workspace_admin')").run();

let codeSeq = 100000;
function seedCode(overrides = {}) {
  const row = {
    id: 'rc-' + (codeSeq),
    code: String(codeSeq++),
    workspace_id: 'ws-a',
    planned_device_name: null,
    status: 'unused',
    created_by: 'u-admin',
    created_at: 1700000000,
    claimed_by_device_id: null,
    claimed_at: null,
    ...overrides,
  };
  raw.prepare(`INSERT INTO registration_codes
    (id, code, workspace_id, planned_device_name, status, created_by, created_at, claimed_by_device_id, claimed_at)
    VALUES (@id, @code, @workspace_id, @planned_device_name, @status, @created_by, @created_at, @claimed_by_device_id, @claimed_at)`).run(row);
  return row;
}

// --- App: mount claimRouter exactly as server.js does (public, no auth) ----
const app = express();
app.use(express.json());
app.use('/api/provisioning/registration-codes/claim', registrationCodes.claimRouter);
app.use('/api/provisioning', (req, res, next) => { req.user = { id: 'u-admin', role: 'user' }; next(); }, registrationCodes); // Stage 1 list, for the cross-check test
app.use((err, req, res, _next) => { res.status(500).json({ error: err.message }); });

const server = app.listen(0);
let base;
test.before(async () => {
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); raw.close(); });

const claim = (body) => fetch(`${base}/api/provisioning/registration-codes/claim`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

test('claim: happy path with a planned_device_name assigns workspace + that name', async () => {
  const rc = seedCode({ planned_device_name: 'Lobby screen — 2nd floor' });
  const res = await claim({
    code: rc.code,
    device_info: { android_version: '13', app_version: '2.1.0', screen_width: 1920, screen_height: 1080 },
    fingerprint: 'fp-lobby',
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.match(body.device_token, /^[0-9a-f]{64}$/, 'a 32-byte hex device token is issued');
  assert.equal(body.name, 'Lobby screen — 2nd floor');
  assert.equal(body.workspace_id, 'ws-a');
  assert.equal(body.status, 'online');

  const dev = raw.prepare('SELECT * FROM devices WHERE id = ?').get(body.device_id);
  assert.ok(dev, 'device row created');
  assert.equal(dev.workspace_id, 'ws-a');
  assert.equal(dev.user_id, 'u-admin', 'device.user_id = the code creator (so device:paired re-sends on reconnect)');
  assert.equal(dev.name, 'Lobby screen — 2nd floor');
  assert.equal(dev.status, 'online');
  assert.equal(dev.pairing_code, null);
  assert.equal(dev.device_token, body.device_token);
  assert.equal(dev.android_version, '13');
  assert.equal(dev.app_version, '2.1.0');
  assert.equal(dev.screen_width, 1920);

  const after = raw.prepare('SELECT * FROM registration_codes WHERE id = ?').get(rc.id);
  assert.equal(after.status, 'claimed');
  assert.equal(after.claimed_by_device_id, body.device_id);
  assert.ok(after.claimed_at > 0, 'claimed_at stamped');

  const fp = raw.prepare('SELECT * FROM device_fingerprints WHERE fingerprint = ?').get('fp-lobby');
  assert.equal(fp.device_id, body.device_id);
  assert.equal(fp.user_id, 'u-admin');
});

test('claim: no planned_device_name -> device still assigned, gets a default name', async () => {
  const rc = seedCode({ planned_device_name: null });
  const res = await claim({ code: rc.code });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.workspace_id, 'ws-a');
  assert.match(body.name, /^Display \d+$/, 'default "Display N" name, settable later like normal');
  const dev = raw.prepare('SELECT workspace_id, name FROM devices WHERE id = ?').get(body.device_id);
  assert.equal(dev.workspace_id, 'ws-a');
  assert.equal(dev.name, body.name);
});

test('claim: unknown code -> 404 with a clear message, no device created', async () => {
  const before = raw.prepare('SELECT COUNT(*) AS n FROM devices').get().n;
  const res = await claim({ code: '000001' });
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /not recognised|typo/i);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM devices').get().n, before, 'no device row');
});

test('claim: already-claimed code -> 409 with a clear message', async () => {
  const rc = seedCode();
  const first = await claim({ code: rc.code });
  assert.equal(first.status, 201);
  const firstDeviceId = (await first.json()).device_id;

  const before = raw.prepare('SELECT COUNT(*) AS n FROM devices').get().n;
  const second = await claim({ code: rc.code });
  assert.equal(second.status, 409);
  assert.match((await second.json()).error, /already been used/i);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM devices').get().n, before, 'no second device row');

  // The code still points at the first device only.
  const after = raw.prepare('SELECT * FROM registration_codes WHERE id = ?').get(rc.id);
  assert.equal(after.claimed_by_device_id, firstDeviceId);
});

test('claim: malformed code -> 400', async () => {
  for (const bad of ['12345', '1234567', 'abcdef', '', undefined]) {
    const res = await claim({ code: bad });
    assert.equal(res.status, 400, `"${bad}" rejected`);
  }
});

test('claim: a code can be claimed exactly once across repeated attempts', async () => {
  const rc = seedCode();
  const results = [];
  for (let i = 0; i < 5; i++) results.push(await claim({ code: rc.code }));
  const ok = results.filter((r) => r.status === 201);
  const conflict = results.filter((r) => r.status === 409);
  assert.equal(ok.length, 1, 'exactly one claim succeeds');
  assert.equal(conflict.length, 4, 'the rest get 409');
  assert.equal(
    raw.prepare('SELECT COUNT(*) AS n FROM devices WHERE id = ?').get((await ok[0].json()).device_id).n,
    1,
  );
});

test('claim: fingerprint is re-linked to the newest device on a later claim', async () => {
  const rc1 = seedCode();
  const rc2 = seedCode();
  const d1 = await (await claim({ code: rc1.code, fingerprint: 'fp-shared' })).json();
  const d2 = await (await claim({ code: rc2.code, fingerprint: 'fp-shared' })).json();
  assert.notEqual(d1.device_id, d2.device_id);
  const rows = raw.prepare('SELECT * FROM device_fingerprints WHERE fingerprint = ?').all('fp-shared');
  assert.equal(rows.length, 1, 'one fingerprint row, not a duplicate');
  assert.equal(rows[0].device_id, d2.device_id, 're-pointed at the most recent device');
});

test('claim: workspace scoping - a ws-b code lands the device in ws-b', async () => {
  const rc = seedCode({ workspace_id: 'ws-b', created_by: 'u-admin-b', planned_device_name: 'B lobby' });
  const body = await (await claim({ code: rc.code })).json();
  assert.equal(body.workspace_id, 'ws-b');
  const dev = raw.prepare('SELECT workspace_id, user_id FROM devices WHERE id = ?').get(body.device_id);
  assert.equal(dev.workspace_id, 'ws-b');
  assert.equal(dev.user_id, 'u-admin-b');
});

test('claim: code for a since-deleted workspace -> 409, no orphan device', async () => {
  const rc = seedCode({ workspace_id: 'ws-gone' });
  const before = raw.prepare('SELECT COUNT(*) AS n FROM devices').get().n;
  const res = await claim({ code: rc.code });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /workspace/i);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM devices').get().n, before);
});

test('cross-check: after a claim, the Stage 1 list shows the code claimed + device name', async () => {
  const rc = seedCode({ planned_device_name: 'Reception TV' });
  const body = await (await claim({ code: rc.code })).json();
  const list = await fetch(`${base}/api/provisioning/registration-codes?workspace_id=ws-a`).then((r) => r.json());
  const row = list.find((c) => c.code === rc.code);
  assert.equal(row.status, 'claimed');
  assert.equal(row.claimed_by_device_id, body.device_id);
  assert.equal(row.claimed_by_device_name, 'Reception TV');
  // device_token must never appear in the admin listing.
  assert.ok(!('device_token' in row));
});
