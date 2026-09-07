'use strict';

// Ref 50 — GET /api/dashboard/content/:contentId/plays (proof-of-play timeline).
//
// Same harness as dashboard-content-export.test.js: in-memory sqlite swapped in
// for ../db/database, the REAL Express app with the real requireAuth +
// resolveTenancy chain, mounted exactly as server.js mounts dashboard-content.
// Two tenants, a device + play_logs in each. Asserts: the endpoint returns the
// caller's own individual play rows (device name joined, newest-first, capped),
// never the other tenant's; unknown / cross-tenant content ids yield an empty
// timeline, not a leak or a 500.

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

process.env.JWT_SECRET = 'test-secret-dashboard-content-plays';

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE users (
    id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT DEFAULT '',
    password_hash TEXT, auth_provider TEXT NOT NULL DEFAULT 'local', avatar_url TEXT,
    role TEXT NOT NULL DEFAULT 'user', plan_id TEXT DEFAULT 'free', email_alerts INTEGER DEFAULT 1,
    must_change_password INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE organizations (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_user_id TEXT NOT NULL
  );
  CREATE TABLE organization_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT, organization_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL
  );
  CREATE TABLE workspaces (
    id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, name TEXT NOT NULL
  );
  CREATE TABLE workspace_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, user_id TEXT NOT NULL,
    role TEXT NOT NULL, joined_at INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE devices (
    id TEXT PRIMARY KEY, workspace_id TEXT, name TEXT DEFAULT '', status TEXT DEFAULT 'offline'
  );
  CREATE TABLE play_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL, content_id TEXT, widget_id TEXT,
    zone_id TEXT, content_name TEXT NOT NULL DEFAULT '', started_at INTEGER NOT NULL, ended_at INTEGER,
    duration_sec INTEGER, completed INTEGER NOT NULL DEFAULT 0, trigger_type TEXT DEFAULT 'playlist',
    created_at INTEGER NOT NULL DEFAULT 0, session_id TEXT
  );
`);

const dbModulePath = require.resolve('../db/database');
require.cache[dbModulePath] = { id: dbModulePath, filename: dbModulePath, loaded: true, exports: { db } };

const express = require('express');
const { generateToken, requireAuth } = require('../middleware/auth');
const { resolveTenancy } = require('../lib/tenancy');

// --- Seed two tenants -------------------------------------------------------
db.prepare("INSERT INTO users (id, email, role) VALUES ('user-a', 'a@tenant-a.test', 'user')").run();
db.prepare("INSERT INTO users (id, email, role) VALUES ('user-b', 'b@tenant-b.test', 'user')").run();
db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES ('org-a', 'Org A', 'user-a')").run();
db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES ('org-b', 'Org B', 'user-b')").run();
db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES ('ws-a', 'org-a', 'Workspace A')").run();
db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES ('ws-b', 'org-b', 'Workspace B')").run();
db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('ws-a', 'user-a', 'workspace_admin')").run();
db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('ws-b', 'user-b', 'workspace_admin')").run();
db.prepare("INSERT INTO devices (id, workspace_id, name) VALUES ('device-a', 'ws-a', 'Lobby A')").run();
db.prepare("INSERT INTO devices (id, workspace_id, name) VALUES ('device-b', 'ws-b', 'Lobby B')").run();

const now = Math.floor(Date.now() / 1000);
const play = (device, cid, name, offset, dur, done) =>
  db.prepare(
    "INSERT INTO play_logs (device_id, content_id, content_name, started_at, ended_at, duration_sec, completed) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(device, cid, name, now - offset, dur === null ? null : now - offset + dur, dur, done);

// Shared content id across both tenants — the canary: /plays for 'shared-cid'
// must return ONLY the caller's own device's rows.
play('device-a', 'shared-cid', 'TENANT-A Promo', 300, 30, 1); // newest for A
play('device-a', 'shared-cid', 'TENANT-A Promo', 900, null, 0); // play-start only, no duration
play('device-a', 'shared-cid', 'TENANT-A Promo', 1800, 12, 0);
play('device-b', 'shared-cid', 'TENANT-B Promo', 120, 45, 1); // B's row — newer than any of A's
play('device-b', 'other-cid', 'TENANT-B Other', 60, 5, 1);

const tokA = generateToken({ id: 'user-a', email: 'a@tenant-a.test', role: 'user' }, 'ws-a');
const tokB = generateToken({ id: 'user-b', email: 'b@tenant-b.test', role: 'user' }, 'ws-b');

const app = express();
app.use(express.json());
app.use('/api/dashboard/content', requireAuth, resolveTenancy, require('../routes/dashboard-content'));
app.use((err, req, res, _next) => {
  res.status(500).json({ error: err.message });
});

const server = app.listen(0);
let base;
test.before(async () => {
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => {
  server.close();
  db.close();
});

const authed = (token) => ({ headers: { Authorization: `Bearer ${token}` } });
async function plays(token, cid) {
  const res = await fetch(`${base}/api/dashboard/content/${encodeURIComponent(cid)}/plays`, authed(token));
  return { res, body: await res.json() };
}

test('returns the caller\'s own individual play rows, newest-first, device name joined', async () => {
  const { res, body } = await plays(tokA, 'shared-cid');
  assert.equal(res.status, 200);
  assert.equal(body.content_id, 'shared-cid');
  assert.equal(body.plays.length, 3);
  assert.deepEqual(
    body.plays.map((p) => p.started_at),
    [...body.plays.map((p) => p.started_at)].sort((a, b) => b - a),
  );
  assert.ok(body.plays.every((p) => p.device_name === 'Lobby A'));
  assert.equal(body.plays[0].completed, true);
  assert.equal(body.plays[0].duration_sec, 30);
  // play-start-only row survives with a null duration, not dropped
  assert.ok(body.plays.some((p) => p.duration_sec === null));
});

test('cross-tenant: tenant A never sees tenant B\'s rows for a shared content id', async () => {
  const { body } = await plays(tokA, 'shared-cid');
  assert.ok(body.plays.every((p) => p.device_name === 'Lobby A'));
  assert.ok(!JSON.stringify(body).includes('TENANT-B'));
  assert.ok(!JSON.stringify(body).includes('Lobby B'));
});

test('cross-tenant: tenant B sees only its own single row for the shared content id', async () => {
  const { body } = await plays(tokB, 'shared-cid');
  assert.equal(body.plays.length, 1);
  assert.equal(body.plays[0].device_name, 'Lobby B');
  assert.equal(body.content_name, 'TENANT-B Promo');
});

test('content id that exists only in the other tenant -> empty timeline, not a leak', async () => {
  const { res, body } = await plays(tokA, 'other-cid');
  assert.equal(res.status, 200);
  assert.deepEqual(body.plays, []);
  assert.equal(body.content_name, null);
});

test('unknown content id -> empty timeline, 200 not 500', async () => {
  const { res, body } = await plays(tokA, 'does-not-exist');
  assert.equal(res.status, 200);
  assert.deepEqual(body.plays, []);
});

test('token with no explicit workspace still only ever yields the user\'s own rows', async () => {
  // resolveTenancy falls back to the user's own membership, so user-A here
  // resolves to ws-A - the point is it can NEVER resolve to ws-B's rows.
  const tokNoWs = generateToken({ id: 'user-a', email: 'a@tenant-a.test', role: 'user' }, null);
  const res = await fetch(`${base}/api/dashboard/content/shared-cid/plays`, authed(tokNoWs));
  if (res.status === 200) {
    const body = await res.json();
    assert.ok(body.plays.every((p) => p.device_name === 'Lobby A'));
    assert.ok(!JSON.stringify(body).includes('Lobby B'));
  } else {
    assert.ok([400, 401, 403].includes(res.status));
  }
});
