'use strict';

// Phase 2 Stage A — device audit trail (lib/device-audit.js) + the
// GET /api/dashboard/devices/:id/audit-trail route.
//
// In-memory sqlite stands in for the real DB. One device is seeded across all
// three trail sources — status_log transitions, reported device_events, and
// telemetry readings that cross the Wi-Fi and storage thresholds (including a
// sparse reading that must NOT fake a crossing) — and the merged output is
// checked for order and plain-language translation.

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

process.env.JWT_SECRET = 'test-secret-device-audit';

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
  CREATE TABLE device_status_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL, status TEXT NOT NULL, timestamp INTEGER NOT NULL
  );
  CREATE TABLE device_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL, workspace_id TEXT,
    event_type TEXT NOT NULL, message TEXT, occurred_at INTEGER NOT NULL
  );
  CREATE TABLE device_telemetry (
    id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL,
    wifi_rssi INTEGER, storage_free_mb INTEGER, reported_at INTEGER NOT NULL
  );
`);

const dbModulePath = require.resolve('../db/database');
require.cache[dbModulePath] = { id: dbModulePath, filename: dbModulePath, loaded: true, exports: { db } };

const config = require('../config');
const { recordDeviceEvent, buildDeviceAuditTrail, phraseEvent } = require('../lib/device-audit');
const express = require('express');
const { generateToken, requireAuth } = require('../middleware/auth');
const { resolveTenancy } = require('../lib/tenancy');

// --- fixtures ----------------------------------------------------------
db.prepare("INSERT INTO users (id, email, role) VALUES ('u-admin', 'admin@t.test', 'user')").run();
db.prepare("INSERT INTO users (id, email, role) VALUES ('u-outsider', 'out@t.test', 'user')").run();
db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES ('org', 'Org', 'u-admin')").run();
db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES ('ws', 'org', 'WS')").run();
db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('ws', 'u-admin', 'workspace_admin')").run();
db.prepare("INSERT INTO devices (id, workspace_id, name) VALUES ('dev1', 'ws', 'Lobby Screen')").run();
db.prepare("INSERT INTO devices (id, workspace_id, name) VALUES ('dev-unassigned', NULL, 'Unpaired')").run();

const T = 1_800_000_000;
const H = 3600;
const st = (s, agoH) => db.prepare('INSERT INTO device_status_log (device_id, status, timestamp) VALUES (?, ?, ?)').run('dev1', s, T - agoH * H);
const ev = (type, msg, agoH) => db.prepare('INSERT INTO device_events (device_id, workspace_id, event_type, message, occurred_at) VALUES (?, ?, ?, ?, ?)').run('dev1', 'ws', type, msg, T - agoH * H);
const tel = (rssi, stor, agoH) => db.prepare('INSERT INTO device_telemetry (device_id, wifi_rssi, storage_free_mb, reported_at) VALUES (?, ?, ?, ?)').run('dev1', rssi, stor, T - agoH * H);

// status transitions
st('offline', 18);
st('online', 17);
st('offline', 9);
st('online', 2);
// reported events
ev('playlist_resumed', null, 14);
ev('update_failed', 'disk full', 11);
ev('update_installed', '2.4.1', 8);
ev('mystery_new_event', 'raw detail text', 6); // unknown type -> generic phrasing
// telemetry: baseline OK, Wi-Fi drops at -15h, sparse row at -13h (ignored),
// storage drops at -12h, Wi-Fi recovers at -10h
tel(-60, 2000, 20);
tel(-62, 1800, 16);
tel(-85, 1700, 15); // Wi-Fi -> weak
tel(null, null, 13); // sparse: must not create a crossing
tel(-88, 400, 12); // storage -> low  (Wi-Fi still weak: no new Wi-Fi crossing)
tel(-70, 300, 10); // Wi-Fi -> recovered (storage still low: no crossing)

// --- phraseEvent -----------------------------------------------------
test('phraseEvent: known types, unknown fallback, with/without message', () => {
  assert.equal(phraseEvent('playlist_resumed', null), 'Playback resumed');
  assert.equal(phraseEvent('update_installed', '2.4.1'), 'Software update installed — now on 2.4.1');
  assert.equal(phraseEvent('update_failed', 'disk full'), 'Software update failed: disk full');
  assert.equal(phraseEvent('update_failed', null), 'Software update failed');
  assert.equal(phraseEvent('brightness_changed', '80%'), 'Device reported "brightness changed": 80%');
  assert.equal(phraseEvent('brightness_changed', null), 'Device reported "brightness changed"');
});

// --- buildDeviceAuditTrail: the point-4 scenario ---------------------
test('merged trail: correct order (newest first) and plain-language per source', async () => {
  const trail = await buildDeviceAuditTrail(db, 'dev1', { limit: 100 });
  assert.deepEqual(
    trail.map((e) => [Math.round((T - e.timestamp) / H) + 'h ago', e.type, e.message]),
    [
      ['2h ago', 'status', 'Screen came online'],
      ['6h ago', 'event', 'Device reported "mystery new event": raw detail text'],
      ['8h ago', 'event', 'Software update installed — now on 2.4.1'],
      ['9h ago', 'status', 'Screen went offline'],
      ['10h ago', 'telemetry', 'Wi-Fi signal recovered (-70 dBm)'],
      ['11h ago', 'event', 'Software update failed: disk full'],
      ['12h ago', 'telemetry', 'Storage space running low (400 MB free)'],
      ['14h ago', 'event', 'Playback resumed'],
      ['15h ago', 'telemetry', 'Wi-Fi signal dropped to weak (-85 dBm)'],
      ['17h ago', 'status', 'Screen came online'],
      ['18h ago', 'status', 'Screen went offline'],
    ],
  );
});

test('a sparse telemetry reading (null rssi/storage) does not fake a crossing', async () => {
  const trail = await buildDeviceAuditTrail(db, 'dev1', { limit: 100 });
  const tele = trail.filter((e) => e.type === 'telemetry');
  // exactly 3: Wi-Fi drop, storage low, Wi-Fi recover — not one per reading
  assert.equal(tele.length, 3);
});

test('since filter drops everything older than the cutoff', async () => {
  const trail = await buildDeviceAuditTrail(db, 'dev1', { sinceEpoch: T - 10 * H });
  // only entries at/after T-10h: online@2h, mystery@6h, update_installed@8h,
  // offline@9h, wifi-recovered@10h
  assert.deepEqual(trail.map((e) => e.message), [
    'Screen came online',
    'Device reported "mystery new event": raw detail text',
    'Software update installed — now on 2.4.1',
    'Screen went offline',
    'Wi-Fi signal recovered (-70 dBm)',
  ]);
});

test('limit caps the number of entries (newest kept)', async () => {
  const trail = await buildDeviceAuditTrail(db, 'dev1', { limit: 3 });
  assert.equal(trail.length, 3);
  assert.equal(trail[0].message, 'Screen came online');
  assert.equal(trail[2].message, 'Software update installed — now on 2.4.1');
});

// --- recordDeviceEvent ---------------------------------------------
test('recordDeviceEvent snapshots workspace_id from the device and inserts', async () => {
  const id = await recordDeviceEvent(db, 'dev1', 'update_started', '  2.5.0  ');
  assert.ok(id);
  const row = db.prepare('SELECT * FROM device_events WHERE id = ?').get(id);
  assert.equal(row.workspace_id, 'ws');
  assert.equal(row.event_type, 'update_started');
  assert.equal(row.message, '2.5.0'); // trimmed
});

test('recordDeviceEvent: unassigned device -> workspace_id null, still recorded', async () => {
  const id = await recordDeviceEvent(db, 'dev-unassigned', 'app_restarted', null);
  const row = db.prepare('SELECT * FROM device_events WHERE id = ?').get(id);
  assert.equal(row.workspace_id, null);
  assert.equal(row.message, null);
});

test('recordDeviceEvent: blank / missing event_type is a no-op', async () => {
  const before = db.prepare('SELECT COUNT(*) n FROM device_events').get().n;
  assert.equal(await recordDeviceEvent(db, 'dev1', '   ', 'x'), null);
  assert.equal(await recordDeviceEvent(db, 'dev1', null, 'x'), null);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM device_events').get().n, before);
});

test('recordDeviceEvent enforces the per-device row cap (oldest dropped)', async () => {
  db.prepare("INSERT INTO devices (id, workspace_id, name) VALUES ('dev-cap', 'ws', 'Cap')").run();
  // 5 pre-existing events at known, increasing (but old) times
  for (let i = 1; i <= 5; i++) {
    db.prepare("INSERT INTO device_events (device_id, workspace_id, event_type, message, occurred_at) VALUES ('dev-cap', 'ws', 'tick', ?, ?)")
      .run(`old${i}`, 1700000000 + i);
  }
  const orig = config.deviceEventsMaxPerDevice;
  config.deviceEventsMaxPerDevice = 3;
  try {
    // this insert lands NOW (occurred_at = fresh Date.now(), far newer than the
    // seeded rows); recordDeviceEvent then trims the device to the newest 3
    await recordDeviceEvent(db, 'dev-cap', 'tick', 'newest');
    const kept = db.prepare("SELECT message FROM device_events WHERE device_id = 'dev-cap' ORDER BY occurred_at").all().map((r) => r.message);
    assert.equal(kept.length, 3);
    assert.deepEqual(kept, ['old4', 'old5', 'newest']);
  } finally {
    config.deviceEventsMaxPerDevice = orig;
  }
});

// --- route: GET /api/dashboard/devices/:id/audit-trail --------------
const app = express();
app.use(express.json());
app.use('/api/dashboard/devices', requireAuth, resolveTenancy, require('../routes/dashboard-devices'));
app.use((err, req, res, _next) => { res.status(500).json({ error: err.message, stack: err.stack }); });
const server = app.listen(0);
let base;
test.before(async () => {
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); db.close(); });

const tokAdmin = generateToken({ id: 'u-admin', email: 'admin@t.test', role: 'user' }, 'ws');
const tokOut = generateToken({ id: 'u-outsider', email: 'out@t.test', role: 'user' }, null);
const at = (id, tok, qs = '') => fetch(`${base}/api/dashboard/devices/${id}/audit-trail${qs}`, { headers: { Authorization: `Bearer ${tok}` } });

test('route: 200 returns the same trail the lib builds', async () => {
  const res = await at('dev1', tokAdmin, '?limit=100');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body[0].message, 'Screen came online');
  assert.ok(body.every((e) => typeof e.timestamp === 'number' && typeof e.message === 'string'));
});

test('route: 404 unknown device, 403 unassigned, 403 no workspace access', async () => {
  assert.equal((await at('nope', tokAdmin)).status, 404);
  assert.equal((await at('dev-unassigned', tokAdmin)).status, 403);
  assert.equal((await at('dev1', tokOut)).status, 403);
});
