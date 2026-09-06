'use strict';

// Found during Ref 35 Stage C testing: ws/dashboardSocket.js used to register every
// socket.on('dashboard:*', ...) listener AFTER `await accessibleWorkspaceIds(...)` (a
// real DB query) in the connection handler. A client's 'connect' event fires as soon as
// the transport handshake completes, independent of how long that async setup takes -
// so a client emitting a dashboard:* event immediately on 'connect' could beat the
// server to registering listeners. socket.io has no handler to invoke at that point, so
// the event (and any ack) is silently dropped: no error, just a timed-out ack.
//
// This bit in practice as an intermittent, hard-to-explain timeout on the FIRST
// dashboard:device-command after a period of inactivity (a cold MySQL pool connection
// widens the race window), succeeding immediately on retry. Reproduced here with a
// controllable artificial delay standing in for that cold-query latency, so the test
// doesn't depend on real DB timing to be reliable.
//
// Fix: listener registration no longer waits on accessibleWorkspaceIds() at all - none
// of the handlers use its result (they resolve permissions per-call via
// canActOnDevice()). Only the room-join genuinely needs it, so only that stays gated on
// the await.

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.JWT_SECRET = 'test-secret-dashboard-socket-race';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Database = require('better-sqlite3');
const { Server } = require('socket.io');
const ioClient = require('socket.io-client');

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE devices (id TEXT PRIMARY KEY, workspace_id TEXT, status TEXT, user_id TEXT, created_at INTEGER);
  CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT);
  CREATE TABLE play_logs (id INTEGER PRIMARY KEY, started_at INTEGER);
  CREATE TABLE device_usage_daily (day TEXT);
`);
db.prepare('INSERT INTO devices (id, workspace_id) VALUES (?, ?)').run('dev-1', 'ws-1');
db.prepare('INSERT INTO workspaces (id, name) VALUES (?, ?)').run('ws-1', 'WS One');
const dbModulePath = require.resolve('../db/database');
require.cache[dbModulePath] = { id: dbModulePath, filename: dbModulePath, loaded: true, exports: { db } };

// Controllable delay standing in for a cold MySQL pool connection's added latency on
// the first query after inactivity - the real-world condition that widened this race.
let accessibleWorkspacesDelayMs = 0;
const tenancyModulePath = require.resolve('../lib/tenancy');
require.cache[tenancyModulePath] = {
  id: tenancyModulePath, filename: tenancyModulePath, loaded: true,
  exports: {
    accessibleWorkspaceIds: async () => {
      if (accessibleWorkspacesDelayMs > 0) await new Promise((r) => setTimeout(r, accessibleWorkspacesDelayMs));
      return ['ws-1'];
    },
    accessContext: async () => ({ actingAs: true }),
  },
};

const { generateToken } = require('../middleware/auth');
const setupDashboardSocket = require('../ws/dashboardSocket');

let httpServer, io, base, deviceSocket;

test.before(async () => {
  httpServer = http.createServer();
  io = new Server(httpServer);
  setupDashboardSocket(io);
  // Minimal /device namespace: a fake device socket joins its own device_id room,
  // exactly like the real ws/deviceSocket.js (socket.join(device_id)), so
  // dashboard:device-command takes the "online, deliver immediately" branch.
  io.of('/device').on('connection', (socket) => {
    socket.on('register', (deviceId) => socket.join(deviceId));
  });
  await new Promise((r) => httpServer.listen(0, r));
  base = `http://127.0.0.1:${httpServer.address().port}`;

  deviceSocket = ioClient(`${base}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
  await new Promise((r) => deviceSocket.on('connect', r));
  deviceSocket.emit('register', 'dev-1');
  await new Promise((r) => setTimeout(r, 100));
});

test.after(async () => {
  try { deviceSocket.close(); } catch { /* */ }
  try { await new Promise((r) => io.close(r)); } catch { /* */ }
  try { httpServer.close(); } catch { /* */ }
  db.close();
});

const token = () => generateToken({ id: 'u-1', email: 'u@test.local', role: 'user' }, 'ws-1');

// Emits dashboard:device-command SYNCHRONOUSLY inside the 'connect' handler - the exact
// technique that surfaced the real race (a real dashboard command sent right after the
// socket connects, same as a script/page that doesn't wait for anything after connect).
function emitImmediatelyOnConnect(deviceId, type) {
  return new Promise((resolve) => {
    const sock = ioClient(`${base}/dashboard`, { auth: { token: token() }, transports: ['websocket'], reconnection: false, forceNew: true });
    let settled = false;
    const finish = (result) => { if (!settled) { settled = true; sock.close(); resolve(result); } };
    sock.on('connect', () => {
      sock.emit('dashboard:device-command', { device_id: deviceId, type, payload: {} }, (ack) => finish({ timedOut: false, ack }));
      setTimeout(() => finish({ timedOut: true, ack: null }), 2000);
    });
    sock.on('connect_error', (e) => finish({ timedOut: true, error: e.message }));
  });
}

test('regression: dashboard:device-command emitted immediately on connect is NOT dropped, even with a slow accessibleWorkspaceIds()', async () => {
  accessibleWorkspacesDelayMs = 300; // stands in for a cold DB connection after inactivity
  const result = await emitImmediatelyOnConnect('dev-1', 'test_type');
  accessibleWorkspacesDelayMs = 0;
  assert.equal(result.timedOut, false, 'the event must not be silently dropped');
  assert.deepEqual(result.ack, { delivered: true }, 'a real device online in its room gets a real delivered ack');
});

test('regression: still correct with an even larger delay (registration has NO dependency on it at all)', async () => {
  accessibleWorkspacesDelayMs = 1500;
  const result = await emitImmediatelyOnConnect('dev-1', 'test_type');
  accessibleWorkspacesDelayMs = 0;
  assert.equal(result.timedOut, false);
  assert.deepEqual(result.ack, { delivered: true });
});

test('sanity: the normal (zero-delay) fast path still works', async () => {
  const result = await emitImmediatelyOnConnect('dev-1', 'test_type');
  assert.equal(result.timedOut, false);
  assert.deepEqual(result.ack, { delivered: true });
});
