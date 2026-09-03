'use strict';

// Ref 51 (SLA Dashboard, Stage 1) — verification for
// GET /api/dashboard/reports/sla-overview.
//
// Same harness as dashboard-content-export.test.js: in-memory sqlite swapped in
// for ../db/database, the REAL requireAuth + resolveTenancy chain, the router
// mounted exactly as server.js mounts it.
//
// The data below is hand-constructed so every output number can be checked by
// hand (see the comment on each device). It exercises each edge case the spec
// calls out:
//   dev1 - two clean completed outages -> MTTR = mean of the two
//   dev2 - one ongoing outage past the escalation threshold -> live breach
//   dev3 - log starts with an 'online' row (device was already offline before
//          the window) -> NO phantom outage; plus a short ongoing outage that
//          is under the threshold -> ongoing, but NOT a live breach
//   dev4 - 'offline' then 'offline_timeout' then 'online' -> ONE completed
//          outage, not two
//   dev-b - lives in another workspace, must never appear for workspace A

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

process.env.JWT_SECRET = 'test-secret-sla-overview';

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE users (
    id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT DEFAULT '',
    password_hash TEXT, auth_provider TEXT NOT NULL DEFAULT 'local', avatar_url TEXT,
    role TEXT NOT NULL DEFAULT 'user', plan_id TEXT DEFAULT 'free', email_alerts INTEGER DEFAULT 1,
    must_change_password INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_user_id TEXT NOT NULL);
  CREATE TABLE organization_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT, organization_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL
  );
  CREATE TABLE workspaces (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, name TEXT NOT NULL);
  CREATE TABLE workspace_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, user_id TEXT NOT NULL,
    role TEXT NOT NULL, joined_at INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE devices (
    id TEXT PRIMARY KEY, workspace_id TEXT, name TEXT DEFAULT '', status TEXT DEFAULT 'offline',
    sort_order INTEGER DEFAULT 0, created_at INTEGER DEFAULT 0
  );
  CREATE TABLE device_usage_daily (
    device_id TEXT NOT NULL, day TEXT NOT NULL, online_seconds INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (device_id, day)
  );
  CREATE TABLE device_status_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL, status TEXT NOT NULL, timestamp INTEGER NOT NULL
  );
  CREATE TABLE app_settings (\`key\` TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER DEFAULT 0);
  CREATE TABLE outage_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
    started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL, duration_seconds INTEGER NOT NULL,
    likely_cause TEXT, recorded_at INTEGER NOT NULL DEFAULT 0, UNIQUE (device_id, started_at)
  );
  -- Step 5 Stage A: runOutageHistory now classifies likely_cause off telemetry.
  CREATE TABLE device_telemetry (
    id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL,
    wifi_rssi INTEGER, storage_free_mb INTEGER, reported_at INTEGER NOT NULL
  );
`);

const dbModulePath = require.resolve('../db/database');
require.cache[dbModulePath] = { id: dbModulePath, filename: dbModulePath, loaded: true, exports: { db } };

const express = require('express');
const { generateToken, requireAuth } = require('../middleware/auth');
const { resolveTenancy } = require('../lib/tenancy');
const appSettings = require('../lib/app-settings');
const { runOutageHistory } = require('../services/outage-history');

// --- Two tenants ----------------------------------------------------------
db.prepare("INSERT INTO users (id, email, role) VALUES ('user-a', 'a@t.test', 'user')").run();
db.prepare("INSERT INTO users (id, email, role) VALUES ('user-b', 'b@t.test', 'user')").run();
db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES ('org-a', 'Org A', 'user-a')").run();
db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES ('org-b', 'Org B', 'user-b')").run();
db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES ('ws-a', 'org-a', 'WS A')").run();
db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES ('ws-b', 'org-b', 'WS B')").run();
db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('ws-a', 'user-a', 'workspace_admin')").run();
db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('ws-b', 'user-b', 'workspace_admin')").run();

const dev = (id, ws, name, sort) =>
  db.prepare("INSERT INTO devices (id, workspace_id, name, sort_order, created_at) VALUES (?, ?, ?, ?, 0)").run(id, ws, name, sort);
dev('dev1', 'ws-a', 'Lobby', 1);
dev('dev2', 'ws-a', 'Cafeteria', 2);
dev('dev3', 'ws-a', 'Reception', 3);
dev('dev4', 'ws-a', 'Boardroom', 4);
dev('dev-b', 'ws-b', 'Other-Tenant Screen', 1);

const H = 3600;
const now = Math.floor(Date.now() / 1000);
const log = (device, status, ago) =>
  db.prepare("INSERT INTO device_status_log (device_id, status, timestamp) VALUES (?, ?, ?)").run(device, status, now - ago);
const usage = (device, dayOffset, seconds) =>
  db.prepare("INSERT INTO device_usage_daily (device_id, day, online_seconds) VALUES (?, ?, ?)")
    .run(device, new Date((now - dayOffset * 86400) * 1000).toISOString().slice(0, 10), seconds);

// NOTE (Stage 2): completed-outage MTTR is now read from outage_history, which
// test.before() populates by running the real recorder once over this same
// device_status_log data. Ongoing / live-breach detection still reads the log
// live. The hand-checked numbers below are unchanged by that move.

// dev1: outage A = 10h..9h ago (3600s); outage B = 5h..4.5h ago (1800s).
//       MTTR = (3600 + 1800) / 2 = 2700s. completed_outages = 2.
//       usage: 2 days @ 85968s -> 85968/86400*100 = 99.5% -> compliant (>= 99.0)
log('dev1', 'offline', 10 * H);
log('dev1', 'online', 9 * H);
log('dev1', 'offline', 5 * H);
log('dev1', 'online', Math.round(4.5 * H));
usage('dev1', 1, 85968);
usage('dev1', 2, 85968);

// dev2: online 20h ago, offline 6h ago, never recovered.
//       ongoing_outage_seconds ~= 6h = 21600s > threshold 4h (14400s) -> live breach.
//       completed_outages = 0, mttr = null.
//       usage: 3 days @ 69120s -> 69120/86400*100 = 80.0% -> breach (< 99.0)
log('dev2', 'online', 20 * H);
log('dev2', 'offline', 6 * H);
usage('dev2', 1, 69120);
usage('dev2', 2, 69120);
usage('dev2', 3, 69120);

// dev3: FIRST row is 'online' 8h ago (device was already offline before the
//       window opened) -> must NOT invent a phantom outage.
//       Then 'offline' 2h ago, never recovered -> ongoing_outage_seconds ~= 7200s,
//       which is UNDER the 14400s threshold -> ongoing but NOT a live breach.
//       completed_outages = 0, mttr = null.
//       No usage rows -> availability_pct null -> sla_status 'unknown'.
log('dev3', 'online', 8 * H);
log('dev3', 'offline', 2 * H);

// dev4: 'offline' 12h ago, 'offline_timeout' 11.5h ago (same outage, escalated by
//       the heartbeat checker), 'online' 11h ago. Must collapse to ONE completed
//       outage of 12h-11h = 3600s, NOT two.
//       usage: 1 day @ 85536s -> 85536/86400*100 = 99.0% -> compliant (boundary, >=)
log('dev4', 'offline', 12 * H);
log('dev4', 'offline_timeout', Math.round(11.5 * H));
log('dev4', 'online', 11 * H);
usage('dev4', 1, 85536);

// dev-b: outage + usage in the OTHER workspace. Must never surface for WS A.
log('dev-b', 'offline', 9 * H);
log('dev-b', 'online', 8 * H);
usage('dev-b', 1, 1000);

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
  // Populate outage_history from the seeded status log, exactly as the scheduled
  // service does in production.
  await runOutageHistory(db);
});
test.after(() => { server.close(); db.close(); });

const get = (token) =>
  fetch(`${base}/api/dashboard/reports/sla-overview`, { headers: { Authorization: `Bearer ${token}` } });
const byId = (devices) => Object.fromEntries(devices.map((d) => [d.device_id, d]));

test('defaults: target comes from config when app_settings is empty', async () => {
  const res = await get(tokA);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.target, { uptime_target_pct: 99.0, escalation_threshold_hours: 4 });
});

test('dev1: MTTR is the mean of the two completed outages (2700s), 2 outages', async () => {
  const d = byId((await (await get(tokA)).json()).devices).dev1;
  assert.equal(d.completed_outages, 2);
  assert.equal(d.mttr_seconds, 2700);
  assert.equal(d.ongoing_outage_seconds, null);
  assert.equal(d.live_breach, false);
  assert.equal(d.availability_pct, 99.5);
  assert.equal(d.sla_status, 'compliant');
});

test('dev2: ongoing outage over threshold is a live breach; uptime under target is a breach', async () => {
  const d = byId((await (await get(tokA)).json()).devices).dev2;
  assert.equal(d.completed_outages, 0);
  assert.equal(d.mttr_seconds, null);
  // ~6h ago; allow a few seconds of test runtime slack.
  assert.ok(Math.abs(d.ongoing_outage_seconds - 6 * H) <= 60, `got ${d.ongoing_outage_seconds}`);
  assert.equal(d.live_breach, true);
  assert.equal(d.availability_pct, 80.0);
  assert.equal(d.sla_status, 'breach');
});

test('dev3: no phantom outage from a leading online row; short ongoing outage is not a live breach', async () => {
  const d = byId((await (await get(tokA)).json()).devices).dev3;
  assert.equal(d.completed_outages, 0, 'leading online row must not create a completed outage');
  assert.equal(d.mttr_seconds, null);
  assert.ok(Math.abs(d.ongoing_outage_seconds - 2 * H) <= 60, `got ${d.ongoing_outage_seconds}`);
  assert.equal(d.live_breach, false, '2h < 4h threshold');
  assert.equal(d.availability_pct, null);
  assert.equal(d.sla_status, 'unknown');
});

test('dev4: offline + offline_timeout + online collapses to ONE 3600s outage', async () => {
  const d = byId((await (await get(tokA)).json()).devices).dev4;
  assert.equal(d.completed_outages, 1);
  assert.equal(d.mttr_seconds, 3600);
  assert.equal(d.ongoing_outage_seconds, null);
  assert.equal(d.availability_pct, 99.0);
  assert.equal(d.sla_status, 'compliant', '99.0 >= 99.0 target boundary');
});

test('summary tallies match the per-device rows', async () => {
  const body = await (await get(tokA)).json();
  assert.deepEqual(body.summary, {
    devices_total: 4,
    devices_compliant: 2,
    devices_breach: 1,
    devices_unknown: 1,
    live_breaches: 1,
  });
});

test('workspace isolation: WS A never sees the other tenant device', async () => {
  const bodyA = await (await get(tokA)).json();
  assert.ok(!bodyA.devices.some((d) => d.device_id === 'dev-b'));
  const bodyB = await (await get(tokB)).json();
  assert.deepEqual(bodyB.devices.map((d) => d.device_id), ['dev-b']);
});

test('app_settings override: lowering the threshold to 1h makes dev3 a live breach', async () => {
  db.prepare("INSERT INTO app_settings (`key`, value) VALUES ('sla_escalation_threshold_hours', '1')").run();
  db.prepare("INSERT INTO app_settings (`key`, value) VALUES ('sla_uptime_target_pct', '95')").run();
  await appSettings.__reload();
  try {
    const body = await (await get(tokA)).json();
    assert.deepEqual(body.target, { uptime_target_pct: 95, escalation_threshold_hours: 1 });
    const d = byId(body.devices);
    assert.equal(d.dev3.live_breach, true, '2h > 1h threshold now');
    assert.equal(d.dev2.live_breach, true);
    assert.equal(body.summary.live_breaches, 2);
    // dev2 at 80% is still a breach vs the lowered 95% target; dev1/dev4 still compliant.
    assert.equal(d.dev2.sla_status, 'breach');
    assert.equal(d.dev1.sla_status, 'compliant');
  } finally {
    db.prepare("DELETE FROM app_settings").run();
    await appSettings.__reload();
  }
});
