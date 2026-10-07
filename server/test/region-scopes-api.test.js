'use strict';

// Refs 49/67: GET/PUT /api/organizations/:orgId/members/:userId/region-scopes and
// the regional_viewer org role on the member routes, over real HTTP against the
// REAL MySQL database (helpers/inprocess-app.js, which mounts the activityLogger).
// Disposable fixtures, deleted in after().

const test = require('node:test');
const assert = require('node:assert/strict');

const { initDb } = require('../db/database');
const { startInProcessApp } = require('./helpers/inprocess-app');
const { randTag, cleanupUsers } = require('./helpers/disposable');

const TAG = randTag();
let app;
const cleanup = [];
let owner, orgAdmin, other, rv, plainMember, wsViewer;
const R = {};

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
  const email = `${prefix}-${randTag()}@ref49scope.local`;
  const r = await j('POST', '/api/auth/register', { body: { email, password: 'ref49-scope-pass-1', name: prefix, createOrg } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  cleanup.push(r.body.user.id);
  const ws = r.body.current_workspace_id
    ? await app.db.prepare('SELECT organization_id FROM workspaces WHERE id = ?').get(r.body.current_workspace_id)
    : null;
  return { id: r.body.user.id, email, token: r.body.token, workspaceId: r.body.current_workspace_id, orgId: ws?.organization_id };
}

const scopesPath = (userId, orgId = owner.orgId) => `/api/organizations/${orgId}/members/${userId}/region-scopes`;
const scopeRows = (userId) =>
  app.db.prepare('SELECT region_id FROM region_viewer_scopes WHERE user_id = ? ORDER BY region_id').all(userId);

test.before(async () => {
  await initDb();
  app = await startInProcessApp({ only: ['/api/organizations', '/api/workspaces'] });
  owner = await registerUser('ref49sown');
  other = await registerUser('ref49sother');
  orgAdmin = await registerUser('ref49sadmin', false);
  rv = await registerUser('ref49srv', false);
  plainMember = await registerUser('ref49splain', false);
  wsViewer = await registerUser('ref49sviewer', false);
  for (const [u, role] of [[orgAdmin, 'org_admin'], [rv, 'regional_viewer'], [plainMember, 'org_admin']]) {
    const r = await j('POST', `/api/organizations/${owner.orgId}/members`, { token: owner.token, body: { email: u.email, role } });
    assert.equal(r.status, 201, `${role}: ${JSON.stringify(r.body)}`);
  }
  await app.db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)').run(owner.workspaceId, wsViewer.id, 'workspace_viewer');
  const mk = async (key, level, parent, who = owner) => {
    const r = await j('POST', `/api/organizations/${who.orgId}/regions`, { token: who.token, body: { name: `${key}-${TAG}`, level, parent_id: parent } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    R[key] = r.body.id;
  };
  await mk('r1', 'region', null);
  await mk('c1', 'cluster', R.r1);
  await mk('r2', 'region', null);
  await mk('theirs', 'region', null, other);
});

test.after(async () => {
  await cleanupUsers(app.db, cleanup.reverse());
  await app.stop();
});

test('regional_viewer is a valid org role on the member routes; other unknown roles still 400', async () => {
  const m = await app.db.prepare('SELECT role FROM organization_members WHERE organization_id = ? AND user_id = ?').get(owner.orgId, rv.id);
  assert.equal(m.role, 'regional_viewer');
  const bad = await j('POST', `/api/organizations/${owner.orgId}/members`, { token: owner.token, body: { email: wsViewer.email, role: 'regional_admin' } });
  assert.equal(bad.status, 400);
});

test('RBAC: only org_owner / org_admin of THIS org (or a platform admin) may read or set scopes', async () => {
  for (const u of [wsViewer, rv, other]) {
    assert.equal((await j('GET', scopesPath(rv.id), { token: u.token })).status, 403);
    assert.equal((await j('PUT', scopesPath(rv.id), { token: u.token, body: { region_ids: [R.r1] } })).status, 403);
  }
  assert.equal((await j('GET', scopesPath(rv.id))).status, 401);
  const byAdmin = await j('PUT', scopesPath(rv.id), { token: orgAdmin.token, body: { region_ids: [R.r1] } });
  assert.equal(byAdmin.status, 200, 'an org_admin may set scopes');
  assert.deepEqual(byAdmin.body.region_ids, [R.r1]);
});

test('validation: non-regional member 400, unknown member 404, other org\'s region 400, bad body 400', async () => {
  assert.equal((await j('PUT', scopesPath(plainMember.id), { token: owner.token, body: { region_ids: [R.r1] } })).status, 400);
  assert.equal((await j('PUT', scopesPath(wsViewer.id), { token: owner.token, body: { region_ids: [] } })).status, 404, 'not an org member');
  const foreign = await j('PUT', scopesPath(rv.id), { token: owner.token, body: { region_ids: [R.r2, R.theirs] } });
  assert.equal(foreign.status, 400);
  assert.match(foreign.body.error, new RegExp(R.theirs));
  for (const body of [{}, { region_ids: 'x' }, { region_ids: [1] }, { region_ids: [''] }, { region_ids: null }]) {
    assert.equal((await j('PUT', scopesPath(rv.id), { token: owner.token, body })).status, 400, JSON.stringify(body));
  }
  assert.deepEqual((await scopeRows(rv.id)).map((r) => r.region_id), [R.r1], 'rejected PUTs changed nothing');
});

test('PUT replaces the whole set (duplicates collapse); an empty list clears it; GET returns names and levels', async () => {
  const two = await j('PUT', scopesPath(rv.id), { token: owner.token, body: { region_ids: [R.c1, R.r2, R.c1] } });
  assert.equal(two.status, 200);
  assert.deepEqual([...two.body.region_ids].sort(), [R.c1, R.r2].sort());
  const got = await j('GET', scopesPath(rv.id), { token: owner.token });
  assert.equal(got.status, 200);
  assert.equal(got.body.role, 'regional_viewer');
  assert.deepEqual(got.body.regions.map((r) => r.level).sort(), ['cluster', 'region']);
  const one = await j('PUT', scopesPath(rv.id), { token: owner.token, body: { region_ids: [R.r1] } });
  assert.deepEqual(one.body.region_ids, [R.r1]);
  assert.deepEqual((await scopeRows(rv.id)).map((r) => r.region_id), [R.r1]);
  const none = await j('PUT', scopesPath(rv.id), { token: owner.token, body: { region_ids: [] } });
  assert.equal(none.status, 200);
  assert.deepEqual(none.body.region_ids, []);
  assert.deepEqual(await scopeRows(rv.id), []);
});

test('changing the role away from regional_viewer deletes the scopes; switching back does not resurrect them; both audited', async () => {
  const start = (await app.db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM activity_log').get()).id;
  assert.equal((await j('PUT', scopesPath(rv.id), { token: owner.token, body: { region_ids: [R.r1, R.c1] } })).status, 200);
  assert.equal((await scopeRows(rv.id)).length, 2);

  const away = await j('PUT', `/api/organizations/${owner.orgId}/members/${rv.id}`, { token: owner.token, body: { role: 'org_admin' } });
  assert.equal(away.status, 200, JSON.stringify(away.body));
  assert.deepEqual(await scopeRows(rv.id), [], 'scopes removed with the role change');
  const back = await j('PUT', `/api/organizations/${owner.orgId}/members/${rv.id}`, { token: owner.token, body: { role: 'regional_viewer' } });
  assert.equal(back.status, 200);
  assert.deepEqual(await scopeRows(rv.id), [], 'old scopes do not come back');
  assert.equal((await j('PUT', scopesPath(rv.id), { token: owner.token, body: { region_ids: [R.r2] } })).status, 200);

  await new Promise((r) => setTimeout(r, 250)); // activityLogger is fire-and-forget
  const rows = await app.db
    .prepare('SELECT action, details FROM activity_log WHERE id > ? AND user_id = ? ORDER BY id')
    .all(start, owner.id);
  const actions = rows.map((r) => r.action);
  assert.ok(actions.includes('PUT /api/organizations/:orgId/members/:userId/region-scopes'), actions.join(' | '));
  assert.ok(actions.includes('region_scopes_set'));
  assert.ok(actions.includes('PUT /api/organizations/:id/members/:userId'));
  assert.equal(rows.filter((r) => r.action === 'org_member_role_changed').length, 2);
});

test('removing the member drops their scopes (FK cascade)', async () => {
  assert.equal((await scopeRows(rv.id)).length, 1);
  const del = await j('DELETE', `/api/organizations/${owner.orgId}/members/${rv.id}`, { token: owner.token });
  assert.equal(del.status, 200);
  assert.deepEqual(await scopeRows(rv.id), []);
});
