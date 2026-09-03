'use strict';

// Ref 51 (SLA Dashboard) Stage 2 — long-term outage history.
//
// Verifies the actual fix: MTTR is no longer capped at device_status_log's
// ~3-day retention because completed outages are recorded into the durable
// outage_history table by services/outage-history.js and GET /sla-overview reads
// MTTR from there.
//
//   1. the shared detector (lib/outage-detection.js) returns the SAME
//      hand-checked outages whether scoped to a workspace (endpoint path) or
//      run platform-wide (scheduler path) — dev1..dev4 from Stage 1
//   2. the recorder is idempotent — running it twice makes no duplicate rows
//   3. end-to-end — seed a completed outage, run the recorder, see the row
//   4. MTTR over a 60-day window computed from outage_history rows that are
//      older than the status-log retention window (and have NO status-log rows
//      at all) — the case that was previously impossible

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

process.env.JWT_SECRET = 'test-secret-outage-history';

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
  -- Step 5 Stage A: the recorder now classifies each outage's likely cause off
  -- the pre-outage telemetry, so this table must exist for that path.
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
const { detectOutages } = require('../lib/outage-detection');
const { runOutageHistory } = require('../services/outage-history');

// --- tenants / devices ---------------------------------------------------
db.prepare("INSERT INTO users (id, email, role) VALUES ('user-a', 'a@t.test', 'user')").run();
db.prepare("INSERT INTO users (id, email, role) VALUES ('user-b', 'b@t.test', 'user')").run();
db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES ('org-a', 'A', 'user-a')").run();
db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES ('org-b', 'B', 'user-b')").run();
db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES ('ws-a', 'org-a', 'WS A')").run();
db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES ('ws-b', 'org-b', 'WS B')").run();
db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('ws-a', 'user-a', 'workspace_admin')").run();
db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('ws-b', 'user-b', 'workspace_admin')").run();

const D = 86400;
const H = 3600;
const now = Math.floor(Date.now() / 1000);

const dev = (id, ws, name, sort) =>
  db.prepare("INSERT INTO devices (id, workspace_id, name, sort_order, created_at) VALUES (?, ?, ?, ?, 0)").run(id, ws, name, sort || 0);
const log = (device, status, ago) =>
  db.prepare("INSERT INTO device_status_log (device_id, status, timestamp) VALUES (?, ?, ?)").run(device, status, now - ago);

// Same dev1..dev4 fixture as sla-overview.test.js (Stage 1's hand-checked cases).
dev('dev1', 'ws-a', 'Lobby', 1);
dev('dev2', 'ws-a', 'Cafeteria', 2);
dev('dev3', 'ws-a', 'Reception', 3);
dev('dev4', 'ws-a', 'Boardroom', 4);
dev('dev-b', 'ws-b', 'Other tenant', 1);

// dev1: two completed outages — 3600s and 1800s
log('dev1', 'offline', 10 * H); log('dev1', 'online', 9 * H);
log('dev1', 'offline', 5 * H); log('dev1', 'online', Math.round(4.5 * H));
// dev2: ongoing outage (no recovery) — NOT a completed outage
log('dev2', 'online', 20 * H); log('dev2', 'offline', 6 * H);
// dev3: leading 'online' (phantom guard) then ongoing offline
log('dev3', 'online', 8 * H); log('dev3', 'offline', 2 * H);
// dev4: offline + offline_timeout + online -> ONE 3600s completed outage
log('dev4', 'offline', 12 * H); log('dev4', 'offline_timeout', Math.round(11.5 * H)); log('dev4', 'online', 11 * H);
// dev-b: one completed 3600s outage in the other workspace
log('dev-b', 'offline', 9 * H); log('dev-b', 'online', 8 * H);

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

const sinceAll = now - 40 * D;
const key = (o) => `${o.device_id}:${o.outage_start}:${o.outage_end}`;

// --- 1. shared detector: scheduler path == endpoint path ------------------
test('detectOutages returns identical outages platform-wide and workspace-scoped', async () => {
  const platformWide = await detectOutages(db, { sinceEpoch: sinceAll, untilEpoch: now });
  const wsA = await detectOutages(db, { sinceEpoch: sinceAll, untilEpoch: now, workspaceId: 'ws-a' });

  // platform-wide sees ws-b too; ws-a scoped does not.
  assert.ok(platformWide.some((o) => o.device_id === 'dev-b'));
  assert.ok(!wsA.some((o) => o.device_id === 'dev-b'));

  // ...but for the ws-a devices the two calls agree exactly.
  const onlyA = (rows) => rows.filter((o) => o.device_id.startsWith('dev') && o.device_id !== 'dev-b').map(key).sort();
  assert.deepEqual(onlyA(platformWide), onlyA(wsA));

  // and the hand-checked shape: dev1 x2 completed, dev4 x1 completed,
  // dev2 + dev3 each one ongoing (outage_end null).
  const byDev = {};
  for (const o of wsA) (byDev[o.device_id] ||= []).push(o);
  assert.equal(byDev.dev1.length, 2);
  assert.deepEqual(byDev.dev1.map((o) => o.outage_end - o.outage_start), [3600, 1800]);
  assert.equal(byDev.dev4.length, 1);
  assert.equal(byDev.dev4[0].outage_end - byDev.dev4[0].outage_start, 3600);
  assert.equal(byDev.dev2.length, 1);
  assert.equal(byDev.dev2[0].outage_end, null);
  assert.equal(byDev.dev3.length, 1);
  assert.equal(byDev.dev3[0].outage_end, null);
});

// --- 2. recorder idempotency -------------------------------------------
test('runOutageHistory is idempotent — a second run inserts nothing', async () => {
  const first = await runOutageHistory(db, { now: now * 1000 });
  // completed outages: dev1 x2, dev4 x1, dev-b x1 = 4
  assert.equal(first.completed, 4);
  assert.equal(first.inserted, 4);

  const rowsAfterFirst = db.prepare('SELECT COUNT(*) AS n FROM outage_history').get().n;
  assert.equal(rowsAfterFirst, 4);

  const second = await runOutageHistory(db, { now: now * 1000 });
  assert.equal(second.completed, 4);
  assert.equal(second.inserted, 0, 'unique (device_id, started_at) makes the re-run a no-op');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM outage_history').get().n, 4);

  // ongoing outages (dev2, dev3) were never written.
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM outage_history WHERE device_id IN ('dev2','dev3')").get().n, 0);

  // the UNIQUE constraint itself holds against a direct duplicate insert.
  const dup = () =>
    db.prepare('INSERT INTO outage_history (device_id, workspace_id, started_at, ended_at, duration_seconds) VALUES (?,?,?,?,?)')
      .run('dev1', 'ws-a', now - 10 * H, now - 9 * H, 3600);
  assert.throws(dup, /UNIQUE/i);
});

// --- 3. end-to-end: a fresh completed outage flows into outage_history ---
test('end-to-end: seed a completed outage, run the recorder, row appears with correct duration', async () => {
  dev('dev-e2e', 'ws-a', 'E2E', 9);
  log('dev-e2e', 'offline', 3 * H);
  log('dev-e2e', 'online', 1 * H); // 2h outage

  const r = await runOutageHistory(db, { now: now * 1000 });
  assert.ok(r.inserted >= 1);

  const row = db.prepare("SELECT * FROM outage_history WHERE device_id = 'dev-e2e'").get();
  assert.equal(row.workspace_id, 'ws-a');
  assert.equal(row.started_at, now - 3 * H);
  assert.equal(row.ended_at, now - 1 * H);
  assert.equal(row.duration_seconds, 2 * H);
});

// --- 4. the fix: MTTR over a window LONGER than status-log retention -----
test('MTTR is computed from outage_history for outages older than the 3-day status-log window', async () => {
  // dev-hist has NO device_status_log rows at all (simulating that they were
  // pruned long ago) — only outage_history rows, 35 / 20 / 10 days back.
  dev('dev-hist', 'ws-a', 'Archive', 20);
  const histRow = (startAgoDays, dur) =>
    db.prepare('INSERT INTO outage_history (device_id, workspace_id, started_at, ended_at, duration_seconds) VALUES (?,?,?,?,?)')
      .run('dev-hist', 'ws-a', now - startAgoDays * D, now - startAgoDays * D + dur, dur);
  histRow(35, 7200); // 2h  — outside the default ~30-day window
  histRow(20, 3600); // 1h
  histRow(10, 1800); // 0.5h

  // The live detector genuinely can't see any of this — no status-log rows.
  const live = await detectOutages(db, { sinceEpoch: now - 40 * D, untilEpoch: now, workspaceId: 'ws-a' });
  assert.ok(!live.some((o) => o.device_id === 'dev-hist'));

  // 60-day window -> all three historical outages (incl. the 35-day-old one that
  // is far outside any status-log retention) -> MTTR = (7200+3600+1800)/3 = 4200
  const res = await fetch(`${base}/api/dashboard/reports/sla-overview?start=${iso(now - 60 * D)}&end=${iso(now)}`,
    { headers: { Authorization: `Bearer ${tokA}` } });
  assert.equal(res.status, 200);
  const d = byId((await res.json()).devices)['dev-hist'];
  assert.equal(d.completed_outages, 3);
  assert.equal(d.mttr_seconds, 4200);

  // default (~30-day) window excludes the 30-day-old outage -> MTTR = (3600+1800)/2 = 2700
  const res2 = await fetch(`${base}/api/dashboard/reports/sla-overview`, { headers: { Authorization: `Bearer ${tokA}` } });
  const d2 = byId((await res2.json()).devices)['dev-hist'];
  assert.equal(d2.completed_outages, 2);
  assert.equal(d2.mttr_seconds, 2700);
});

// --- 5. outage_history MTTR is workspace-scoped -------------------------
test('sla-overview MTTR from outage_history never crosses workspaces', async () => {
  await runOutageHistory(db, { now: now * 1000 }); // make sure dev-b's outage is recorded
  const bodyB = await (await fetch(`${base}/api/dashboard/reports/sla-overview?start=${iso(now - 60 * D)}`,
    { headers: { Authorization: `Bearer ${tokB}` } })).json();
  assert.deepEqual(bodyB.devices.map((x) => x.device_id), ['dev-b']);
  assert.equal(byId(bodyB.devices)['dev-b'].mttr_seconds, 3600);

  const bodyA = await (await fetch(`${base}/api/dashboard/reports/sla-overview?start=${iso(now - 60 * D)}`,
    { headers: { Authorization: `Bearer ${tokA}` } })).json();
  assert.ok(!bodyA.devices.some((x) => x.device_id === 'dev-b'));
});

// --- 6. Step 5 Stage A: likely_cause is classified end-to-end ------------
test('runOutageHistory classifies each new outage: weak_wifi / low_storage / correlated_outage / unknown', async () => {
  const tele = (device, rssi, storeMb, ago) =>
    db.prepare('INSERT INTO device_telemetry (device_id, wifi_rssi, storage_free_mb, reported_at) VALUES (?,?,?,?)')
      .run(device, rssi, storeMb, now - ago);

  // (times chosen to sit clear of the fixture's -2h..-12h outage cluster,
  // including dev2/dev3's ongoing outages, so each scenario is isolated.)

  // weak Wi-Fi right before a 1h outage
  dev('dev-wifi', 'ws-a', 'Weak WiFi', 30);
  log('dev-wifi', 'offline', 14 * H); log('dev-wifi', 'online', 13 * H);
  tele('dev-wifi', -82, 9000, 14 * H + 15);

  // low storage right before a 30m outage (Wi-Fi fine)
  dev('dev-store', 'ws-a', 'Low Storage', 31);
  log('dev-store', 'offline', 16 * H); log('dev-store', 'online', Math.round(15.5 * H));
  tele('dev-store', -58, 300, 16 * H + 12);

  // two devices in ws-a dropping ~2 min apart -> correlated for BOTH
  dev('dev-corr1', 'ws-a', 'Corr 1', 32);
  dev('dev-corr2', 'ws-a', 'Corr 2', 33);
  log('dev-corr1', 'offline', 18 * H); log('dev-corr1', 'online', Math.round(17.5 * H));
  log('dev-corr2', 'offline', 18 * H - 120); log('dev-corr2', 'online', 17 * H);

  // healthy telemetry, no correlated peers -> unknown
  dev('dev-clean', 'ws-a', 'Clean', 34);
  log('dev-clean', 'offline', 20 * H); log('dev-clean', 'online', Math.round(19.5 * H));
  tele('dev-clean', -55, 9000, 20 * H + 10);

  // multi-signal: weak Wi-Fi AND a correlated peer -> correlated wins
  dev('dev-multi', 'ws-a', 'Multi', 35);
  dev('dev-multi-peer', 'ws-a', 'Multi Peer', 36);
  log('dev-multi', 'offline', 22 * H); log('dev-multi', 'online', Math.round(21.5 * H));
  log('dev-multi-peer', 'offline', 22 * H - 60); log('dev-multi-peer', 'online', 21 * H);
  tele('dev-multi', -85, 9000, 22 * H + 10);

  const r = await runOutageHistory(db, { now: now * 1000 });
  assert.ok(r.inserted >= 6);
  assert.ok(r.causeTally && typeof r.causeTally === 'object');

  const cause = (d) => db.prepare('SELECT likely_cause FROM outage_history WHERE device_id = ?').get(d).likely_cause;
  assert.equal(cause('dev-wifi'), 'weak_wifi');
  assert.equal(cause('dev-store'), 'low_storage');
  assert.equal(cause('dev-corr1'), 'correlated_outage');
  assert.equal(cause('dev-corr2'), 'correlated_outage');
  assert.equal(cause('dev-clean'), 'unknown');
  assert.equal(cause('dev-multi'), 'correlated_outage', 'correlated beats the weak-wifi reading');
  assert.equal(cause('dev-multi-peer'), 'correlated_outage');

  // the fixture's pre-Step-5 outages (no telemetry, no peers) -> unknown
  assert.equal(cause('dev1'), 'unknown');

  // a second run neither re-classifies nor duplicates
  const before = db.prepare("SELECT device_id, likely_cause FROM outage_history WHERE device_id LIKE 'dev-%'").all();
  const r2 = await runOutageHistory(db, { now: now * 1000 });
  assert.equal(r2.inserted, 0);
  assert.deepEqual(db.prepare("SELECT device_id, likely_cause FROM outage_history WHERE device_id LIKE 'dev-%'").all(), before);
});

function iso(sec) { return new Date(sec * 1000).toISOString().slice(0, 10); }
function byId(devices) { return Object.fromEntries(devices.map((d) => [d.device_id, d])); }
