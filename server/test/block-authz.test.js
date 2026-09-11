'use strict';

// #146 P1.4 — POST /api/devices/:id/{block,unblock} is a real lever now; its authz path
// must be covered, not just the happy path. Proves: the owner can block; a
// cross-workspace user CANNOT; a workspace_viewer CANNOT; unauthenticated CANNOT.
//
// In-process against the real MySQL database (see test/helpers/inprocess-app.js) -
// mounts the real /api/auth + /api/devices routers in this process, no spawned
// server.js, no legacy flat-file SQLite. Every row this test creates is disposable
// and removed in after() (test/helpers/disposable.js).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startInProcessApp } = require('./helpers/inprocess-app');
const { randTag, cleanupUsers } = require('./helpers/disposable');

let base, db, stop;
const created = { userIds: [] };

before(async () => {
  ({ base, db, stop } = await startInProcessApp({ only: ['/api/auth', '/api/devices'] }));
});
after(async () => {
  await cleanupUsers(db, created.userIds);
  await stop();
});

const jf = async (p, opts = {}) => { const r = await fetch(base + p, opts); let b = null; try { b = await r.json(); } catch { /* */ } return { status: r.status, body: b }; };
const reg = (o) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });
const post = (tok) => ({ method: 'POST', headers: tok ? { Authorization: 'Bearer ' + tok } : {} });

test('block/unblock authz: owner allowed; cross-workspace, viewer, and anon denied', async () => {
  const tag = randTag();
  const emailA = `blockauthz-a-${tag}@x.local`;
  const emailB = `blockauthz-b-${tag}@x.local`;
  const a = (await jf('/api/auth/register', reg({ email: emailA, password: 'Passw0rd123' }))).body;
  const b = (await jf('/api/auth/register', reg({ email: emailB, password: 'Passw0rd123' }))).body;
  const jwtA = a.token, jwtB = b.token;
  // B first: the test adds B as a workspace_member of A's workspace below, and
  // deleteUserCascade refuses to delete an org owner (A) while their org still
  // has another member — clean up in dependency order.
  created.userIds.push(b.user.id, a.user.id);
  assert.ok(jwtA && jwtB, 'both users registered');

  const wsA = a.current_workspace_id;

  // a device in A's workspace
  const deviceId = 'blockauthz-dev-' + tag;
  await db.prepare("INSERT INTO devices (id, name, status, workspace_id) VALUES (?, 'D', 'offline', ?)").run(deviceId, wsA);

  // 1) anon -> 401
  assert.equal((await jf(`/api/devices/${deviceId}/block`, post(null))).status, 401, 'unauthenticated cannot block');

  // 2) cross-workspace user B (not a member of A's workspace) -> 403
  assert.equal((await jf(`/api/devices/${deviceId}/block`, post(jwtB))).status, 403, 'cross-workspace user cannot block');

  // 3) owner A -> 200, and the DB reflects it
  const okBlock = await jf(`/api/devices/${deviceId}/block`, post(jwtA));
  assert.equal(okBlock.status, 200, 'owner can block');
  assert.equal((await db.prepare('SELECT blocked FROM devices WHERE id = ?').get(deviceId)).blocked, 1, 'blocked persisted');

  // 4) make B a workspace_viewer in A's workspace -> still denied (read-only)
  await db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_viewer')").run(wsA, b.user.id);
  assert.equal((await jf(`/api/devices/${deviceId}/unblock`, post(jwtB))).status, 403, 'a workspace_viewer cannot unblock');
  assert.equal((await db.prepare('SELECT blocked FROM devices WHERE id = ?').get(deviceId)).blocked, 1, 'still blocked — viewer write was denied');

  // 5) owner A can unblock -> 200
  assert.equal((await jf(`/api/devices/${deviceId}/unblock`, post(jwtA))).status, 200, 'owner can unblock');
  assert.equal((await db.prepare('SELECT blocked FROM devices WHERE id = ?').get(deviceId)).blocked, 0, 'unblocked');
});
