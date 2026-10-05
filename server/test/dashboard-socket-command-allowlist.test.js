'use strict';

// Security ticket found during Ref 47: ws/dashboardSocket.js dashboard:device-command
// used to forward ANY command type (online emit or offline queue) once canActOnDevice
// passed - so a workspace editor could send enable_kiosk_lockdown over the socket and
// skip the workspace-admin gate the REST route enforces. Now: the existing
// canActOnDevice check still runs first; then lockdown types are refused with
// reason 'use_rest' and anything outside SOCKET_COMMANDS (lib/device-commands.js -
// exactly the main app's socket set) with reason 'unsupported_command', before both
// the emit and the queue.
//
// Same in-process harness as dashboard-socket-listener-race.test.js: real socket.io
// server + client, better-sqlite3 in-memory db and a stubbed lib/tenancy via the
// require cache. accessContext is stubbed per user id to model each role.

process.env.JWT_SECRET = 'test-secret-dashboard-socket-allowlist';

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
  CREATE TABLE users (id TEXT PRIMARY KEY, deactivated_at INTEGER);
`);
const USERS = ['u-editor', 'u-wsadmin', 'u-platadmin', 'u-viewer'];
for (const id of USERS) db.prepare('INSERT INTO users (id) VALUES (?)').run(id);
db.prepare('INSERT INTO workspaces (id, name) VALUES (?, ?)').run('ws-1', 'WS One');
db.prepare('INSERT INTO devices (id, workspace_id) VALUES (?, ?)').run('dev-online', 'ws-1');
db.prepare('INSERT INTO devices (id, workspace_id) VALUES (?, ?)').run('dev-offline', 'ws-1');
const dbModulePath = require.resolve('../db/database');
require.cache[dbModulePath] = { id: dbModulePath, filename: dbModulePath, loaded: true, exports: { db } };

// Role per user, in accessContext's real return shape (lib/tenancy.js).
const CTX = {
  'u-editor': { workspaceRole: 'workspace_editor', actingAs: false },
  'u-wsadmin': { workspaceRole: 'workspace_admin', actingAs: false },
  'u-platadmin': { workspaceRole: null, actingAs: true },
  'u-viewer': { workspaceRole: 'workspace_viewer', actingAs: false },
};
const tenancyModulePath = require.resolve('../lib/tenancy');
require.cache[tenancyModulePath] = {
  id: tenancyModulePath, filename: tenancyModulePath, loaded: true,
  exports: {
    accessibleWorkspaceIds: async () => ['ws-1'],
    accessContext: async (userId) => CTX[userId] || null,
  },
};

const { generateToken } = require('../middleware/auth');
const heartbeat = require('../services/heartbeat');
const commandQueue = require('../lib/command-queue');
const { SOCKET_COMMANDS, LOCKDOWN_COMMANDS } = require('../lib/device-commands');
const setupDashboardSocket = require('../ws/dashboardSocket');

let httpServer, io, base, deviceSocket;
const received = []; // device:command payloads seen by the online device
let screenshotRequests = 0;
const dashSockets = {};

// console.warn spy (refusal logging): captured, not printed; restored in after().
const realWarn = console.warn;
const warnings = [];
console.warn = (...args) => { warnings.push(args.join(' ')); };

function connectDashboard(userId) {
  return new Promise((resolve, reject) => {
    const role = userId === 'u-platadmin' ? 'platform_admin' : 'user';
    const sock = ioClient(`${base}/dashboard`, {
      auth: { token: generateToken({ id: userId, email: `${userId}@test.local`, role }, 'ws-1') },
      transports: ['websocket'], reconnection: false, forceNew: true,
    });
    sock.on('connect', () => resolve(sock));
    sock.on('connect_error', reject);
  });
}

test.before(async () => {
  httpServer = http.createServer();
  io = new Server(httpServer);
  setupDashboardSocket(io);
  // Minimal /device namespace, as in the listener-race test: the fake device joins its
  // own room, so dev-online takes the "online, deliver now" branch; dev-offline has no socket.
  io.of('/device').on('connection', (socket) => {
    socket.on('register', (deviceId) => socket.join(deviceId));
  });
  await new Promise((r) => httpServer.listen(0, r));
  base = `http://127.0.0.1:${httpServer.address().port}`;

  deviceSocket = ioClient(`${base}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
  await new Promise((r) => deviceSocket.on('connect', r));
  deviceSocket.on('device:command', (data) => received.push(data));
  deviceSocket.on('device:screenshot-request', () => { screenshotRequests++; });
  deviceSocket.emit('register', 'dev-online');
  heartbeat.registerConnection('dev-online', deviceSocket.id); // for request-screenshot
  await new Promise((r) => setTimeout(r, 100));

  for (const u of USERS) dashSockets[u] = await connectDashboard(u);
});

test.after(async () => {
  console.warn = realWarn;
  for (const s of Object.values(dashSockets)) { try { s.close(); } catch { /* */ } }
  try { deviceSocket.close(); } catch { /* */ }
  heartbeat.removeConnection('dev-online');
  commandQueue._resetForTests();
  try { await new Promise((r) => io.close(r)); } catch { /* */ }
  try { httpServer.close(); } catch { /* */ }
  db.close();
});

test.beforeEach(() => {
  received.length = 0;
  warnings.length = 0;
  commandQueue._resetForTests();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Sends one dashboard:device-command and resolves with its ack.
function send(userId, deviceId, data) {
  return new Promise((resolve) => {
    dashSockets[userId].timeout(2000).emit('dashboard:device-command', { device_id: deviceId, payload: {}, ...data },
      (err, ack) => resolve(err ? { timedOut: true } : ack));
  });
}

test('editor, online device: each of the 10 main-app socket types is delivered to the device', async () => {
  assert.deepEqual([...SOCKET_COMMANDS].sort(), [
    'enable_system_capture', 'launch', 'reboot', 'request_location', 'screen_off',
    'screen_on', 'set_debug', 'settings', 'shutdown', 'update',
  ]);
  for (const type of SOCKET_COMMANDS) {
    const ack = await send('u-editor', 'dev-online', { type });
    assert.deepEqual(ack, { delivered: true }, type);
  }
  await sleep(150);
  assert.deepEqual(received.map((r) => r.type), SOCKET_COMMANDS);
  assert.equal(warnings.length, 0, 'no refusal logged for allowed types');
});

test('lockdown types over the socket -> use_rest, nothing delivered (editor, workspace admin, platform_admin)', async () => {
  for (const user of ['u-editor', 'u-wsadmin', 'u-platadmin']) {
    for (const type of LOCKDOWN_COMMANDS) {
      const ack = await send(user, 'dev-online', { type });
      assert.deepEqual(ack, { delivered: false, reason: 'use_rest' }, `${user} ${type}`);
    }
  }
  await sleep(150);
  assert.equal(received.length, 0, 'the device received nothing');
  assert.equal(warnings.length, 6, 'one warning per refusal');
  for (const w of warnings) assert.match(w, /lockdown commands are REST-only/);
  assert.ok(warnings[0].includes('u-editor') && warnings[0].includes('dev-online') && warnings[0].includes('enable_kiosk_lockdown'));
});

test('editor: excluded / made-up / missing / non-string types -> unsupported_command, nothing delivered', async () => {
  const cases = [
    { type: 'refresh' }, { type: 'pip_debug' }, { type: 'power_menu' }, { type: 'format_disk' },
    {}, { type: 42 }, { type: { evil: true } }, { type: ['screen_on'] },
  ];
  for (const data of cases) {
    const ack = await send('u-editor', 'dev-online', data);
    assert.deepEqual(ack, { delivered: false, reason: 'unsupported_command' }, JSON.stringify(data));
  }
  await sleep(150);
  assert.equal(received.length, 0, 'the device received nothing');
  assert.equal(warnings.length, cases.length, 'one warning per refusal');
  assert.ok(warnings.every((w) => w.includes('u-editor') && w.includes('dev-online')));
  assert.ok(warnings[0].includes('"refresh"'));
});

test('offline device: a refused type is NOT queued; an allowed type is queued as before', async () => {
  for (const type of ['enable_kiosk_lockdown', 'refresh', 'format_disk']) {
    const ack = await send('u-editor', 'dev-offline', { type });
    assert.equal(ack.delivered, false);
    assert.ok(['use_rest', 'unsupported_command'].includes(ack.reason), type);
    assert.equal(ack.queued, undefined, 'refusal carries no queued flag');
  }
  assert.equal(commandQueue.getQueueDepth('dev-offline'), 0, 'nothing queued for refused types');
  assert.equal(warnings.length, 3);

  const ok = await send('u-editor', 'dev-offline', { type: 'screen_off' });
  assert.deepEqual(ok, { delivered: false, queued: true, reason: 'offline' });
  assert.equal(commandQueue.getQueueDepth('dev-offline'), 1);
});

test('viewer: the existing write check still runs first -> forbidden, nothing sent, no allowlist warning', async () => {
  for (const type of ['screen_on', 'enable_kiosk_lockdown', 'format_disk']) {
    const ack = await send('u-viewer', 'dev-online', { type });
    assert.deepEqual(ack, { delivered: false, reason: 'forbidden' }, type);
  }
  await sleep(150);
  assert.equal(received.length, 0);
  assert.equal(warnings.length, 0, 'forbidden is decided before the type check');
});

test('regression: dashboard:request-screenshot still reaches the device for an editor', async () => {
  const before = screenshotRequests;
  dashSockets['u-editor'].emit('dashboard:request-screenshot', { device_id: 'dev-online' });
  await sleep(200);
  assert.equal(screenshotRequests, before + 1);
});
