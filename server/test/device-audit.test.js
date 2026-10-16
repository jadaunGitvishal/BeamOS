'use strict';

// Phase 2 Stage A — device audit trail (lib/device-audit.js) + the
// GET /api/dashboard/devices/:id/audit-trail route.
//
// The REAL MySQL test DB (beamos_test via npm test); the route is the real
// dashboard-devices router behind requireAuth + resolveTenancy (helpers/inprocess-app.js).
// One device is seeded across all three trail sources — status_log transitions, reported
// device_events, and telemetry readings that cross the Wi-Fi and storage thresholds
// (including a sparse reading that must NOT fake a crossing) — and the merged output is
// checked for order and plain-language translation.
//
// Fixtures are test-owned (da- prefix, generated ids) at FIXED timestamps (T below and the
// heatmap's fixed clock), so results don't depend on the run date. device_status_log has
// no FK to devices, so this file deletes its own rows by device id; device_events and
// device_telemetry cascade from devices; the unassigned device (no workspace) is deleted
// by id; the rest goes with the owner (org, workspace, devices).

const test = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const config = require('../config');
const { recordDeviceEvent, buildDeviceAuditTrail, phraseEvent, buildStatusHeatmap, detectHeatmapPattern } = require('../lib/device-audit');
const { generateToken } = require('../middleware/auth');
const { startInProcessApp } = require('./helpers/inprocess-app');
const { randTag, cleanupUsers, cleanupDevices } = require('./helpers/disposable');

const P = `da-${randTag()}`;
const id = (name) => `${P}-${name}`;
const ID = {
  admin: id('u-admin'), outsider: id('u-outsider'), org: id('org'), ws: id('ws'),
  dev1: id('dev1'), unassigned: id('dev-unassigned'), cap: id('dev-cap'),
  hm: id('dev-hm'), hm2: id('dev-hm2'), hm3: id('dev-hm3'),
};
const ALL_DEVICES = [ID.dev1, ID.unassigned, ID.cap, ID.hm, ID.hm2, ID.hm3];

const T = 1_800_000_000;
const H = 3600;
// --- Phase 2 Stage C fixed clock ---
const HM_NOW = 1_800_000_000_000; // fixed clock (ms)
const HM_NOW_SEC = Math.floor(HM_NOW / 1000);
const HM_MID = Math.floor(HM_NOW_SEC / 86400) * 86400; // 00:00 UTC "today"
const HM_START = HM_MID - 6 * 86400; // 7-day window start (00:00 UTC, 6 days back)
const hmDay = (dayIdx) => new Date((HM_START + dayIdx * 86400) * 1000).toISOString().slice(0, 10);

let app;
let base;
let tokAdmin;
let tokOut;

test.before(async () => {
  app = await startInProcessApp({ only: ['/api/dashboard/devices'] });
  base = app.base;
  const run = (sql, ...p) => db.prepare(sql).run(...p);

  // --- fixtures ----------------------------------------------------------
  await run("INSERT INTO users (id, email, role, password_hash, auth_provider) VALUES (?, ?, 'user', NULL, 'local')", ID.admin, `${P}-admin@t.test`);
  await run("INSERT INTO users (id, email, role, password_hash, auth_provider) VALUES (?, ?, 'user', NULL, 'local')", ID.outsider, `${P}-out@t.test`);
  await run("INSERT INTO organizations (id, name, owner_user_id, plan_id, subscription_status) VALUES (?, ?, ?, 'enterprise', 'active')", ID.org, `${P} Org`, ID.admin);
  await run('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)', ID.ws, ID.org, 'WS');
  await run("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin')", ID.ws, ID.admin);
  await run('INSERT INTO devices (id, workspace_id, name) VALUES (?, ?, ?)', ID.dev1, ID.ws, 'Lobby Screen');
  await run('INSERT INTO devices (id, workspace_id, name) VALUES (?, NULL, ?)', ID.unassigned, 'Unpaired');

  const st = (s, agoH) => run('INSERT INTO device_status_log (device_id, status, timestamp) VALUES (?, ?, ?)', ID.dev1, s, T - agoH * H);
  const ev = (type, msg, agoH) => run('INSERT INTO device_events (device_id, workspace_id, event_type, message, occurred_at) VALUES (?, ?, ?, ?, ?)', ID.dev1, ID.ws, type, msg, T - agoH * H);
  const tel = (rssi, stor, agoH) => run('INSERT INTO device_telemetry (device_id, wifi_rssi, storage_free_mb, reported_at) VALUES (?, ?, ?, ?)', ID.dev1, rssi, stor, T - agoH * H);

  // status transitions
  await st('offline', 18);
  await st('online', 17);
  await st('offline', 9);
  await st('online', 2);
  // reported events
  await ev('playlist_resumed', null, 14);
  await ev('update_failed', 'disk full', 11);
  await ev('update_installed', '2.4.1', 8);
  await ev('mystery_new_event', 'raw detail text', 6); // unknown type -> generic phrasing
  // telemetry: baseline OK, Wi-Fi drops at -15h, sparse row at -13h (ignored),
  // storage drops at -12h, Wi-Fi recovers at -10h
  await tel(-60, 2000, 20);
  await tel(-62, 1800, 16);
  await tel(-85, 1700, 15); // Wi-Fi -> weak
  await tel(null, null, 13); // sparse: must not create a crossing
  await tel(-88, 400, 12); // storage -> low  (Wi-Fi still weak: no new Wi-Fi crossing)
  await tel(-70, 300, 10); // Wi-Fi -> recovered (storage still low: no crossing)

  // --- heatmap fixtures (Phase 2 Stage C) ---
  const hm = (device, status, dayIdx, hour) =>
    run('INSERT INTO device_status_log (device_id, status, timestamp) VALUES (?, ?, ?)', device, status, HM_START + dayIdx * 86400 + hour * 3600);
  await run('INSERT INTO devices (id, workspace_id, name) VALUES (?, ?, ?)', ID.hm, ID.ws, 'Heatmap');
  // online from before the window; then offline 15:00 -> online 17:00 on day indices 3, 4, 5
  await run('INSERT INTO device_status_log (device_id, status, timestamp) VALUES (?, ?, ?)', ID.hm, 'online', HM_START - 3600);
  for (const d of [3, 4, 5]) { await hm(ID.hm, 'offline', d, 15); await hm(ID.hm, 'online', d, 17); }
  // a device with the same afternoon dip on only 2 consecutive days -> no pattern
  await run('INSERT INTO devices (id, workspace_id, name) VALUES (?, ?, ?)', ID.hm2, ID.ws, 'Heatmap2');
  await run('INSERT INTO device_status_log (device_id, status, timestamp) VALUES (?, ?, ?)', ID.hm2, 'online', HM_START - 3600);
  for (const d of [4, 5]) { await hm(ID.hm2, 'offline', d, 15); await hm(ID.hm2, 'online', d, 17); }

  tokAdmin = generateToken({ id: ID.admin, email: `${P}-admin@t.test`, role: 'user' }, ID.ws);
  tokOut = generateToken({ id: ID.outsider, email: `${P}-out@t.test`, role: 'user' }, null);
});

test.after(async () => {
  try {
    if (app) {
      // device_status_log has no FK to devices: delete this file's rows explicitly.
      for (const dev of ALL_DEVICES) await db.prepare('DELETE FROM device_status_log WHERE device_id = ?').run(dev);
      await cleanupDevices(db, [ID.unassigned]); // no workspace: not part of the owner's cascade
      await cleanupUsers(db, [ID.outsider, ID.admin]);
    }
  } finally {
    if (app) await app.stop(); else await db.close();
  }
});

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
  const trail = await buildDeviceAuditTrail(db, ID.dev1, { limit: 100 });
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
  const trail = await buildDeviceAuditTrail(db, ID.dev1, { limit: 100 });
  const tele = trail.filter((e) => e.type === 'telemetry');
  // exactly 3: Wi-Fi drop, storage low, Wi-Fi recover — not one per reading
  assert.equal(tele.length, 3);
});

test('since filter drops everything older than the cutoff', async () => {
  const trail = await buildDeviceAuditTrail(db, ID.dev1, { sinceEpoch: T - 10 * H });
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
  const trail = await buildDeviceAuditTrail(db, ID.dev1, { limit: 3 });
  assert.equal(trail.length, 3);
  assert.equal(trail[0].message, 'Screen came online');
  assert.equal(trail[2].message, 'Software update installed — now on 2.4.1');
});

// --- recordDeviceEvent ---------------------------------------------
test('recordDeviceEvent snapshots workspace_id from the device and inserts', async () => {
  const rowId = await recordDeviceEvent(db, ID.dev1, 'update_started', '  2.5.0  ');
  assert.ok(rowId);
  const row = await db.prepare('SELECT * FROM device_events WHERE id = ?').get(rowId);
  assert.equal(row.workspace_id, ID.ws);
  assert.equal(row.event_type, 'update_started');
  assert.equal(row.message, '2.5.0'); // trimmed
});

test('recordDeviceEvent: unassigned device -> workspace_id null, still recorded', async () => {
  const rowId = await recordDeviceEvent(db, ID.unassigned, 'app_restarted', null);
  const row = await db.prepare('SELECT * FROM device_events WHERE id = ?').get(rowId);
  assert.equal(row.workspace_id, null);
  assert.equal(row.message, null);
});

test('recordDeviceEvent: blank / missing event_type is a no-op', async () => {
  const before = (await db.prepare('SELECT COUNT(*) n FROM device_events').get()).n;
  assert.equal(await recordDeviceEvent(db, ID.dev1, '   ', 'x'), null);
  assert.equal(await recordDeviceEvent(db, ID.dev1, null, 'x'), null);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM device_events').get()).n, before);
});

test('recordDeviceEvent enforces the per-device row cap (oldest dropped)', async () => {
  await db.prepare('INSERT INTO devices (id, workspace_id, name) VALUES (?, ?, ?)').run(ID.cap, ID.ws, 'Cap');
  // 5 pre-existing events at known, increasing (but old) times
  for (let i = 1; i <= 5; i++) {
    await db.prepare("INSERT INTO device_events (device_id, workspace_id, event_type, message, occurred_at) VALUES (?, ?, 'tick', ?, ?)")
      .run(ID.cap, ID.ws, `old${i}`, 1700000000 + i);
  }
  const orig = config.deviceEventsMaxPerDevice;
  config.deviceEventsMaxPerDevice = 3;
  try {
    // this insert lands NOW (occurred_at = fresh Date.now(), far newer than the
    // seeded rows); recordDeviceEvent then trims the device to the newest 3
    await recordDeviceEvent(db, ID.cap, 'tick', 'newest');
    const kept = (await db.prepare('SELECT message FROM device_events WHERE device_id = ? ORDER BY occurred_at').all(ID.cap)).map((r) => r.message);
    assert.equal(kept.length, 3);
    assert.deepEqual(kept, ['old4', 'old5', 'newest']);
  } finally {
    config.deviceEventsMaxPerDevice = orig;
  }
});

// --- route: GET /api/dashboard/devices/:id/audit-trail --------------
const at = (devId, tok, qs = '') => fetch(`${base}/api/dashboard/devices/${devId}/audit-trail${qs}`, { headers: { Authorization: `Bearer ${tok}` } });

test('route: 200 returns the same trail the lib builds', async () => {
  const res = await at(ID.dev1, tokAdmin, '?limit=100');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body[0].message, 'Screen came online');
  assert.ok(body.every((e) => typeof e.timestamp === 'number' && typeof e.message === 'string'));
});

test('route: 404 unknown device, 403 unassigned, 403 no workspace access', async () => {
  assert.equal((await at(id('nope'), tokAdmin)).status, 404);
  assert.equal((await at(ID.unassigned, tokAdmin)).status, 403);
  assert.equal((await at(ID.dev1, tokOut)).status, 403);
});

// --- Phase 2 Stage C: status heatmap + pattern detection -------------
test('heatmap: hour buckets carry the right online percentage', async () => {
  const grid = await buildStatusHeatmap(db, ID.hm, { days: 7, nowMs: HM_NOW });
  const cell = (day, hour) => grid.cells.find((c) => c.hour === hour && c.day === hmDay(day));
  // day 3, 15:00 and 16:00 -> fully offline -> 0%
  assert.equal(cell(3, 15).online_pct, 0);
  assert.equal(cell(3, 16).online_pct, 0);
  // day 3, 14:00 and 18:00 -> fully online -> 100%
  assert.equal(cell(3, 14).online_pct, 100);
  assert.equal(cell(3, 18).online_pct, 100);
  // day 0 (oldest full day) noon -> online carried from the prior row
  assert.equal(cell(0, 12).online_pct, 100);
});

test('heatmap: detects the repeated 15:00-17:00 offline pattern across 3 consecutive days', async () => {
  const { pattern } = await buildStatusHeatmap(db, ID.hm, { days: 7, nowMs: HM_NOW });
  assert.ok(pattern && pattern.detected);
  assert.equal(pattern.hour_start, 15);
  assert.equal(pattern.hour_end, 17);
  assert.equal(pattern.consecutive_days, 3);
  assert.match(pattern.message, /offline around 15:00–17:00 on 3 of the last 7 days/);
});

test('heatmap: 2 consecutive bad days is NOT a pattern', async () => {
  const { pattern } = await buildStatusHeatmap(db, ID.hm2, { days: 7, nowMs: HM_NOW });
  assert.equal(pattern, null);
});

test('heatmap: device with no status_log history -> empty grid, no pattern', async () => {
  await db.prepare('INSERT INTO devices (id, workspace_id, name) VALUES (?, ?, ?)').run(ID.hm3, ID.ws, 'Empty');
  const grid = await buildStatusHeatmap(db, ID.hm3, { days: 7, nowMs: HM_NOW });
  assert.deepEqual(grid.cells, []);
  assert.equal(grid.pattern, null);
});

test('detectHeatmapPattern: pure — 3-in-a-row fires, gaps reset the run', () => {
  const days = 7;
  const grid = Array.from({ length: days }, () => new Array(24).fill(100));
  // hour 9 bad on days 1,2,3 (consecutive) -> pattern
  for (const d of [1, 2, 3]) grid[d][9] = 10;
  // hour 20 bad on days 0,1 and 5,6 (never 3 in a row) -> no pattern
  for (const d of [0, 1, 5, 6]) grid[d][20] = 10;
  const p = detectHeatmapPattern(grid, days);
  assert.equal(p.hour_start, 9);
  assert.equal(p.hour_end, 10);
  assert.equal(p.consecutive_days, 3);
});

test('route: status-heatmap 200 + RBAC (404 / 403 / 403)', async () => {
  const hmReq = (devId, tok, qs = '') => fetch(`${base}/api/dashboard/devices/${devId}/status-heatmap${qs}`, { headers: { Authorization: `Bearer ${tok}` } });
  const ok = await hmReq(ID.hm, tokAdmin, '?days=7');
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.days, 7);
  assert.ok(Array.isArray(body.cells) && typeof body.start === 'string');
  assert.ok(body.pattern === null || body.pattern.detected === true);
  assert.equal((await hmReq(id('nope'), tokAdmin)).status, 404);
  assert.equal((await hmReq(ID.unassigned, tokAdmin)).status, 403);
  assert.equal((await hmReq(ID.hm, tokOut)).status, 403);
});
