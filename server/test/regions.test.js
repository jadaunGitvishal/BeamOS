'use strict';

// Phase 3 Stage A — regions data model + admin endpoints.
//
// In-memory sqlite + the real organizations/workspaces routers, mounted exactly
// as server.js mounts them (requireAuth only — these routers gate per-handler
// via canManageOrgRegions, no resolveTenancy). Covers the RBAC matrix, the
// dup-name / cross-org guards, and that deleting a region UNASSIGNS its
// workspaces (region_id -> NULL) rather than deleting them.

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

process.env.JWT_SECRET = 'test-secret-regions';

const db = new Database(':memory:');
// the routes use MySQL's UNIX_TIMESTAMP() for updated_at; shim it for sqlite.
db.function('UNIX_TIMESTAMP', () => Math.floor(Date.now() / 1000));
db.exec(`
  CREATE TABLE users (
    id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT DEFAULT '',
    password_hash TEXT, auth_provider TEXT NOT NULL DEFAULT 'local', avatar_url TEXT,
    role TEXT NOT NULL DEFAULT 'user', plan_id TEXT DEFAULT 'free', email_alerts INTEGER DEFAULT 1,
    must_change_password INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_user_id TEXT NOT NULL);
  CREATE TABLE organization_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT, organization_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL
  );
  CREATE TABLE workspaces (
    id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, name TEXT NOT NULL,
    region_id TEXT, updated_at INTEGER DEFAULT 0
  );
  CREATE TABLE workspace_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL
  );
  CREATE TABLE regions (
    id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, name TEXT NOT NULL,
    created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0, UNIQUE (organization_id, name)
  );
  CREATE TABLE activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, device_id TEXT, action TEXT,
    details TEXT, ip_address TEXT, workspace_id TEXT, created_at INTEGER DEFAULT 0
  );
`);

const dbModulePath = require.resolve('../db/database');
require.cache[dbModulePath] = { id: dbModulePath, filename: dbModulePath, loaded: true, exports: { db } };

const express = require('express');
const { generateToken, requireAuth } = require('../middleware/auth');

// --- fixtures --------------------------------------------------------
db.prepare("INSERT INTO users (id,email,role) VALUES ('u-owner-a','ownera@t.test','user')").run();
db.prepare("INSERT INTO users (id,email,role) VALUES ('u-admin-a','admina@t.test','user')").run();
db.prepare("INSERT INTO users (id,email,role) VALUES ('u-owner-b','ownerb@t.test','user')").run();
db.prepare("INSERT INTO users (id,email,role) VALUES ('u-wsadmin','wsadmin@t.test','user')").run();
db.prepare("INSERT INTO users (id,email,role) VALUES ('u-plat','plat@t.test','platform_admin')").run();
db.prepare("INSERT INTO users (id,email,role) VALUES ('u-nobody','nobody@t.test','user')").run();

db.prepare("INSERT INTO organizations (id,name,owner_user_id) VALUES ('org-a','Org A','u-owner-a')").run();
db.prepare("INSERT INTO organizations (id,name,owner_user_id) VALUES ('org-b','Org B','u-owner-b')").run();
db.prepare("INSERT INTO organization_members (organization_id,user_id,role) VALUES ('org-a','u-owner-a','org_owner')").run();
db.prepare("INSERT INTO organization_members (organization_id,user_id,role) VALUES ('org-a','u-admin-a','org_admin')").run();
db.prepare("INSERT INTO organization_members (organization_id,user_id,role) VALUES ('org-b','u-owner-b','org_owner')").run();

db.prepare("INSERT INTO workspaces (id,organization_id,name) VALUES ('ws-a1','org-a','A One')").run();
db.prepare("INSERT INTO workspaces (id,organization_id,name) VALUES ('ws-a2','org-a','A Two')").run();
db.prepare("INSERT INTO workspaces (id,organization_id,name) VALUES ('ws-b1','org-b','B One')").run();
db.prepare("INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ('ws-a1','u-wsadmin','workspace_admin')").run();

const tok = (id) => {
  const u = db.prepare('SELECT id,email,role FROM users WHERE id = ?').get(id);
  return generateToken(u, null);
};
const T = {
  ownerA: tok('u-owner-a'), adminA: tok('u-admin-a'), ownerB: tok('u-owner-b'),
  wsAdmin: tok('u-wsadmin'), plat: tok('u-plat'), nobody: tok('u-nobody'),
};

const app = express();
app.use(express.json());
app.use('/api/organizations', requireAuth, require('../routes/organizations'));
app.use('/api/workspaces', requireAuth, require('../routes/workspaces'));
app.use((err, req, res, _next) => { res.status(500).json({ error: err.message, stack: err.stack }); });
const server = app.listen(0);
let base;
test.before(async () => {
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); db.close(); });

const call = (method, path, token, body) =>
  fetch(base + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const regs = (orgId) => `/api/organizations/${orgId}/regions`;

test('org_admin can create / list / rename their own org\'s regions', async () => {
  const c = await call('POST', regs('org-a'), T.adminA, { name: 'North' });
  assert.equal(c.status, 201);
  const created = await c.json();
  assert.equal(created.name, 'North');
  assert.equal(created.organization_id, 'org-a');
  assert.equal(created.workspace_count, 0);

  const list = await (await call('GET', regs('org-a'), T.adminA)).json();
  assert.deepEqual(list.map((r) => r.name), ['North']);

  const ren = await call('PATCH', `${regs('org-a')}/${created.id}`, T.adminA, { name: 'Northern' });
  assert.equal(ren.status, 200);
  assert.equal((await ren.json()).name, 'Northern');
});

test('org_owner and platform_admin can also manage regions', async () => {
  assert.equal((await call('POST', regs('org-a'), T.ownerA, { name: 'South' })).status, 201);
  assert.equal((await call('POST', regs('org-b'), T.plat, { name: 'West' })).status, 201);
});

test('RBAC: org_admin of org-a CANNOT touch org-b regions', async () => {
  assert.equal((await call('GET', regs('org-b'), T.adminA)).status, 403);
  assert.equal((await call('POST', regs('org-b'), T.adminA, { name: 'Sneaky' })).status, 403);
  const orgBRegions = await (await call('GET', regs('org-b'), T.ownerB)).json();
  const west = orgBRegions.find((r) => r.name === 'West');
  assert.equal((await call('PATCH', `${regs('org-b')}/${west.id}`, T.adminA, { name: 'x' })).status, 403);
  assert.equal((await call('DELETE', `${regs('org-b')}/${west.id}`, T.adminA)).status, 403);
});

test('RBAC: a workspace_admin (not an org member) cannot create a region', async () => {
  assert.equal((await call('POST', regs('org-a'), T.wsAdmin, { name: 'Nope' })).status, 403);
  assert.equal((await call('GET', regs('org-a'), T.wsAdmin)).status, 403);
  assert.equal((await call('POST', regs('org-a'), T.nobody, { name: 'Nope' })).status, 403);
});

test('validation: blank name 400, too long 400, duplicate name 409, unknown org 404', async () => {
  assert.equal((await call('POST', regs('org-a'), T.adminA, { name: '   ' })).status, 400);
  assert.equal((await call('POST', regs('org-a'), T.adminA, { name: 'x'.repeat(200) })).status, 400);
  assert.equal((await call('POST', regs('org-a'), T.adminA, { name: 'Northern' })).status, 409); // exists
  assert.equal((await call('POST', regs('org-missing'), T.plat, { name: 'y' })).status, 404);
});

test('deleting a region UNASSIGNS its workspaces (region_id -> NULL), never deletes them', async () => {
  const r = await (await call('POST', regs('org-a'), T.adminA, { name: 'Doomed' })).json();
  // assign both org-a workspaces to it via the workspace route
  assert.equal((await call('PATCH', '/api/workspaces/ws-a1/region', T.adminA, { region_id: r.id })).status, 200);
  assert.equal((await call('PATCH', '/api/workspaces/ws-a2/region', T.ownerA, { region_id: r.id })).status, 200);

  const listBefore = await (await call('GET', regs('org-a'), T.adminA)).json();
  assert.equal(listBefore.find((x) => x.id === r.id).workspace_count, 2);

  const del = await call('DELETE', `${regs('org-a')}/${r.id}`, T.adminA);
  assert.equal(del.status, 200);
  assert.deepEqual(await del.json(), { success: true, workspaces_unassigned: 2 });

  // region gone, workspaces still there but unassigned
  assert.equal(db.prepare("SELECT COUNT(*) n FROM regions WHERE id = ?").get(r.id).n, 0);
  const ws = db.prepare("SELECT id, region_id FROM workspaces WHERE organization_id = 'org-a' ORDER BY id").all();
  assert.deepEqual(ws, [
    { id: 'ws-a1', region_id: null },
    { id: 'ws-a2', region_id: null },
  ]);
});

test('PATCH /workspaces/:id/region — RBAC + cross-org guard + unassign', async () => {
  const r = await (await call('POST', regs('org-a'), T.adminA, { name: 'Central' })).json();
  const rB = await (await call('POST', regs('org-b'), T.ownerB, { name: 'Central-B' })).json();

  // workspace_admin of ws-a1 cannot set its region (org-level action)
  assert.equal((await call('PATCH', '/api/workspaces/ws-a1/region', T.wsAdmin, { region_id: r.id })).status, 403);
  // a region from another org is rejected
  assert.equal((await call('PATCH', '/api/workspaces/ws-a1/region', T.adminA, { region_id: rB.id })).status, 400);
  // missing body key
  assert.equal((await call('PATCH', '/api/workspaces/ws-a1/region', T.adminA, {})).status, 400);
  // valid assign, then unassign with null
  assert.equal((await call('PATCH', '/api/workspaces/ws-a1/region', T.adminA, { region_id: r.id })).status, 200);
  assert.equal(db.prepare("SELECT region_id FROM workspaces WHERE id='ws-a1'").get().region_id, r.id);
  const un = await call('PATCH', '/api/workspaces/ws-a1/region', T.adminA, { region_id: null });
  assert.equal(un.status, 200);
  assert.equal(db.prepare("SELECT region_id FROM workspaces WHERE id='ws-a1'").get().region_id, null);
  // unknown workspace
  assert.equal((await call('PATCH', '/api/workspaces/ws-nope/region', T.plat, { region_id: null })).status, 404);
});