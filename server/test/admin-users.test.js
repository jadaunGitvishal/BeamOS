'use strict';

// Tests for #10 (admin-provisioned user creation) and the must_change_password
// lifecycle, plus the #13 operator denial on this endpoint.
//
// In-process against the real MySQL test database (beamos_test via npm test): the
// real /api/admin and /api/auth routers, real auth (requireAuth reads the users row)
// and real FKs. Every row is test-owned under a per-run prefix and removed in
// test.after(); roles (platform_admin, platform_operator, org_admin) are seeded
// explicitly - nothing relies on being the first registered user.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');

const { db, initDb } = require('../db/database');
const { generateToken } = require('../middleware/auth');
const { startInProcessApp } = require('./helpers/inprocess-app');

const P = 'AU-' + crypto.randomBytes(4).toString('hex');
const E = P.toLowerCase();                  // the route lower-cases emails
const id = (s) => `${P}-${s}`;
const email = (s) => `${E}-${s}@test.local`;
const ORG_A = id('org-a'), ORG_B = id('org-b'), WS_A = id('ws-a'), WS_B = id('ws-b');

let app, base, adminUser;
const tokens = {};

async function seedUser(key, role = 'user') {
  const u = { id: id(`u-${key}`), email: email(key), role };
  await db.prepare("INSERT INTO users (id, email, name, password_hash, auth_provider, role) VALUES (?, ?, ?, 'x', 'local', ?)")
    .run(u.id, u.email, key, role);
  return u;
}
const addWsMember = (wsId, userId, role) =>
  db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)').run(wsId, userId, role);
const count = async (sql, ...params) => Number((await db.prepare(sql).get(...params)).c);

// logActivity is fire-and-forget from the routes - poll briefly for the audit row.
async function waitForRow(sql, ...params) {
  for (let i = 0; i < 40; i++) {
    const row = await db.prepare(sql).get(...params);
    if (row) return row;
    await new Promise((r) => setTimeout(r, 50));
  }
  return undefined;
}

// This file's rows: prefixed ids / emails / org names, and everything inside its orgs.
const OWN_ORGS = `SELECT id FROM organizations WHERE id LIKE '${P}-%' OR name LIKE '${P} %'`;
const OWN_WS = `SELECT id FROM workspaces WHERE id LIKE '${P}-%' OR organization_id IN (${OWN_ORGS})`;
const OWN_USERS = `SELECT id FROM users WHERE id LIKE '${P}-%' OR email LIKE '${E}-%'`;
// Row counts OUTSIDE this file's data, in every table these tests write or delete in.
const OUTSIDE = {
  users: `SELECT COUNT(*) AS c FROM users WHERE id NOT IN (${OWN_USERS})`,
  organizations: `SELECT COUNT(*) AS c FROM organizations WHERE id NOT IN (${OWN_ORGS})`,
  workspaces: `SELECT COUNT(*) AS c FROM workspaces WHERE id NOT IN (${OWN_WS})`,
  organization_members: `SELECT COUNT(*) AS c FROM organization_members WHERE organization_id NOT IN (${OWN_ORGS}) AND user_id NOT IN (${OWN_USERS})`,
  workspace_members: `SELECT COUNT(*) AS c FROM workspace_members WHERE workspace_id NOT IN (${OWN_WS}) AND user_id NOT IN (${OWN_USERS})`,
  devices: `SELECT COUNT(*) AS c FROM devices WHERE workspace_id IS NULL OR workspace_id NOT IN (${OWN_WS})`,
};
async function outsideCounts() {
  const o = {};
  for (const [t, sql] of Object.entries(OUTSIDE)) o[t] = await count(sql);
  return o;
}
let outsideBefore;

test.before(async () => {
  await initDb();
  app = await startInProcessApp({ only: ['/api/admin'] });
  base = app.base;
  outsideBefore = await outsideCounts();

  // --- seed orgs/workspaces/users ---
  adminUser = await seedUser('admin', 'platform_admin');
  await db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?), (?, ?, ?)')
    .run(ORG_A, `${P} Org A`, adminUser.id, ORG_B, `${P} Org B`, adminUser.id);
  await db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?), (?, ?, ?)')
    .run(WS_A, ORG_A, 'Workspace A', WS_B, ORG_B, 'Workspace B');

  const orgAdminA = await seedUser('orgadmin-a');
  await db.prepare("INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'org_admin')").run(ORG_A, orgAdminA.id);
  const operator = await seedUser('operator', 'platform_operator');
  const regular = await seedUser('regular');
  // Dedicated target for the role-assignment regression test (kept separate so it
  // can't perturb the non-admin/operator tokens used by the deny tests above).
  await seedUser('role-target');

  // Workspace move/assign targets (PUT /api/admin/users/:id/workspace).
  await seedUser('ws-single');
  await addWsMember(WS_A, id('u-ws-single'), 'workspace_editor');
  await seedUser('ws-zero');
  await seedUser('ws-multi');
  await addWsMember(WS_A, id('u-ws-multi'), 'workspace_viewer');
  await addWsMember(WS_B, id('u-ws-multi'), 'workspace_viewer');
  await seedUser('mgmt');

  tokens.admin = generateToken(adminUser, null);
  tokens.orgAdminA = generateToken(orgAdminA, WS_A);
  tokens.operator = generateToken(operator, null);
  tokens.regular = generateToken(regular, null);
});

// Only this file's rows: its orgs (cascading their workspaces + memberships), any
// remaining memberships of its users, then its users. Audit rows are kept (the hash
// chain must stay verifiable).
test.after(async () => {
  try {
    if (app) {
      await db.prepare(`DELETE FROM organizations WHERE id IN (SELECT id FROM (${OWN_ORGS}) o)`).run();
      await db.prepare(`DELETE FROM workspace_members WHERE user_id IN (SELECT id FROM (${OWN_USERS}) u)`).run();
      await db.prepare(`DELETE FROM organization_members WHERE user_id IN (SELECT id FROM (${OWN_USERS}) u)`).run();
      await db.prepare('DELETE FROM users WHERE id LIKE ? OR email LIKE ?').run(`${P}-%`, `${E}-%`);
    }
  } finally {
    if (app) await app.stop(); else await db.close();
  }
});

function post(pathname, token, body) {
  return fetch(base + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}
const newUserBody = (over = {}) => ({
  email: email('created'), name: 'Created User', password: 'TempPass123',
  workspaceId: WS_A, role: 'workspace_editor', mustChangePassword: true, ...over,
});

test('platform_admin can create a user (201); response omits password/hash; membership written', async () => {
  const res = await post('/api/admin/users', tokens.admin, newUserBody());
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.email, email('created'));
  assert.equal(body.workspace_role, 'workspace_editor');
  assert.equal(body.must_change_password, 1);
  assert.ok(!('password' in body), 'response must not include password');
  assert.ok(!('password_hash' in body), 'response must not include hash');

  const row = await db.prepare('SELECT * FROM users WHERE email = ?').get(email('created'));
  assert.ok(row && row.password_hash && row.password_hash !== 'TempPass123', 'password is hashed, not plaintext');
  const mem = await db.prepare('SELECT * FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(WS_A, row.id);
  assert.equal(mem.role, 'workspace_editor');
  assert.equal(mem.invited_by, adminUser.id);
  // HOSTED: excluded from welcome + activation-nudge lifecycle.
  assert.ok(row.welcome_email_sent_at && row.activation_nudge_sent_at, 'lifecycle sentinels stamped');
  // Audit row written, never the password.
  const audit = await waitForRow("SELECT * FROM activity_log WHERE action = 'admin_create_user' AND details LIKE ?", `%${email('created')}%`);
  assert.ok(audit && audit.details.includes(email('created')));
  assert.ok(!/TempPass123/.test(audit.details), 'audit must not contain the password');
});

test('duplicate email returns 409 and does not overwrite', async () => {
  const res = await post('/api/admin/users', tokens.admin, newUserBody({ password: 'Different999' }));
  assert.equal(res.status, 409);
  // original hash unchanged
  const row = await db.prepare('SELECT password_hash FROM users WHERE email = ?').get(email('created'));
  assert.ok(bcrypt.compareSync('TempPass123', row.password_hash), 'existing password untouched');
});

test('non-admin user is denied (403)', async () => {
  const res = await post('/api/admin/users', tokens.regular, newUserBody({ email: email('x1') }));
  assert.equal(res.status, 403);
  assert.equal(await count('SELECT COUNT(*) AS c FROM users WHERE email = ?', email('x1')), 0);
});

test('platform_operator is denied from Add User (403) - user mgmt is owner-only', async () => {
  const res = await post('/api/admin/users', tokens.operator, newUserBody({ email: email('x2') }));
  assert.equal(res.status, 403);
  assert.equal(await count('SELECT COUNT(*) AS c FROM users WHERE email = ?', email('x2')), 0);
});

test('org_admin can create in their own org but NOT another org', async () => {
  const ok = await post('/api/admin/users', tokens.orgAdminA, newUserBody({ email: email('in-a'), workspaceId: WS_A }));
  assert.equal(ok.status, 201);

  const denied = await post('/api/admin/users', tokens.orgAdminA, newUserBody({ email: email('in-b'), workspaceId: WS_B }));
  assert.equal(denied.status, 403);
  assert.equal(await count('SELECT COUNT(*) AS c FROM users WHERE email = ?', email('in-b')), 0);
});

test('validation: bad email 400, bad role 400, short password 400, missing workspace 404', async () => {
  assert.equal((await post('/api/admin/users', tokens.admin, newUserBody({ email: 'nope' }))).status, 400);
  assert.equal((await post('/api/admin/users', tokens.admin, newUserBody({ email: email('r'), role: 'org_admin' }))).status, 400);
  assert.equal((await post('/api/admin/users', tokens.admin, newUserBody({ email: email('p'), password: 'short' }))).status, 400);
  assert.equal((await post('/api/admin/users', tokens.admin, newUserBody({ email: email('w'), workspaceId: id('ws-missing') }))).status, 404);
});

test('must_change_password lifecycle: set on create, surfaced on login, cleared on /me password change', async () => {
  // the "created" user was created with mustChangePassword:true in the first test.
  const login = await post('/api/auth/login', null, { email: email('created'), password: 'TempPass123' });
  assert.equal(login.status, 200);
  const loginBody = await login.json();
  assert.equal(loginBody.user.must_change_password, 1, 'login response carries the flag (drives the redirect)');

  // Change password via PUT /api/auth/me -> clears the flag.
  const meRes = await fetch(base + '/api/auth/me', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${loginBody.token}` },
    body: JSON.stringify({ password: 'BrandNewPass1', current_password: 'TempPass123' }),
  });
  assert.equal(meRes.status, 200);
  const meBody = await meRes.json();
  assert.equal(meBody.must_change_password, 0, '/me response shows the flag cleared');
  const row = await db.prepare('SELECT must_change_password FROM users WHERE email = ?').get(email('created'));
  assert.equal(row.must_change_password, 0, 'flag cleared in the DB');
});

test('platform_operator is assignable via PUT /users/:id/role (regression for #13/#14 whitelist gap)', async () => {
  const res = await fetch(base + `/api/auth/users/${id('u-role-target')}/role`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens.admin}` },
    body: JSON.stringify({ role: 'platform_operator' }),
  });
  assert.equal(res.status, 200);
  const dbRole = (await db.prepare('SELECT role FROM users WHERE id = ?').get(id('u-role-target'))).role;
  assert.equal(dbRole, 'platform_operator', 'role actually persisted as platform_operator');
});

// ---- PUT /api/admin/users/:id/workspace (move / assign single workspace) ----
function setWorkspace(userId, workspaceId, token) {
  return fetch(base + `/api/admin/users/${userId}/workspace`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ workspaceId }),
  });
}
const wsRows = (userId) => db.prepare('SELECT workspace_id, role FROM workspace_members WHERE user_id = ?').all(userId);

test('workspace move: single-membership user moved to another workspace (200, membership changed)', async () => {
  const res = await setWorkspace(id('u-ws-single'), WS_B, tokens.admin);
  assert.equal(res.status, 200);
  const rows = await wsRows(id('u-ws-single'));
  assert.equal(rows.length, 1, 'still exactly one membership');
  assert.equal(rows[0].workspace_id, WS_B, 'moved to ws-b');
  assert.equal(rows[0].role, 'workspace_viewer', 'default role on move');
});

test('workspace assign: zero-membership user assigned a workspace (200)', async () => {
  const res = await setWorkspace(id('u-ws-zero'), WS_A, tokens.admin);
  assert.equal(res.status, 200);
  const rows = await wsRows(id('u-ws-zero'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].workspace_id, WS_A);
  assert.equal(rows[0].role, 'workspace_viewer');
});

test('workspace move REFUSED for a multi-membership user (400, untouched)', async () => {
  const res = await setWorkspace(id('u-ws-multi'), WS_A, tokens.admin);
  assert.equal(res.status, 400);
  assert.equal((await wsRows(id('u-ws-multi'))).length, 2, 'both memberships preserved');
});

test('workspace move denied for a non-platform-admin (403)', async () => {
  const reg = await setWorkspace(id('u-ws-zero'), WS_B, tokens.regular);
  assert.equal(reg.status, 403);
  // platform_operator is also denied (platform user-mgmt is owner-only)
  const op = await setWorkspace(id('u-ws-zero'), WS_B, tokens.operator);
  assert.equal(op.status, 403);
  assert.equal((await wsRows(id('u-ws-zero')))[0].workspace_id, WS_A, 'unchanged by denied calls');
});

// ---- Per-user multi-workspace membership management (Manage workspaces modal) ----
function ws(method, userId, token, { workspaceId, role, suffix = '' } = {}) {
  return fetch(base + `/api/admin/users/${userId}/workspaces${suffix}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(workspaceId || role ? { body: JSON.stringify({ workspaceId, role }) } : {}),
  });
}
const MGMT = id('u-mgmt');
const mgmtRole = async (wsId) => (await db.prepare('SELECT role FROM workspace_members WHERE user_id = ? AND workspace_id = ?').get(MGMT, wsId)).role;

test('membership mgmt: add a user to multiple workspaces with per-workspace roles', async () => {
  const a = await ws('POST', MGMT, tokens.admin, { workspaceId: WS_A, role: 'workspace_editor' });
  assert.equal(a.status, 201);
  const b = await ws('POST', MGMT, tokens.admin, { workspaceId: WS_B, role: 'workspace_viewer' });
  assert.equal(b.status, 201);
  const list = await (await ws('GET', MGMT, tokens.admin)).json();
  assert.equal(list.length, 2, 'user is now in two workspaces');
  assert.deepEqual(
    list.map(m => [m.workspace_id, m.role]).sort(),
    [[WS_A, 'workspace_editor'], [WS_B, 'workspace_viewer']].sort()
  );
  assert.ok(list[0].workspace_name && list[0].organization_name, 'list carries names for the picker/summary');
});

test('membership mgmt: change role in one workspace', async () => {
  const r = await ws('PUT', MGMT, tokens.admin, { role: 'workspace_admin', suffix: `/${WS_A}` });
  assert.equal(r.status, 200);
  assert.equal(await mgmtRole(WS_A), 'workspace_admin');
});

test('membership mgmt: re-adding an existing workspace updates the role (upsert, 200)', async () => {
  const r = await ws('POST', MGMT, tokens.admin, { workspaceId: WS_A, role: 'workspace_viewer' });
  assert.equal(r.status, 200);
  assert.equal(await mgmtRole(WS_A), 'workspace_viewer');
});

test('membership mgmt: remove memberships, including the last one (-> unassigned)', async () => {
  assert.equal((await ws('DELETE', MGMT, tokens.admin, { suffix: `/${WS_A}` })).status, 200);
  assert.equal((await ws('DELETE', MGMT, tokens.admin, { suffix: `/${WS_B}` })).status, 200); // last one allowed
  assert.equal((await (await ws('GET', MGMT, tokens.admin)).json()).length, 0, 'user now unassigned');
});

test('membership mgmt: bad role 400, missing workspace 404, unknown user 404', async () => {
  assert.equal((await ws('POST', MGMT, tokens.admin, { workspaceId: WS_A, role: 'org_admin' })).status, 400);
  assert.equal((await ws('POST', MGMT, tokens.admin, { workspaceId: id('ws-missing'), role: 'workspace_viewer' })).status, 404);
  assert.equal((await ws('GET', id('nobody'), tokens.admin)).status, 404);
});

test('membership mgmt: non-platform-admin denied (403)', async () => {
  assert.equal((await ws('GET', MGMT, tokens.regular)).status, 403);
  assert.equal((await ws('POST', MGMT, tokens.operator, { workspaceId: WS_A, role: 'workspace_viewer' })).status, 403);
});

// --- #35: POST /api/admin/orgs (create org + first workspace, owned by admin) ---
test('platform_admin creates an org + Default workspace, owned by them (201)', async () => {
  const name = `${P} Bold Media Group`;
  const res = await post('/api/admin/orgs', tokens.admin, { name });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.name, name);
  assert.ok(body.id && body.workspace_id, 'returns org id + workspace id');
  assert.equal(body.owner_user_id, adminUser.id);

  const org = await db.prepare('SELECT * FROM organizations WHERE id = ?').get(body.id);
  assert.equal(org.owner_user_id, adminUser.id);
  const wsRow = await db.prepare('SELECT * FROM workspaces WHERE id = ?').get(body.workspace_id);
  assert.equal(wsRow.organization_id, body.id);
  assert.equal(wsRow.name, 'Default');
  assert.equal((await db.prepare('SELECT role FROM organization_members WHERE organization_id = ? AND user_id = ?').get(body.id, adminUser.id)).role, 'org_owner');
  assert.equal((await db.prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(body.workspace_id, adminUser.id)).role, 'workspace_admin');
  // audited
  assert.ok(await waitForRow("SELECT 1 FROM activity_log WHERE action = 'admin_create_org' AND details = ?", `org: ${name}`), 'org creation audited');
});

test('create org: empty name is rejected (400), nothing created', async () => {
  const before = await count('SELECT COUNT(*) AS c FROM organizations');
  const res = await post('/api/admin/orgs', tokens.admin, { name: '   ' });
  assert.equal(res.status, 400);
  assert.equal(await count('SELECT COUNT(*) AS c FROM organizations'), before);
});

test('create org: non-admin and operator denied (403)', async () => {
  const before = await count('SELECT COUNT(*) AS c FROM organizations');
  assert.equal((await post('/api/admin/orgs', tokens.regular, { name: `${P} X` })).status, 403);
  assert.equal((await post('/api/admin/orgs', tokens.operator, { name: `${P} Y` })).status, 403);
  assert.equal(await count('SELECT COUNT(*) AS c FROM organizations'), before, 'no org created by denied callers');
});

// --- #36: DELETE /api/admin/orgs/:id and /workspaces/:id ---
const delReq = (pathname, token) => fetch(base + pathname, {
  method: 'DELETE', headers: token ? { Authorization: `Bearer ${token}` } : {},
});

test('platform_admin deletes an org (200): org + workspace + members removed', async () => {
  const ORG_DEL = id('org-del'), WS_DEL = id('ws-del');
  await db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run(ORG_DEL, `${P} Del Org`, adminUser.id);
  await db.prepare("INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'org_owner')").run(ORG_DEL, adminUser.id);
  await db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run(WS_DEL, ORG_DEL, 'Del WS');
  await addWsMember(WS_DEL, adminUser.id, 'workspace_admin');

  const res = await delReq(`/api/admin/orgs/${ORG_DEL}`, tokens.admin);
  assert.equal(res.status, 200);
  assert.equal(await count('SELECT COUNT(*) AS c FROM organizations WHERE id = ?', ORG_DEL), 0);
  assert.equal(await count('SELECT COUNT(*) AS c FROM workspaces WHERE id = ?', WS_DEL), 0);
  // the real FKs cascade the member tables too
  assert.equal(await count('SELECT COUNT(*) AS c FROM organization_members WHERE organization_id = ?', ORG_DEL), 0);
  assert.equal(await count('SELECT COUNT(*) AS c FROM workspace_members WHERE workspace_id = ?', WS_DEL), 0);
  assert.ok(await waitForRow("SELECT 1 FROM activity_log WHERE action = 'admin_delete_org' AND details LIKE ?", `%(${ORG_DEL})`), 'audited');
});

test('delete org: 404 unknown; 403 for non-admin + operator (no delete)', async () => {
  assert.equal((await delReq(`/api/admin/orgs/${id('nope')}`, tokens.admin)).status, 404);
  const ORG_KEEP = id('org-keep');
  await db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run(ORG_KEEP, `${P} Keep`, adminUser.id);
  assert.equal((await delReq(`/api/admin/orgs/${ORG_KEEP}`, tokens.regular)).status, 403);
  assert.equal((await delReq(`/api/admin/orgs/${ORG_KEEP}`, tokens.operator)).status, 403);
  assert.equal(await count('SELECT COUNT(*) AS c FROM organizations WHERE id = ?', ORG_KEEP), 1, 'denied callers did not delete');
});

test('platform_admin deletes a workspace (200): ws gone, parent org intact', async () => {
  const ORG_WD = id('org-wd'), WS_WD = id('ws-wd');
  await db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run(ORG_WD, `${P} WD`, adminUser.id);
  await db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run(WS_WD, ORG_WD, 'WD WS');
  const res = await delReq(`/api/admin/workspaces/${WS_WD}`, tokens.admin);
  assert.equal(res.status, 200);
  assert.equal(await count('SELECT COUNT(*) AS c FROM workspaces WHERE id = ?', WS_WD), 0);
  assert.equal(await count('SELECT COUNT(*) AS c FROM organizations WHERE id = ?', ORG_WD), 1, 'org intact');
});

test('isolation: rows outside this file\'s prefix are unchanged in every touched table', async () => {
  assert.deepEqual(await outsideCounts(), outsideBefore);
});
