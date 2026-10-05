'use strict';

// Ref 50 — POST /api/devices/:id/command (single-device screen_off / screen_on / ...).
// Ref 47 — the kiosk lockdown commands on it and on POST /api/groups/:id/command need
// workspace admin or above (canAdminWorkspace on the target's own workspace).
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
  ({ app, base, db, stop } = await startInProcessApp({ only: ['/api/auth', '/api/devices', '/api/groups'] }));
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

// ===================== Ref 47: kiosk lockdown commands =====================

const LOCKDOWN = ['enable_kiosk_lockdown', 'disable_kiosk_lockdown'];

// One workspace (owned by an org_owner) with a device and a group containing it, plus a
// user for each role under test. Built once - registering users is the slow part.
let roles;
async function roleFixture() {
  if (roles) return roles;
  const tag = randTag();
  const regUser = async (name) => (await jf('/api/auth/register', reg({ email: `devcmd-${name}-${tag}@x.local`, password: 'Passw0rd123' }))).body;
  const owner = await regUser('owner');
  const others = {};
  for (const n of ['wsadmin', 'editor', 'viewer', 'platadmin', 'superadmin', 'operator']) others[n] = await regUser(n);
  // Members before the owner (cleanupUsers refuses an owner whose org still has members).
  created.userIds.push(...Object.values(others).map((u) => u.user.id), owner.user.id);
  const ws = owner.current_workspace_id;
  const member = (u, role) => db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)').run(ws, u.user.id, role);
  await member(others.wsadmin, 'workspace_admin');
  await member(others.editor, 'workspace_editor');
  await member(others.viewer, 'workspace_viewer');
  const setRole = (u, role) => db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, u.user.id);
  await setRole(others.platadmin, 'platform_admin');
  await setRole(others.superadmin, 'superadmin');
  await setRole(others.operator, 'platform_operator');

  const deviceId = 'devcmd-lock-' + tag;
  const groupId = 'devcmd-grp-' + tag;
  await db.prepare("INSERT INTO devices (id, name, status, workspace_id) VALUES (?, 'L', 'offline', ?)").run(deviceId, ws);
  await db.prepare("INSERT INTO device_groups (id, user_id, workspace_id, name) VALUES (?, ?, ?, 'Lockdown group')").run(groupId, owner.user.id, ws);
  await db.prepare('INSERT INTO device_group_members (device_id, group_id) VALUES (?, ?)').run(deviceId, groupId);
  const tok = { owner: owner.token };
  for (const [n, u] of Object.entries(others)) tok[n] = u.token;
  roles = { tok, deviceId, groupId };
  return roles;
}

const sendDevice = (tok, deviceId, type) => jf(`/api/devices/${deviceId}/command`, cmd(tok, { type }));
const sendGroup = (tok, groupId, type) => jf(`/api/groups/${groupId}/command`, cmd(tok, { type }));

test('lockdown: workspace admin, org owner, platform_admin and superadmin may send both commands (device route)', async () => {
  const { tok, deviceId } = await roleFixture();
  online.add(deviceId);
  for (const who of ['wsadmin', 'owner', 'platadmin', 'superadmin']) {
    for (const type of LOCKDOWN) {
      emitted.length = 0;
      const r = await sendDevice(tok[who], deviceId, type);
      assert.equal(r.status, 200, `${who} ${type}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.delivered, true);
      assert.deepEqual(emitted, [{ room: deviceId, event: 'device:command', data: { type, payload: {} } }]);
    }
  }
});

test('lockdown: editor and platform_operator get 403 with a clear message; viewer stays 403 (device route)', async () => {
  const { tok, deviceId } = await roleFixture();
  online.add(deviceId);
  for (const who of ['editor', 'operator']) {
    for (const type of LOCKDOWN) {
      const r = await sendDevice(tok[who], deviceId, type);
      assert.equal(r.status, 403, `${who} ${type}`);
      assert.equal(r.body.error, 'Kiosk lockdown commands require workspace admin access');
    }
  }
  for (const type of LOCKDOWN) assert.equal((await sendDevice(tok.viewer, deviceId, type)).status, 403);
  assert.equal(emitted.length, 0, 'nothing emitted for a refused lockdown command');
  online.clear();
  assert.equal((await sendDevice(tok.editor, deviceId, 'enable_kiosk_lockdown')).status, 403);
  assert.equal(commandQueue.getQueueDepth(deviceId), 0, 'nothing queued for a refused lockdown command');
});

test('lockdown: existing command types keep their current gate for the same roles (device route)', async () => {
  const { tok, deviceId } = await roleFixture();
  online.add(deviceId);
  for (const who of ['editor', 'operator', 'wsadmin']) {
    assert.equal((await sendDevice(tok[who], deviceId, 'screen_off')).status, 200, who);
  }
  assert.equal((await sendDevice(tok.viewer, deviceId, 'screen_off')).status, 403, 'viewer still read-only');
  assert.equal((await sendDevice(tok.wsadmin, deviceId, 'wipe_device')).status, 400, 'unknown types still rejected');
});

test('lockdown: group route - admins allowed, editor/operator 403, viewer 403, other types unchanged, unknown 400', async () => {
  const { tok, groupId, deviceId } = await roleFixture();
  online.add(deviceId);
  for (const who of ['wsadmin', 'owner', 'platadmin', 'superadmin']) {
    for (const type of LOCKDOWN) {
      const r = await sendGroup(tok[who], groupId, type);
      assert.equal(r.status, 200, `${who} ${type}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.sent, 1);
    }
  }
  emitted.length = 0;
  for (const who of ['editor', 'operator']) {
    for (const type of LOCKDOWN) {
      const r = await sendGroup(tok[who], groupId, type);
      assert.equal(r.status, 403, `${who} ${type}`);
      assert.equal(r.body.error, 'Kiosk lockdown commands require workspace admin access');
    }
  }
  assert.equal((await sendGroup(tok.viewer, groupId, 'enable_kiosk_lockdown')).status, 403);
  assert.equal(emitted.length, 0, 'nothing emitted for refused group lockdown commands');
  for (const who of ['editor', 'operator']) assert.equal((await sendGroup(tok[who], groupId, 'screen_on')).status, 200, who);
  assert.equal((await sendGroup(tok.viewer, groupId, 'screen_on')).status, 403);
  assert.equal((await sendGroup(tok.wsadmin, groupId, 'format_disk')).status, 400);
});
