'use strict';

// Ref 7: GET/POST/DELETE /api/organizations/:orgId/entra-role-mappings over real
// HTTP (helpers/inprocess-app.js: real routes, real middleware incl. the
// activityLogger, REAL MySQL). Disposable, randomly tagged fixtures, deleted in
// after().

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { db, initDb } = require('../db/database');
const { startInProcessApp } = require('./helpers/inprocess-app');
const { randTag, cleanupUsers, cleanupUser } = require('./helpers/disposable');

const TAG = randTag();
const PASSWORD = 'ref7-map-pass-1';
let app;
const cleanup = [];
let owner, orgAdmin, wsEditor, tech, otherOwner, wsSecond;

async function j(method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${app.base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

async function registerUser(prefix, createOrg = true) {
  const email = `${prefix}-${randTag()}@ref7map.local`;
  const r = await j('POST', '/api/auth/register', { body: { email, password: PASSWORD, name: prefix, createOrg } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  cleanup.push(r.body.user.id);
  const ws = r.body.current_workspace_id
    ? await app.db.prepare('SELECT organization_id FROM workspaces WHERE id = ?').get(r.body.current_workspace_id)
    : null;
  return { id: r.body.user.id, email, token: r.body.token, workspaceId: r.body.current_workspace_id, orgId: ws?.organization_id };
}

const path = (orgId, id) => `/api/organizations/${orgId}/entra-role-mappings${id !== undefined ? `/${id}` : ''}`;
const claim = (n) => `Ref7Map.${n}.${TAG}`;

test.before(async () => {
  await initDb();
  app = await startInProcessApp({ only: ['/api/organizations'] });
  owner = await registerUser('ref7mapown');
  otherOwner = await registerUser('ref7mapother');
  orgAdmin = await registerUser('ref7mapadm', false);
  wsEditor = await registerUser('ref7mapedit', false);
  tech = await registerUser('ref7maptech', false);
  await app.db.prepare('INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, ?)').run(owner.orgId, orgAdmin.id, 'org_admin');
  await app.db.prepare('INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, ?)').run(owner.orgId, tech.id, 'field_technician');
  await app.db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)').run(owner.workspaceId, wsEditor.id, 'workspace_admin');
  wsSecond = crypto.randomUUID();
  await app.db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run(wsSecond, owner.orgId, `ref7map-ws2-${TAG}`);
});

test.after(async () => {
  try {
    if (app) {
      await cleanupUsers(app.db, cleanup.reverse());
    }
  } finally {
    if (app) await app.stop(); else await db.close();
  }
});

test('non-admins get 403 on list, add and delete (workspace admin, field technician, another org owner)', async () => {
  const ok = await j('POST', path(owner.orgId), { token: owner.token, body: { claim_value: claim('Gate'), role: 'org_admin' } });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  for (const u of [wsEditor, tech, otherOwner]) {
    assert.equal((await j('GET', path(owner.orgId), { token: u.token })).status, 403);
    assert.equal((await j('POST', path(owner.orgId), { token: u.token, body: { claim_value: claim('X'), role: 'org_admin' } })).status, 403);
    assert.equal((await j('DELETE', path(owner.orgId, ok.body.id), { token: u.token })).status, 403);
  }
  assert.equal((await j('GET', path(owner.orgId))).status, 401, 'no session');
  assert.equal((await j('DELETE', path(owner.orgId, ok.body.id), { token: owner.token })).status, 200);
});

test('role allowlist: org_owner / field_technician / platform roles / unknown -> 400', async () => {
  for (const role of ['org_owner', 'field_technician', 'platform_admin', 'superadmin', 'platform_operator', 'user', 'workspace_owner', 'Org_Admin', '', 42, null, '__proto__', 'toString']) {
    for (const workspace_id of [undefined, owner.workspaceId]) {
      const r = await j('POST', path(owner.orgId), { token: owner.token, body: { claim_value: claim('Roles'), role, workspace_id } });
      assert.equal(r.status, 400, `${role} / ${workspace_id}: ${JSON.stringify(r.body)}`);
    }
  }
  const n = await app.db.prepare('SELECT COUNT(*) AS n FROM entra_role_mappings WHERE organization_id = ?').get(owner.orgId);
  assert.equal(n.n, 0);
});

test('target must match the role: org_admin with a workspace_id, or a workspace role without one -> 400', async () => {
  const bad = [
    { claim_value: claim('T'), role: 'org_admin', workspace_id: owner.workspaceId },
    { claim_value: claim('T'), role: 'workspace_admin' },
    { claim_value: claim('T'), role: 'workspace_editor', workspace_id: null },
    { claim_value: claim('T'), role: 'workspace_viewer', workspace_id: '' },
    { claim_value: claim('T'), role: 'workspace_viewer', workspace_id: 12345 },
  ];
  for (const body of bad) {
    const r = await j('POST', path(owner.orgId), { token: owner.token, body });
    assert.equal(r.status, 400, `${JSON.stringify(body)} -> ${JSON.stringify(r.body)}`);
  }
});

test("a workspace of ANOTHER org (or a missing one) -> 400; nothing written", async () => {
  for (const ws of [otherOwner.workspaceId, crypto.randomUUID()]) {
    const r = await j('POST', path(owner.orgId), { token: owner.token, body: { claim_value: claim('Cross'), role: 'workspace_admin', workspace_id: ws } });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.error, /not a workspace of this organization/);
  }
  const n = await app.db.prepare('SELECT COUNT(*) AS n FROM entra_role_mappings WHERE claim_value = ?').get(claim('Cross'));
  assert.equal(n.n, 0);
});

test('claim_value validation: empty, whitespace, > 255, control characters, non-string -> 400; trimmed on save', async () => {
  for (const claim_value of ['', '   ', 'x'.repeat(256), 'a\nb', 'a\u0000b', 'tab\there', 'del\u007f', 'c1\u0085', 7, null, undefined, ['a']]) {
    const r = await j('POST', path(owner.orgId), { token: owner.token, body: { claim_value, role: 'org_admin' } });
    assert.equal(r.status, 400, `${JSON.stringify(claim_value)} -> ${JSON.stringify(r.body)}`);
  }
  const r = await j('POST', path(owner.orgId), { token: owner.token, body: { claim_value: `  ${claim('Trim')}  `, role: 'org_admin' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.claim_value, claim('Trim'));
  const long = 'L'.repeat(255);
  const r2 = await j('POST', path(owner.orgId), { token: owner.token, body: { claim_value: long, role: 'workspace_viewer', workspace_id: wsSecond } });
  assert.equal(r2.status, 201, '255 chars is allowed');
  await j('DELETE', path(owner.orgId, r.body.id), { token: owner.token });
  await j('DELETE', path(owner.orgId, r2.body.id), { token: owner.token });
});

test('duplicates -> 409 (org-level NULL target and workspace target); case differs -> allowed', async () => {
  const org1 = await j('POST', path(owner.orgId), { token: owner.token, body: { claim_value: claim('Dup'), role: 'org_admin' } });
  assert.equal(org1.status, 201);
  const org2 = await j('POST', path(owner.orgId), { token: owner.token, body: { claim_value: claim('Dup'), role: 'org_admin', workspace_id: null } });
  assert.equal(org2.status, 409, JSON.stringify(org2.body));
  const ws1 = await j('POST', path(owner.orgId), { token: owner.token, body: { claim_value: claim('Dup'), role: 'workspace_viewer', workspace_id: owner.workspaceId } });
  assert.equal(ws1.status, 201, 'same value, different target is fine');
  const ws2 = await j('POST', path(owner.orgId), { token: owner.token, body: { claim_value: claim('Dup'), role: 'workspace_admin', workspace_id: owner.workspaceId } });
  assert.equal(ws2.status, 409, 'one role per value and target');
  const upper = await j('POST', path(owner.orgId), { token: owner.token, body: { claim_value: claim('Dup').toUpperCase(), role: 'org_admin' } });
  assert.equal(upper.status, 201, 'exact (case-sensitive) values');
  // The DB constraint itself also rejects a NULL-workspace duplicate (not just the app check).
  await assert.rejects(
    app.db.prepare('INSERT INTO entra_role_mappings (organization_id, claim_value, workspace_id, role) VALUES (?, ?, NULL, ?)').run(owner.orgId, claim('Dup'), 'org_admin'),
    (e) => e.code === 'ER_DUP_ENTRY',
  );
  // Another org may map the same value.
  const other = await j('POST', path(otherOwner.orgId), { token: otherOwner.token, body: { claim_value: claim('Dup'), role: 'org_admin' } });
  assert.equal(other.status, 201);
  for (const [o, t, id] of [[owner, owner.token, org1.body.id], [owner, owner.token, ws1.body.id], [owner, owner.token, upper.body.id], [otherOwner, otherOwner.token, other.body.id]]) {
    assert.equal((await j('DELETE', path(o.orgId, id), { token: t })).status, 200);
  }
});

test("DELETE of another org's mapping (or a bad id) -> 404, mapping kept", async () => {
  const theirs = await j('POST', path(otherOwner.orgId), { token: otherOwner.token, body: { claim_value: claim('Theirs'), role: 'org_admin' } });
  assert.equal(theirs.status, 201);
  for (const id of [theirs.body.id, 999999999, 'abc', '1 OR 1=1', '-1']) {
    const r = await j('DELETE', path(owner.orgId, encodeURIComponent(id)), { token: owner.token });
    assert.equal(r.status, 404, `${id}: ${JSON.stringify(r.body)}`);
  }
  assert.ok(await app.db.prepare('SELECT 1 FROM entra_role_mappings WHERE id = ?').get(theirs.body.id));
  // GET of my org never lists theirs.
  const list = await j('GET', path(owner.orgId), { token: owner.token });
  assert.ok(!list.body.some((m) => m.id === theirs.body.id));
  assert.equal((await j('DELETE', path(otherOwner.orgId, theirs.body.id), { token: otherOwner.token })).status, 200);
});

test('happy path: org admin adds, lists (with workspace names) and deletes; mutations audit-logged', async () => {
  const a = await j('POST', path(owner.orgId), { token: orgAdmin.token, body: { claim_value: claim('Happy'), role: 'org_admin' } });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.deepEqual(Object.keys(a.body).sort(), ['claim_value', 'id', 'role', 'workspace_id', 'workspace_name']);
  const b = await j('POST', path(owner.orgId), { token: orgAdmin.token, body: { claim_value: claim('Happy'), role: 'workspace_editor', workspace_id: wsSecond } });
  assert.equal(b.status, 201, JSON.stringify(b.body));
  assert.equal(b.body.workspace_name, `ref7map-ws2-${TAG}`);

  const list = await j('GET', path(owner.orgId), { token: orgAdmin.token });
  assert.equal(list.status, 200);
  const mine = list.body.filter((m) => m.claim_value === claim('Happy'));
  assert.deepEqual(mine.map((m) => [m.role, m.workspace_id, m.workspace_name]), [
    ['org_admin', null, null],
    ['workspace_editor', wsSecond, `ref7map-ws2-${TAG}`],
  ]);
  const row = await app.db.prepare('SELECT created_by FROM entra_role_mappings WHERE id = ?').get(a.body.id);
  assert.equal(row.created_by, orgAdmin.id);

  assert.equal((await j('DELETE', path(owner.orgId, a.body.id), { token: orgAdmin.token })).status, 200);
  assert.equal((await j('DELETE', path(owner.orgId, a.body.id), { token: orgAdmin.token })).status, 404, 'already gone');
  assert.equal((await j('DELETE', path(owner.orgId, b.body.id), { token: owner.token })).status, 200);

  // activityLogger is fire-and-forget; give it a moment.
  await new Promise((r) => setTimeout(r, 200));
  const audit = await app.db
    .prepare("SELECT action FROM activity_log WHERE user_id = ? AND action LIKE '% /api/organizations/:orgId/entra-role-mappings%' ORDER BY id")
    .all(orgAdmin.id);
  assert.deepEqual(audit.map((r) => r.action), [
    'POST /api/organizations/:orgId/entra-role-mappings',
    'POST /api/organizations/:orgId/entra-role-mappings',
    'DELETE /api/organizations/:orgId/entra-role-mappings/:id',
  ]);
});

test('deleting a workspace or an org cascades its mappings', async () => {
  const ws = crypto.randomUUID();
  await app.db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run(ws, owner.orgId, `ref7map-gone-${TAG}`);
  const m = await j('POST', path(owner.orgId), { token: owner.token, body: { claim_value: claim('WsCascade'), role: 'workspace_admin', workspace_id: ws } });
  assert.equal(m.status, 201);
  await app.db.prepare('DELETE FROM workspaces WHERE id = ?').run(ws);
  assert.equal(await app.db.prepare('SELECT 1 FROM entra_role_mappings WHERE id = ?').get(m.body.id), undefined);

  const doomed = await registerUser('ref7mapdoomed');
  const om = await j('POST', path(doomed.orgId), { token: doomed.token, body: { claim_value: claim('OrgCascade'), role: 'org_admin' } });
  const wm = await j('POST', path(doomed.orgId), { token: doomed.token, body: { claim_value: claim('OrgCascade'), role: 'workspace_viewer', workspace_id: doomed.workspaceId } });
  assert.equal(om.status, 201);
  assert.equal(wm.status, 201);
  await cleanupUser(app.db, doomed.id); // deleteUserCascade: deletes the org they solely own
  cleanup.splice(cleanup.indexOf(doomed.id), 1);
  assert.equal(await app.db.prepare('SELECT 1 FROM organizations WHERE id = ?').get(doomed.orgId), undefined, 'org deleted');
  const left = await app.db.prepare('SELECT COUNT(*) AS n FROM entra_role_mappings WHERE id IN (?, ?)').get(om.body.id, wm.body.id);
  assert.equal(left.n, 0);
});

test("deleting the mapping's creator succeeds; created_by becomes NULL and the mapping stays", async () => {
  const creator = await registerUser('ref7mapcreator', false);
  await app.db.prepare('INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, ?)').run(owner.orgId, creator.id, 'org_admin');
  const m = await j('POST', path(owner.orgId), { token: creator.token, body: { claim_value: claim('Creator'), role: 'org_admin' } });
  assert.equal(m.status, 201);
  const { deleteUserCascade } = require('../lib/user-deletion');
  await deleteUserCascade(app.db, { targetId: creator.id, actingAdminId: owner.id });
  cleanup.splice(cleanup.indexOf(creator.id), 1);
  assert.equal(await app.db.prepare('SELECT 1 FROM users WHERE id = ?').get(creator.id), undefined, 'user deleted');
  const row = await app.db.prepare('SELECT created_by FROM entra_role_mappings WHERE id = ?').get(m.body.id);
  assert.ok(row, 'mapping kept');
  assert.equal(row.created_by, null);
  await j('DELETE', path(owner.orgId, m.body.id), { token: owner.token });
});
