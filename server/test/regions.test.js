'use strict';

// Phase 3 Stage A — regions data model + admin endpoints.
//
// The REAL organizations/workspaces routers in-process (helpers/inprocess-app.js,
// mounted as server.js mounts them: requireAuth only — these routers gate per-handler
// via canManageOrgRegions, no resolveTenancy) against the REAL MySQL test DB
// (beamos_test via npm test). Covers the RBAC matrix, the dup-name / cross-org
// guards, and that deleting a region UNASSIGNS its workspaces (region_id -> NULL)
// rather than deleting them. Fixtures are test-owned (rg- prefix) and removed
// afterwards (newest user first, so each org owner goes last).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { db } = require('../db/database');
const { generateToken } = require('../middleware/auth');
const { startInProcessApp } = require('./helpers/inprocess-app');
const { randTag, cleanupUsers } = require('./helpers/disposable');

const P = `rg-${randTag()}`;
let app;
const userIds = [];
const U = {};   // users by role in this file
const T = {};   // their session tokens
const ORG = {}; // org ids: a, b
const WS = {};  // workspace ids: a1, a2, b1

async function mkUser(key, role = 'user') {
  const id = `${P}-${key}`;
  const email = `${id}@t.test`;
  await app.db.prepare("INSERT INTO users (id, email, name, password_hash, auth_provider, role) VALUES (?, ?, ?, NULL, 'local', ?)")
    .run(id, email, id, role);
  userIds.push(id);
  U[key] = id;
  T[key] = generateToken({ id, email, role }, null);
}
async function mkOrg(key, name, ownerKey) {
  ORG[key] = crypto.randomUUID();
  await app.db.prepare("INSERT INTO organizations (id, name, owner_user_id, plan_id, subscription_status) VALUES (?, ?, ?, 'enterprise', 'active')")
    .run(ORG[key], `${P} ${name}`, U[ownerKey]);
}
const orgMember = (orgKey, userKey, role) =>
  app.db.prepare('INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, ?)').run(ORG[orgKey], U[userKey], role);
async function mkWorkspace(key, orgKey, name) {
  WS[key] = crypto.randomUUID();
  await app.db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run(WS[key], ORG[orgKey], `${P} ${name}`);
}

test.before(async () => {
  app = await startInProcessApp({ only: ['/api/organizations', '/api/workspaces'] });
  await mkUser('ownerA');
  await mkUser('adminA');
  await mkUser('ownerB');
  await mkUser('wsAdmin');
  await mkUser('plat', 'platform_admin');
  await mkUser('nobody');

  await mkOrg('a', 'Org A', 'ownerA');
  await mkOrg('b', 'Org B', 'ownerB');
  await orgMember('a', 'ownerA', 'org_owner');
  await orgMember('a', 'adminA', 'org_admin');
  await orgMember('b', 'ownerB', 'org_owner');

  await mkWorkspace('a1', 'a', 'A One');
  await mkWorkspace('a2', 'a', 'A Two');
  await mkWorkspace('b1', 'b', 'B One');
  await app.db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin')").run(WS.a1, U.wsAdmin);
});

test.after(async () => {
  try {
    if (app) await cleanupUsers(app.db, [...userIds].reverse());
  } finally {
    if (app) await app.stop(); else await db.close();
  }
});

const call = (method, path, token, body) =>
  fetch(app.base + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const regs = (orgId) => `/api/organizations/${orgId}/regions`;
const regionOf = async (wsId) => (await app.db.prepare('SELECT region_id FROM workspaces WHERE id = ?').get(wsId)).region_id;

test('org_admin can create / list / rename their own org\'s regions', async () => {
  const c = await call('POST', regs(ORG.a), T.adminA, { name: 'North' });
  assert.equal(c.status, 201);
  const created = await c.json();
  assert.equal(created.name, 'North');
  assert.equal(created.organization_id, ORG.a);
  assert.equal(created.workspace_count, 0);

  const list = await (await call('GET', regs(ORG.a), T.adminA)).json();
  assert.deepEqual(list.map((r) => r.name), ['North']);

  const ren = await call('PATCH', `${regs(ORG.a)}/${created.id}`, T.adminA, { name: 'Northern' });
  assert.equal(ren.status, 200);
  assert.equal((await ren.json()).name, 'Northern');
});

test('org_owner and platform_admin can also manage regions', async () => {
  assert.equal((await call('POST', regs(ORG.a), T.ownerA, { name: 'South' })).status, 201);
  assert.equal((await call('POST', regs(ORG.b), T.plat, { name: 'West' })).status, 201);
});

test('RBAC: org_admin of org-a CANNOT touch org-b regions', async () => {
  assert.equal((await call('GET', regs(ORG.b), T.adminA)).status, 403);
  assert.equal((await call('POST', regs(ORG.b), T.adminA, { name: 'Sneaky' })).status, 403);
  const orgBRegions = await (await call('GET', regs(ORG.b), T.ownerB)).json();
  const west = orgBRegions.find((r) => r.name === 'West');
  assert.equal((await call('PATCH', `${regs(ORG.b)}/${west.id}`, T.adminA, { name: 'x' })).status, 403);
  assert.equal((await call('DELETE', `${regs(ORG.b)}/${west.id}`, T.adminA)).status, 403);
});

test('RBAC: a workspace_admin (not an org member) cannot create a region', async () => {
  assert.equal((await call('POST', regs(ORG.a), T.wsAdmin, { name: 'Nope' })).status, 403);
  assert.equal((await call('GET', regs(ORG.a), T.wsAdmin)).status, 403);
  assert.equal((await call('POST', regs(ORG.a), T.nobody, { name: 'Nope' })).status, 403);
});

test('validation: blank name 400, too long 400, duplicate name 409, unknown org 404', async () => {
  assert.equal((await call('POST', regs(ORG.a), T.adminA, { name: '   ' })).status, 400);
  assert.equal((await call('POST', regs(ORG.a), T.adminA, { name: 'x'.repeat(200) })).status, 400);
  assert.equal((await call('POST', regs(ORG.a), T.adminA, { name: 'Northern' })).status, 409); // exists
  assert.equal((await call('POST', regs(crypto.randomUUID()), T.plat, { name: 'y' })).status, 404);
});

test('deleting a region UNASSIGNS its workspaces (region_id -> NULL), never deletes them', async () => {
  const r = await (await call('POST', regs(ORG.a), T.adminA, { name: 'Doomed' })).json();
  // assign both org-a workspaces to it via the workspace route
  assert.equal((await call('PATCH', `/api/workspaces/${WS.a1}/region`, T.adminA, { region_id: r.id })).status, 200);
  assert.equal((await call('PATCH', `/api/workspaces/${WS.a2}/region`, T.ownerA, { region_id: r.id })).status, 200);

  const listBefore = await (await call('GET', regs(ORG.a), T.adminA)).json();
  assert.equal(listBefore.find((x) => x.id === r.id).workspace_count, 2);

  const del = await call('DELETE', `${regs(ORG.a)}/${r.id}`, T.adminA);
  assert.equal(del.status, 200);
  assert.deepEqual(await del.json(), { success: true, workspaces_unassigned: 2 });

  // region gone, workspaces still there but unassigned
  assert.equal(Number((await app.db.prepare('SELECT COUNT(*) AS n FROM regions WHERE id = ?').get(r.id)).n), 0);
  const ws = await app.db.prepare('SELECT id, region_id FROM workspaces WHERE organization_id = ? ORDER BY id').all(ORG.a);
  assert.deepEqual(ws, [WS.a1, WS.a2].sort().map((id) => ({ id, region_id: null })));
});

test('PATCH /workspaces/:id/region — RBAC + cross-org guard + unassign', async () => {
  const r = await (await call('POST', regs(ORG.a), T.adminA, { name: 'Central' })).json();
  const rB = await (await call('POST', regs(ORG.b), T.ownerB, { name: 'Central-B' })).json();

  // workspace_admin of ws-a1 cannot set its region (org-level action)
  assert.equal((await call('PATCH', `/api/workspaces/${WS.a1}/region`, T.wsAdmin, { region_id: r.id })).status, 403);
  // a region from another org is rejected
  assert.equal((await call('PATCH', `/api/workspaces/${WS.a1}/region`, T.adminA, { region_id: rB.id })).status, 400);
  // missing body key
  assert.equal((await call('PATCH', `/api/workspaces/${WS.a1}/region`, T.adminA, {})).status, 400);
  // valid assign, then unassign with null
  assert.equal((await call('PATCH', `/api/workspaces/${WS.a1}/region`, T.adminA, { region_id: r.id })).status, 200);
  assert.equal(await regionOf(WS.a1), r.id);
  const un = await call('PATCH', `/api/workspaces/${WS.a1}/region`, T.adminA, { region_id: null });
  assert.equal(un.status, 200);
  assert.equal(await regionOf(WS.a1), null);
  // unknown workspace
  assert.equal((await call('PATCH', `/api/workspaces/${crypto.randomUUID()}/region`, T.plat, { region_id: null })).status, 404);
});
