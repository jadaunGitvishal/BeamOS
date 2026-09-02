'use strict';

// Ref 51 Step 4 — GET /api/dashboard/reports/sla-trend
//
// In-memory sqlite + the real requireAuth + resolveTenancy chain, mounted
// exactly as server.js mounts dashboard-reports. device_usage_daily is seeded
// with hand-picked online_seconds so every returned avg_uptime_pct is checkable
// by hand; a second workspace's rows prove the query is workspace-scoped.

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

process.env.JWT_SECRET = 'test-secret-sla-trend';

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE users (
    id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT DEFAULT '',
    password_hash TEXT, auth_provider TEXT NOT NULL DEFAULT 'local', avatar_url TEXT,
    role TEXT NOT NULL DEFAULT 'user', plan_id TEXT DEFAULT 'free', email_alerts INTEGER DEFAULT 1,
    must_change_password INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_user_id TEXT NOT NULL);
  CREATE TABLE organization_members (id INTEGER PRIMARY KEY AUTOINCREMENT, organization_id TEXT, user_id TEXT, role TEXT);
  CREATE TABLE workspaces (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, name TEXT NOT NULL);
  CREATE TABLE workspace_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, user_id TEXT NOT NULL,
    role TEXT NOT NULL, joined_at INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE devices (id TEXT PRIMARY KEY, workspace_id TEXT, name TEXT DEFAULT '', status TEXT DEFAULT 'offline');
  CREATE TABLE device_usage_daily (
    device_id TEXT NOT NULL, day TEXT NOT NULL, online_seconds INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (device_id, day)
  );
`);

const dbModulePath = require.resolve('../db/database');
require.cache[dbModulePath] = { id: dbModulePath, filename: dbModulePath, loaded: true, exports: { db } };

const express = require('express');
const { generateToken, requireAuth } = require('../middleware/auth');
const { resolveTenancy } = require('../lib/tenancy');

db.prepare("INSERT INTO users (id, email, role) VALUES ('user-a', 'a@t.test', 'user')").run();
db.prepare("INSERT INTO users (id, email, role) VALUES ('user-b', 'b@t.test', 'user')").run();
db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES ('org-a', 'A', 'user-a')").run();
db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES ('org-b', 'B', 'user-b')").run();
db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES ('ws-a', 'org-a', 'WS A')").run();
db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES ('ws-b', 'org-b', 'WS B')").run();
db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('ws-a', 'user-a', 'workspace_admin')").run();
db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('ws-b', 'user-b', 'workspace_admin')").run();

for (const id of ['a1', 'a2', 'a3']) db.prepare("INSERT INTO devices (id, workspace_id, name) VALUES (?, 'ws-a', ?)").run(id, id);
db.prepare("INSERT INTO devices (id, workspace_id, name) VALUES ('b1', 'ws-b', 'b1')").run();

const dayStr = (agoDays) => new Date(Date.now() - agoDays * 86400000).toISOString().slice(0, 10);
const D0 = dayStr(0), D1 = dayStr(1), D2 = dayStr(2), D3 = dayStr(3);
const usage = (device, day, sec) =>
  db.prepare('INSERT INTO device_usage_daily (device_id, day, online_seconds) VALUES (?, ?, ?)').run(device, day, sec);

// D3 (oldest): 3 devices at 25% / 50% / 75%  -> avg 50.0
usage('a1', D3, 21600); usage('a2', D3, 43200); usage('a3', D3, 64800);
// D2: only 2 devices reported, 100% / 50%      -> avg 75.0
usage('a1', D2, 86400); usage('a2', D2, 43200);
// D1: 3 devices all at 10%                     -> avg 10.0
usage('a1', D1, 8640); usage('a2', D1, 8640); usage('a3', D1, 8640);
// D0 (today): 3 devices 90% / 95% / 100%       -> avg 95.0
usage('a1', D0, 77760); usage('a2', D0, 82080); usage('a3', D0, 86400);
// ws-b, D1: a full day — must never appear in ws-a's trend
usage('b1', D1, 86400);

const tokA = generateToken({ id: 'user-a', email: 'a@t.test', role: 'user' }, 'ws-a');
const tokB = generateToken({ id: 'user-b', email: 'b@t.test', role: 'user' }, 'ws-b');

const app = express();
app.use(express.json());
app.use('/api/dashboard/reports', requireAuth, resolveTenancy, require('../routes/dashboard-reports'));
app.use((err, req, res, _next) => { res.status(500).json({ error: err.message, stack: err.stack }); });
const server = app.listen(0);
let base;
test.before(async () => {
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); db.close(); });

const get = (token, qs = '') =>
  fetch(`${base}/api/dashboard/reports/sla-trend${qs}`, { headers: { Authorization: `Bearer ${token}` } });

test('returns one hand-checked point per day with data, oldest first', async () => {
  const res = await get(tokA, '?days=7');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, [
    { day: D3, avg_uptime_pct: 50 },
    { day: D2, avg_uptime_pct: 75 },
    { day: D1, avg_uptime_pct: 10 },
    { day: D0, avg_uptime_pct: 95 },
  ]);
});

test('the line is not flat — real day-to-day movement', async () => {
  const body = await (await get(tokA, '?days=7')).json();
  const pcts = body.map((p) => p.avg_uptime_pct);
  assert.ok(Math.max(...pcts) - Math.min(...pcts) >= 50, 'range spans 10% -> 95%');
});

test('workspace-scoped: WS A never sees WS B usage (its full-day b1 row)', async () => {
  const body = await (await get(tokA, '?days=7')).json();
  const d1 = body.find((p) => p.day === D1);
  assert.equal(d1.avg_uptime_pct, 10, 'still 10 — b1 (100%) is not averaged in');

  const bodyB = await (await get(tokB, '?days=7')).json();
  assert.deepEqual(bodyB, [{ day: D1, avg_uptime_pct: 100 }]);
});

test('days param clamps and defaults', async () => {
  // days=1 -> only today's point
  assert.deepEqual(await (await get(tokA, '?days=1')).json(), [{ day: D0, avg_uptime_pct: 95 }]);
  // absurd values fall back / clamp, still 200 with the 4 seeded points
  assert.equal((await (await get(tokA, '?days=abc')).json()).length, 4);
  assert.equal((await (await get(tokA, '?days=99999')).json()).length, 4);
  assert.equal((await (await get(tokA, '?days=0')).json()).length, 4);
});

test('no workspace context -> empty array, not an error', async () => {
  // a valid user with no workspace membership at all
  db.prepare("INSERT INTO users (id, email, role) VALUES ('user-x', 'x@t.test', 'user')").run();
  const tok = generateToken({ id: 'user-x', email: 'x@t.test', role: 'user' }, null);
  const res = await get(tok, '?days=7');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), []);
});
