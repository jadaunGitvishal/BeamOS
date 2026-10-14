'use strict';

// ws/dashboardSocket.js: the /dashboard 'connection' handler awaits
// accessibleWorkspaceIds() (a DB query) OUTSIDE any socket.on handler, so protectSocket
// never saw a failure there. A rejected lookup escaped as an unhandledRejection, which
// server.js treats as fatal: one dashboard connect hitting a DB error took the whole
// server down, dropping every device. Now it fails just that connection, the same way
// every socket handler does: log, server:error, disconnect.
//
// Spawns a REAL server.js with test/helpers/fail-query.js preloaded, making the user's
// workspace lookup fail ONCE (matched by its SQL text + this run's user id), then
// checks: the failing dashboard socket gets server:error and is disconnected, the
// server stays up (/api/status 200, process alive), an already-connected device socket
// is untouched, and the next dashboard connect for the same user succeeds. Real MySQL
// test DB (beamos_test via npm test); fixtures are test-owned (dcf- prefix) and removed
// afterwards.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const ioClient = require('socket.io-client');
const config = require('../config');
const { db } = require('../db/database');
const { generateToken } = require('../middleware/auth');
const { randTag, cleanupUsers } = require('./helpers/disposable');
const { startServer } = require('./helpers/spawn-server');

const P = `dcf-${randTag()}`;
const ID = { user: `${P}-user`, org: `${P}-org`, ws: `${P}-ws` };
// The non-platform branch of lib/tenancy.js accessibleWorkspaceIds.
const LOOKUP_SQL = 'SELECT workspace_id AS id FROM workspace_members WHERE user_id = ?';
const PAIRING_CODE = String(crypto.randomInt(100000, 1000000));
let srv;
let deviceId = null;
const sockets = [];

before(async () => {
  const run = (sql, ...p) => db.prepare(sql).run(...p);
  await run("INSERT INTO users (id, email, name, password_hash, auth_provider, role) VALUES (?, ?, ?, NULL, 'local', 'user')", ID.user, `${ID.user}@x.local`, ID.user);
  await run("INSERT INTO organizations (id, name, owner_user_id, plan_id, subscription_status) VALUES (?, ?, ?, 'enterprise', 'active')", ID.org, `${P} Org`, ID.user);
  await run('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)', ID.ws, ID.org, `${P} WS`);
  await run("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin')", ID.ws, ID.user);
  srv = await startServer({
    name: 'dashboard-connect-failure',
    nodeArgs: ['--require', path.join(__dirname, 'helpers', 'fail-query.js')],
    // JWT_SECRET: this file signs the dashboard token itself, so the server must verify
    // with the same secret. Without JWT_SECRET (as in CI) each process would derive its
    // own from <DATA_DIR>/certs/.jwt_secret, and the child has its own DATA_DIR.
    env: { FAIL_QUERY_SQL: LOOKUP_SQL, FAIL_QUERY_ID: ID.user, JWT_SECRET: config.jwtSecret },
  });
});

after(async () => {
  for (const s of sockets) { try { s.close(); } catch { /* */ } }
  try {
    if (srv) await srv.stop();
    if (deviceId) {
      await db.prepare('DELETE FROM device_status_log WHERE device_id = ?').run(deviceId);
      await db.prepare('DELETE FROM devices WHERE id = ?').run(deviceId);
    }
    await db.prepare('DELETE FROM devices WHERE pairing_code = ?').run(PAIRING_CODE);
    await cleanupUsers(db, [ID.user]);
  } finally {
    await db.close();
  }
});

// A device that registers first and must stay connected throughout.
function connectDevice() {
  return new Promise((resolve, reject) => {
    const s = ioClient(`${srv.base}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
    sockets.push(s);
    const state = { sock: s, disconnects: [] };
    s.on('disconnect', (reason) => state.disconnects.push(reason));
    s.on('connect', () => s.emit('device:register', { pairing_code: PAIRING_CODE, device_info: {} }));
    s.on('device:registered', (d) => { deviceId = d.device_id; resolve(state); });
    s.on('connect_error', reject);
    setTimeout(() => reject(new Error('device did not register')), 5000);
  });
}

// One dashboard connection; records server:error and disconnect reasons. Settles on
// disconnect, or after `ms` while still connected.
function connectDashboard(ms = 1500) {
  return new Promise((resolve) => {
    const s = ioClient(`${srv.base}/dashboard`, {
      auth: { token: generateToken({ id: ID.user, email: `${ID.user}@x.local`, role: 'user' }, ID.ws) },
      transports: ['websocket'], reconnection: false, forceNew: true,
    });
    sockets.push(s);
    const got = { connected: false, serverErrors: [], disconnectReason: null, sock: s };
    s.on('connect', () => { got.connected = true; });
    s.on('server:error', (e) => got.serverErrors.push(e));
    s.on('disconnect', (reason) => { got.disconnectReason = reason; resolve(got); });
    s.on('connect_error', (e) => { got.connectError = e.message; resolve(got); });
    setTimeout(() => resolve(got), ms);
  });
}

// The child's exit, or null if still running after ms.
async function exitWithin(ms) {
  let t;
  const timeout = new Promise((r) => { t = setTimeout(() => r(null), ms); });
  try { return await Promise.race([srv.exited, timeout]); } finally { clearTimeout(t); }
}

test('a DB failure during a dashboard connect fails only that socket: server stays up, device unaffected, next connect works', async () => {
  const device = await connectDevice();
  assert.ok(deviceId, 'device registered');

  const first = await connectDashboard();
  assert.equal(first.connectError, undefined, `dashboard handshake rejected: ${first.connectError}`);
  assert.match(srv.output(), /\[fail-query\] failing /, 'the injected lookup failure fired');
  assert.equal(first.connected, true, 'the handshake itself succeeded');
  assert.deepEqual(first.serverErrors, [{ event: 'connection', error: 'internal error, please reconnect' }], 'the socket is told');
  assert.equal(first.disconnectReason, 'io server disconnect', 'the server disconnected just that socket');
  assert.match(
    srv.output(),
    new RegExp(`\\[socket:connection\\] handler threw for ${ID.user} \\(\\S+\\) — disconnecting this socket \\(server stays up\\):\\r?\\nError: fail-query: injected failure`),
    'the failure is logged (user, socket, error)',
  );

  // The server process is still alive and serving.
  assert.equal(await exitWithin(1000), null, 'server.js did not exit');
  assert.equal((await fetch(`${srv.base}/api/status`)).status, 200);
  assert.doesNotMatch(srv.output(), /FATAL unhandledRejection/);

  // The device socket never noticed.
  assert.equal(device.sock.connected, true, 'device still connected');
  assert.deepEqual(device.disconnects, []);

  // The same user connects normally next time (the failure was one-shot).
  const second = await connectDashboard(1500);
  assert.equal(second.connected, true);
  assert.deepEqual(second.serverErrors, []);
  assert.equal(second.disconnectReason, null, 'stays connected');
  await srv.waitForOutput(new RegExp(`Dashboard client connected: \\S+ \\(user: ${ID.user}, rooms: 1\\)`), 3000);
});
