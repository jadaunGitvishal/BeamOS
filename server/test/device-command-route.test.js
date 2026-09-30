'use strict';

// Ref 50 — POST /api/devices/:id/command (single-device screen_off / screen_on / ...).
// Proves: a workspace_viewer is rejected (write gate), an unknown command type is
// rejected, an ONLINE device gets device:command emitted to its room, and an OFFLINE
// device gets the command held in lib/command-queue.js instead of silently dropped.
//
// In-process against the real MySQL database (test/helpers/inprocess-app.js), same
// pattern as block-authz.test.js. Socket.IO is NOT started - the route only touches
// io.of('/device').adapter.rooms + .to(room).emit, so a recording fake is set as the
// app's 'io' (exactly what server.js does with the real one via app.set('io', io)).

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startInProcessApp } = require('./helpers/inprocess-app');
const { randTag, cleanupUsers } = require('./helpers/disposable');
const commandQueue = require('../lib/command-queue');

let base, db, stop, app;
const created = { userIds: [] };

// Recording fake of the /device namespace. `online` = device ids with a live socket.
const online = new Set();
const emitted = [];
const fakeIo = {
  of: (nsp) => {
    assert.equal(nsp, '/device', 'route must target the /device namespace');
    return {
      adapter: { rooms: { get: (id) => (online.has(id) ? new Set(['sock-' + id]) : undefined) } },
      to: (room) => ({ emit: (event, data) => emitted.push({ room, event, data }) }),
    };
  },
};

before(async () => {
  ({ app, base, db, stop } = await startInProcessApp({ only: ['/api/auth', '/api/devices'] }));
  app.set('io', fakeIo);
});
after(async () => {
  commandQueue._resetForTests();
  await cleanupUsers(db, created.userIds);
  await stop();
});
beforeEach(() => {
  online.clear();
  emitted.length = 0;
  commandQueue._resetForTests();
});

const jf = async (p, opts = {}) => { const r = await fetch(base + p, opts); let b = null; try { b = await r.json(); } catch { /* */ } return { status: r.status, body: b }; };
const reg = (o) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });
const cmd = (tok, body) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
  body: JSON.stringify(body),
});

// Owner A with a device in A's workspace; B is a workspace_viewer of that workspace.
async function fixture() {
  const tag = randTag();
  const a = (await jf('/api/auth/register', reg({ email: `devcmd-a-${tag}@x.local`, password: 'Passw0rd123' }))).body;
  const b = (await jf('/api/auth/register', reg({ email: `devcmd-b-${tag}@x.local`, password: 'Passw0rd123' }))).body;
  // B before A: cleanupUsers refuses to delete an org owner while their org has other members.
  created.userIds.push(b.user.id, a.user.id);
  const wsA = a.current_workspace_id;
  const deviceId = 'devcmd-dev-' + tag;
  await db.prepare("INSERT INTO devices (id, name, status, workspace_id) VALUES (?, 'D', 'offline', ?)").run(deviceId, wsA);
  await db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_viewer')").run(wsA, b.user.id);
  return { owner: a.token, viewer: b.token, deviceId };
}

test('a workspace_viewer cannot send a command (403, nothing emitted or queued)', async () => {
  const { viewer, deviceId } = await fixture();
  online.add(deviceId);
  const r = await jf(`/api/devices/${deviceId}/command`, cmd(viewer, { type: 'screen_off' }));
  assert.equal(r.status, 403, 'viewer is read-only');
  assert.equal(emitted.length, 0, 'nothing emitted for a denied request');
  online.clear();
  const r2 = await jf(`/api/devices/${deviceId}/command`, cmd(viewer, { type: 'screen_off' }));
  assert.equal(r2.status, 403, 'viewer denied for an offline device too');
  assert.equal(commandQueue.getQueueDepth(deviceId), 0, 'nothing queued for a denied request');
});

test('an invalid command type is rejected (400, nothing emitted or queued)', async () => {
  const { owner, deviceId } = await fixture();
  online.add(deviceId);
  const bad = await jf(`/api/devices/${deviceId}/command`, cmd(owner, { type: 'sim_deactivate' }));
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'invalid command type');
  const missing = await jf(`/api/devices/${deviceId}/command`, cmd(owner, {}));
  assert.equal(missing.status, 400, 'missing type rejected');
  assert.equal(emitted.length, 0, 'nothing emitted');
  online.clear();
  assert.equal((await jf(`/api/devices/${deviceId}/command`, cmd(owner, { type: 'format_disk' }))).status, 400);
  assert.equal(commandQueue.getQueueDepth(deviceId), 0, 'nothing queued');
});

test('online device: device:command is emitted to its room', async () => {
  const { owner, deviceId } = await fixture();
  online.add(deviceId);
  for (const type of ['screen_off', 'screen_on']) {
    emitted.length = 0;
    const r = await jf(`/api/devices/${deviceId}/command`, cmd(owner, { type }));
    assert.equal(r.status, 200);
    assert.equal(r.body.delivered, true);
    assert.equal(r.body.queued, false);
    assert.deepEqual(emitted, [{ room: deviceId, event: 'device:command', data: { type, payload: {} } }]);
  }
  assert.equal(commandQueue.getQueueDepth(deviceId), 0, 'online delivery does not also queue');
});

test('offline device: the command is queued and flushed on reconnect', async () => {
  const { owner, deviceId } = await fixture();
  const r = await jf(`/api/devices/${deviceId}/command`, cmd(owner, { type: 'screen_off' }));
  assert.equal(r.status, 200);
  assert.equal(r.body.delivered, false);
  assert.equal(r.body.queued, true);
  assert.ok(r.body.queue_ttl_seconds > 0, 'response tells the dashboard how long the queue holds it');
  assert.equal(emitted.length, 0, 'nothing emitted to an empty room');
  assert.equal(commandQueue.getQueueDepth(deviceId), 1, 'command held in the queue');

  // Device reconnects: the register path's flushQueue delivers exactly what was queued.
  const flushed = [];
  const ns = { to: (room) => ({ emit: (event, data) => flushed.push({ room, event, data }) }) };
  await commandQueue.flushQueue(ns, deviceId, null);
  assert.deepEqual(flushed, [{ room: deviceId, event: 'device:command', data: { type: 'screen_off', payload: {} } }]);
});
