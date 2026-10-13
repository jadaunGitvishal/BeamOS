'use strict';

// Offline-marking race — booted end-to-end. Both offline paths await an
// `UPDATE devices SET status = 'offline'`; if the device reconnects DURING that await
// (register calls registerConnection synchronously, then UPDATEs 'online' on another
// pooled connection) the offline write can land last. Without the re-check after the
// await, the device ends 'offline' in the DB, an 'offline' / 'offline_timeout' status-log
// entry is written and the dashboard is told 'offline' — while the device is connected.
//
//  - Path A: ws/deviceSocket.js offlineTransition (disconnect + 5s debounce).
//  - Path B: services/heartbeat.js checker (online in DB, stale heartbeat, no live socket).
//
// The server is spawned with test/helpers/slow-offline-update.js preloaded: it delays each
// offline UPDATE by SLOW_OFFLINE_MS and prints a marker line first, so the test reconnects
// exactly inside the await. Real MySQL test DB (beamos_test via npm test); the user,
// workspace and devices are test-owned and removed afterwards.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const ioClient = require('socket.io-client');
const path = require('node:path'); const crypto = require('node:crypto');
const { db } = require('../db/database');
const { cleanupUser } = require('./helpers/disposable');
const { startServer } = require('./helpers/spawn-server');

const HELPER = path.join(__dirname, 'helpers', 'slow-offline-update.js');
const SLOW_MS = 1500;           // width of the race window held open by the helper
const DEBOUNCE_MS = 5000;       // ws/deviceSocket.js OFFLINE_DEBOUNCE_MS
const FLUSH_MS = 200;           // STATUS_LOG_FLUSH_MS: status-log writer flush interval
const TAG = crypto.randomBytes(4).toString('hex');
const PW = 'Passw0rd123';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let srv, BASE;
let JWT, userId, dash;
const deviceIds = [];
const sockets = [];
const dashEvents = [];          // every dashboard:device-status the owner's dashboard received

before(async () => {
  srv = await startServer({
    name: 'offline-race',
    nodeArgs: ['--require', HELPER],
    env: {
      SLOW_OFFLINE_MS: String(SLOW_MS),
      STATUS_LOG_FLUSH_MS: String(FLUSH_MS),
      // Fast checker ticks for Path B. HEARTBEAT_TIMEOUT stays at its 45s default, so the
      // checker never touches a just-disconnected device (its map entry is recent) and
      // Path A is driven by the disconnect debounce alone.
      HEARTBEAT_INTERVAL: '300',
    },
    // Up to 60s: a normal boot answers in ~1s, but a cold first boot on this machine has
    // been seen to take 10-20s before printing anything.
    bootTimeoutMs: 60000,
  });
  BASE = srv.base;

  const reg = await fetch(BASE + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `offrace-${TAG}@x.local`, password: PW, name: 'Offline race' }) });
  const body = await reg.json();
  assert.ok(body.token && body.user, 'test user registered: ' + JSON.stringify(body));
  JWT = body.token; userId = body.user.id;

  // The owner's dashboard: records every device-status event for this workspace.
  dash = ioClient(`${BASE}/dashboard`, { transports: ['websocket'], reconnection: false, forceNew: true, auth: { token: JWT } });
  dash.on('dashboard:device-status', (e) => dashEvents.push(e));
  await new Promise((resolve, reject) => { dash.on('connect', resolve); dash.on('connect_error', reject); });
  await sleep(500);             // the room join happens after an async workspace lookup
});

// Only this file's rows: the user and everything they own (workspace -> devices ->
// device_status_log), plus any device that never got paired into that workspace.
after(async () => {
  for (const s of [...sockets, dash]) { try { s && s.close(); } catch { /* */ } }
  if (srv) await srv.stop();
  try {
    if (userId) await cleanupUser(db, userId);
    for (const id of deviceIds) {
      await db.prepare('DELETE FROM device_status_log WHERE device_id = ?').run(id);
      await db.prepare('DELETE FROM devices WHERE id = ?').run(id);
    }
  } finally {
    await db.close();
  }
});

function deviceSocket() {
  const s = ioClient(`${BASE}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
  sockets.push(s);
  return s;
}

// First registration with a pairing code (status 'provisioning'), then paired into the
// test user's workspace via the API while that socket stays connected ('online').
async function provisionAndPair(name) {
  const code = String(crypto.randomInt(100000, 1000000));
  const s = deviceSocket();
  const reg = await new Promise((resolve) => {
    s.on('connect', () => s.emit('device:register', { pairing_code: code }));
    s.on('device:registered', (d) => resolve(d));
    setTimeout(() => resolve(null), 4000);
  });
  assert.ok(reg && reg.device_id, 'device provisioned');
  deviceIds.push(reg.device_id);
  const r = await fetch(BASE + '/api/provision/pair', { method: 'POST',
    headers: { Authorization: 'Bearer ' + JWT, 'Content-Type': 'application/json' },
    body: JSON.stringify({ pairing_code: code, name }) });
  assert.equal(r.status, 200, 'paired into the test workspace');
  return { sock: s, id: reg.device_id, token: reg.device_token };
}

// Reconnect with device_id + token; resolves once the server ACCEPTED the socket.
async function reconnect(id, token) {
  const s = deviceSocket();
  const res = await new Promise((resolve) => {
    s.on('connect', () => s.emit('device:register', { device_id: id, device_token: token, device_info: {} }));
    s.on('device:registered', () => resolve('accepted'));
    s.on('device:throttled', (d) => resolve('throttled:' + d.reason));
    s.on('device:auth-error', (d) => resolve('auth-error:' + d.error));
    setTimeout(() => resolve('timeout'), 4000);
  });
  assert.equal(res, 'accepted', 'reconnect accepted');
  return s;
}

// The preload's marker for one device, printed just before it holds that device's
// offline UPDATE open.
const markerRe = (id) => new RegExp(`\\[slow-offline-update\\] delaying ${SLOW_MS}ms for ${id}`, 'g');
const markersFor = (id) => (srv.output().match(markerRe(id)) || []).length;
// Wait until this device's NEXT marker appears (one more than `before`, the count taken
// before the action); returns the time it was seen.
async function waitForSlowOffline(id, before, timeoutMs) {
  await srv.waitForOutput(new RegExp(`(?:${markerRe(id).source}[\\s\\S]*?){${before + 1}}`), timeoutMs);
  return Date.now();
}

const dbStatus = async (id) => (await db.prepare('SELECT status FROM devices WHERE id = ?').get(id)).status;
const lastLogged = async (id) => {
  const row = await db.prepare('SELECT status FROM device_status_log WHERE device_id = ? ORDER BY id DESC LIMIT 1').get(id);
  return row ? row.status : null;
};
const lastDashStatus = (id) => {
  const mine = dashEvents.filter((e) => e.device_id === id);
  return mine.length ? mine[mine.length - 1].status : null;
};

// The reconnected socket is the incumbent: a dashboard screenshot request (relayed only
// when the device has a heartbeat connection entry) reaches it.
async function assertIncumbent(s, id) {
  assert.equal(s.connected, true, 'the reconnected socket is still connected');
  const got = new Promise((resolve) => { s.once('device:screenshot-request', () => resolve(true)); setTimeout(() => resolve(false), 2000); });
  dash.emit('dashboard:request-screenshot', { device_id: id });
  assert.equal(await got, true, 'the reconnected socket receives server events as the incumbent');
}

// After the reconnect, the delayed offline write + its follow-ups must settle, and the
// status-log writer must flush, before asserting.
const settle = () => sleep(SLOW_MS + 1000 + 3 * FLUSH_MS);

test('Path A: a reconnect during the debounced offline UPDATE leaves the device online', async () => {
  const d = await provisionAndPair('Race A');
  await sleep(500);
  assert.equal(await dbStatus(d.id), 'online', 'precondition: paired + connected -> online');

  const from = markersFor(d.id);
  const closedAt = Date.now();
  d.sock.close();                                         // -> offlineTransition after the 5s debounce
  const startedAt = await waitForSlowOffline(d.id, from, DEBOUNCE_MS + 4000);
  assert.ok(startedAt - closedAt >= DEBOUNCE_MS - 200, 'the offline UPDATE started only after the debounce');

  const s2 = await reconnect(d.id, d.token);              // inside the held-open offline UPDATE
  assert.ok(Date.now() - startedAt < SLOW_MS, 'the reconnect completed inside the race window');
  await settle();

  assert.equal(await dbStatus(d.id), 'online', 'devices.status ends online');
  const logged = await lastLogged(d.id);
  assert.ok(logged !== 'offline' && logged !== 'offline_timeout', `last status-log entry is not offline (got ${logged})`);
  assert.equal(lastDashStatus(d.id), 'online', 'the last dashboard:device-status for the device is online');
  await assertIncumbent(s2, d.id);
});

test('Path B: a reconnect during the heartbeat-timeout offline UPDATE leaves the device online', async () => {
  const d = await provisionAndPair('Race B');
  await sleep(500);
  // Get to "no live socket": disconnect and let the ordinary offline transition finish.
  let from = markersFor(d.id);
  d.sock.close();
  await waitForSlowOffline(d.id, from, DEBOUNCE_MS + 4000);
  await sleep(SLOW_MS + 1000);
  assert.equal(await dbStatus(d.id), 'offline', 'precondition: the plain disconnect ended offline');

  // Now "online in DB, stale heartbeat, no live socket" — the checker's case.
  from = markersFor(d.id);
  await db.prepare("UPDATE devices SET status = 'online', last_heartbeat = UNIX_TIMESTAMP() - 3600 WHERE id = ?").run(d.id);
  const startedAt = await waitForSlowOffline(d.id, from, 5000);

  const s2 = await reconnect(d.id, d.token);              // inside the held-open checker UPDATE
  assert.ok(Date.now() - startedAt < SLOW_MS, 'the reconnect completed inside the race window');
  await settle();

  assert.equal(await dbStatus(d.id), 'online', 'devices.status ends online');
  const logged = await lastLogged(d.id);
  assert.ok(logged !== 'offline' && logged !== 'offline_timeout', `last status-log entry is not offline (got ${logged})`);
  assert.equal(lastDashStatus(d.id), 'online', 'the last dashboard:device-status for the device is online');
  await assertIncumbent(s2, d.id);
});
