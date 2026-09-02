'use strict';

// Phase 4 Stage A — ticketing data model + manual management endpoints.
//
// In-memory sqlite + the real workspaces router, mounted exactly as server.js
// mounts it (requireAuth only — the router gates per-handler via
// canWriteWorkspace / canAccessWorkspace, no resolveTenancy). Covers:
//   - full RBAC matrix (editor+ can manage, viewer read-only, cross-workspace
//     and non-member denied, org/platform paths)
//   - create/update validation (title, enum fields, device cross-workspace guard)
//   - status transitions stamping / clearing resolved_at
//   - list filtering + newest-first ordering
//   - every mutation writes an activity_log row

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

process.env.JWT_SECRET = 'test-secret-tickets';

const db = new Database(':memory:');
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
    slug TEXT, region_id TEXT, updated_at INTEGER DEFAULT 0
  );
  CREATE TABLE workspace_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL
  );
  CREATE TABLE devices (
    id TEXT PRIMARY KEY, workspace_id TEXT, name TEXT
  );
  CREATE TABLE tickets (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    device_id TEXT,
    title TEXT NOT NULL,
    description TEXT,
    owner_category TEXT NOT NULL DEFAULT 'unassigned',
    status TEXT NOT NULL DEFAULT 'open',
    priority TEXT NOT NULL DEFAULT 'medium',
    created_by TEXT,
    created_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0,
    resolved_at INTEGER
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
const { activityLogger } = require('../services/activity');

// --- fixtures --------------------------------------------------------
db.prepare("INSERT INTO users (id,email,role) VALUES ('u-plat','plat@t.test','platform_admin')").run();
db.prepare("INSERT INTO users (id,email,role) VALUES ('u-orgowner','orgowner@t.test','user')").run();
db.prepare("INSERT INTO users (id,email,role) VALUES ('u-wsadmin','wsadmin@t.test','user')").run();
db.prepare("INSERT INTO users (id,email,role) VALUES ('u-editor','editor@t.test','user')").run();
db.prepare("INSERT INTO users (id,email,role) VALUES ('u-viewer','viewer@t.test','user')").run();
db.prepare("INSERT INTO users (id,email,role) VALUES ('u-other','other@t.test','user')").run();
db.prepare("INSERT INTO users (id,email,role) VALUES ('u-nobody','nobody@t.test','user')").run();

db.prepare("INSERT INTO organizations (id,name,owner_user_id) VALUES ('org-a','Org A','u-orgowner')").run();
db.prepare("INSERT INTO organizations (id,name,owner_user_id) VALUES ('org-b','Org B','u-other')").run();
db.prepare("INSERT INTO organization_members (organization_id,user_id,role) VALUES ('org-a','u-orgowner','org_owner')").run();
db.prepare("INSERT INTO organization_members (organization_id,user_id,role) VALUES ('org-b','u-other','org_owner')").run();

db.prepare("INSERT INTO workspaces (id,organization_id,name) VALUES ('ws-a','org-a','WS A')").run();
db.prepare("INSERT INTO workspaces (id,organization_id,name) VALUES ('ws-b','org-b','WS B')").run();
db.prepare("INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ('ws-a','u-wsadmin','workspace_admin')").run();
db.prepare("INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ('ws-a','u-editor','workspace_editor')").run();
db.prepare("INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ('ws-a','u-viewer','workspace_viewer')").run();
db.prepare("INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ('ws-b','u-other','workspace_admin')").run();

db.prepare("INSERT INTO devices (id,workspace_id,name) VALUES ('dev-a1','ws-a','Lobby A')").run();
db.prepare("INSERT INTO devices (id,workspace_id,name) VALUES ('dev-b1','ws-b','Lobby B')").run();

const tok = (id) => generateToken(db.prepare('SELECT id,email,role FROM users WHERE id = ?').get(id), null);
const T = {
  plat: tok('u-plat'), orgOwner: tok('u-orgowner'), wsAdmin: tok('u-wsadmin'),
  editor: tok('u-editor'), viewer: tok('u-viewer'), other: tok('u-other'), nobody: tok('u-nobody'),
};

const app = express();
app.use(express.json());
app.use(activityLogger);
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
const tix = (ws) => `/api/workspaces/${ws}/tickets`;
const auditCount = (action) =>
  db.prepare('SELECT COUNT(*) c FROM activity_log WHERE action = ?').get(action).c;

// -------------------------------------------------------------------

test('workspace_editor can create a ticket; defaults + activity_log row', async () => {
  const before = auditCount('ticket_created');
  const r = await call('POST', tix('ws-a'), T.editor, { title: 'Screen is black' });
  assert.equal(r.status, 201);
  const t = await r.json();
  assert.equal(t.title, 'Screen is black');
  assert.equal(t.workspace_id, 'ws-a');
  assert.equal(t.status, 'open');
  assert.equal(t.priority, 'medium');
  assert.equal(t.owner_category, 'unassigned');
  assert.equal(t.device_id, null);
  assert.equal(t.created_by, 'u-editor');
  assert.equal(t.created_by_email, 'editor@t.test');
  assert.equal(t.resolved_at, null);
  assert.equal(auditCount('ticket_created'), before + 1);
});

test('create with all fields + device in the same workspace', async () => {
  const r = await call('POST', tix('ws-a'), T.wsAdmin, {
    title: 'Player crash loop', description: 'Restarts every 5 min', device_id: 'dev-a1',
    owner_category: 'hardware', priority: 'high',
  });
  assert.equal(r.status, 201);
  const t = await r.json();
  assert.equal(t.device_id, 'dev-a1');
  assert.equal(t.device_name, 'Lobby A');
  assert.equal(t.owner_category, 'hardware');
  assert.equal(t.priority, 'high');
  assert.equal(t.description, 'Restarts every 5 min');
});

test('create validation: missing title, bad enum values, unknown + cross-workspace device', async () => {
  assert.equal((await call('POST', tix('ws-a'), T.editor, {})).status, 400);
  assert.equal((await call('POST', tix('ws-a'), T.editor, { title: '   ' })).status, 400);
  assert.equal((await call('POST', tix('ws-a'), T.editor, { title: 'x', priority: 'urgent' })).status, 400);
  assert.equal((await call('POST', tix('ws-a'), T.editor, { title: 'x', owner_category: 'nobody' })).status, 400);
  assert.equal((await call('POST', tix('ws-a'), T.editor, { title: 'x', device_id: 'dev-missing' })).status, 404);
  // device belongs to ws-b, not ws-a
  assert.equal((await call('POST', tix('ws-a'), T.editor, { title: 'x', device_id: 'dev-b1' })).status, 400);
});

test('RBAC: viewer can read but not create or update', async () => {
  const list = await call('GET', tix('ws-a'), T.viewer);
  assert.equal(list.status, 200);
  assert.ok((await list.json()).length >= 1);

  assert.equal((await call('POST', tix('ws-a'), T.viewer, { title: 'nope' })).status, 403);

  const anyTicket = (await (await call('GET', tix('ws-a'), T.viewer)).json())[0];
  assert.equal((await call('PATCH', `${tix('ws-a')}/${anyTicket.id}`, T.viewer, { status: 'closed' })).status, 403);
});

test('RBAC: non-member and other-org user get 403 on everything; cross-workspace denied', async () => {
  for (const who of [T.nobody, T.other]) {
    assert.equal((await call('GET', tix('ws-a'), who)).status, 403);
    assert.equal((await call('POST', tix('ws-a'), who, { title: 'x' })).status, 403);
  }
  // ws-b admin cannot reach into ws-a
  assert.equal((await call('GET', tix('ws-a'), T.other)).status, 403);
  // unknown workspace
  assert.equal((await call('GET', '/api/workspaces/ws-zzz/tickets', T.plat)).status, 404);
  assert.equal((await call('POST', '/api/workspaces/ws-zzz/tickets', T.plat, { title: 'x' })).status, 404);
});

test('RBAC: org_owner and platform_admin can manage without a workspace_members row', async () => {
  assert.equal((await call('POST', tix('ws-a'), T.orgOwner, { title: 'from org owner' })).status, 201);
  assert.equal((await call('POST', tix('ws-a'), T.plat, { title: 'from platform' })).status, 201);
});

test('PATCH: status/priority/owner transitions + resolved_at lifecycle + audit', async () => {
  const t = await (await call('POST', tix('ws-a'), T.editor, { title: 'lifecycle', priority: 'low' })).json();
  const url = `${tix('ws-a')}/${t.id}`;
  const before = auditCount('ticket_updated');

  let u = await (await call('PATCH', url, T.editor, { status: 'in_progress', priority: 'high' })).json();
  assert.equal(u.status, 'in_progress');
  assert.equal(u.priority, 'high');
  assert.equal(u.resolved_at, null);

  u = await (await call('PATCH', url, T.editor, { status: 'resolved' })).json();
  assert.equal(u.status, 'resolved');
  assert.ok(u.resolved_at > 0, 'resolved_at stamped on entering resolved');

  const firstResolvedAt = u.resolved_at;
  u = await (await call('PATCH', url, T.editor, { status: 'closed' })).json();
  assert.equal(u.status, 'closed');
  assert.equal(u.resolved_at, firstResolvedAt, 'resolved_at unchanged moving resolved -> closed');

  u = await (await call('PATCH', url, T.editor, { status: 'open' })).json();
  assert.equal(u.status, 'open');
  assert.equal(u.resolved_at, null, 'resolved_at cleared moving back to open');

  u = await (await call('PATCH', url, T.editor, { owner_category: 'customer_it' })).json();
  assert.equal(u.owner_category, 'customer_it');

  assert.equal(auditCount('ticket_updated'), before + 5);
});

test('PATCH validation: bad values 400, no keys 400, unknown ticket 404, wrong-workspace ticket 404', async () => {
  const t = await (await call('POST', tix('ws-a'), T.editor, { title: 'v' })).json();
  const url = `${tix('ws-a')}/${t.id}`;
  assert.equal((await call('PATCH', url, T.editor, {})).status, 400);
  assert.equal((await call('PATCH', url, T.editor, { status: 'done' })).status, 400);
  assert.equal((await call('PATCH', url, T.editor, { priority: 'p1' })).status, 400);
  assert.equal((await call('PATCH', url, T.editor, { owner_category: 'space_force' })).status, 400);
  assert.equal((await call('PATCH', `${tix('ws-a')}/nope`, T.editor, { status: 'closed' })).status, 404);
  // ticket exists but in ws-b -> not found under ws-a
  const tb = db.prepare("INSERT INTO tickets (id,workspace_id,title) VALUES ('tk-b','ws-b','B ticket')").run();
  assert.equal(tb.changes, 1);
  assert.equal((await call('PATCH', `${tix('ws-a')}/tk-b`, T.editor, { status: 'closed' })).status, 404);
});

test('PATCH with only no-op values returns the row unchanged, 200', async () => {
  const t = await (await call('POST', tix('ws-a'), T.editor, { title: 'noop', priority: 'medium' })).json();
  const r = await call('PATCH', `${tix('ws-a')}/${t.id}`, T.editor, { priority: 'medium', status: 'open' });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).priority, 'medium');
});

test('GET single ticket + 404 for other workspace', async () => {
  const t = await (await call('POST', tix('ws-a'), T.editor, { title: 'detail me' })).json();
  const got = await call('GET', `${tix('ws-a')}/${t.id}`, T.viewer);
  assert.equal(got.status, 200);
  assert.equal((await got.json()).title, 'detail me');
  assert.equal((await call('GET', `${tix('ws-b')}/${t.id}`, T.other)).status, 404);
});

test('GET list: filters by status / priority / owner_category, newest first', async () => {
  // dedicated workspace so counts are deterministic
  db.prepare("INSERT INTO workspaces (id,organization_id,name) VALUES ('ws-f','org-a','WS F')").run();
  const mk = (body) => call('POST', tix('ws-f'), T.orgOwner, body);
  const t1 = await (await mk({ title: 'one', priority: 'low', owner_category: 'platform' })).json();
  const t2 = await (await mk({ title: 'two', priority: 'high', owner_category: 'store_staff' })).json();
  const t3 = await (await mk({ title: 'three', priority: 'high', owner_category: 'platform' })).json();
  await call('PATCH', `${tix('ws-f')}/${t2.id}`, T.orgOwner, { status: 'closed' });
  // space out created_at so ordering is unambiguous
  db.prepare("UPDATE tickets SET created_at = ? WHERE id = ?").run(100, t1.id);
  db.prepare("UPDATE tickets SET created_at = ? WHERE id = ?").run(200, t2.id);
  db.prepare("UPDATE tickets SET created_at = ? WHERE id = ?").run(300, t3.id);

  const all = await (await call('GET', tix('ws-f'), T.viewer ? T.orgOwner : T.orgOwner)).json();
  assert.deepEqual(all.map((t) => t.title), ['three', 'two', 'one']);

  const high = await (await call('GET', `${tix('ws-f')}?priority=high`, T.orgOwner)).json();
  assert.deepEqual(high.map((t) => t.title).sort(), ['three', 'two']);

  const open = await (await call('GET', `${tix('ws-f')}?status=open`, T.orgOwner)).json();
  assert.deepEqual(open.map((t) => t.title).sort(), ['one', 'three']);

  const platform = await (await call('GET', `${tix('ws-f')}?owner_category=platform`, T.orgOwner)).json();
  assert.deepEqual(platform.map((t) => t.title).sort(), ['one', 'three']);

  assert.equal((await call('GET', `${tix('ws-f')}?status=bogus`, T.orgOwner)).status, 400);
});
