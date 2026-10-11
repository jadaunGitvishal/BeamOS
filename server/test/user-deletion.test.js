'use strict';

// Issue #18: DELETE /api/auth/users/:id failed with "FOREIGN KEY constraint
// failed". This suite reproduces the failure faithfully and verifies the
// cascade/unlink/refuse behaviour.
//
// In-process against the real MySQL test database (beamos_test via npm test): the
// real /api/auth router, real auth and the real schema's FKs (playlists.user_id etc.
// reference users without a cascade - the #18 cause). Every row is test-owned under
// a per-run prefix and removed in test.after(); a final test proves no row outside
// that prefix was touched.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { db, initDb } = require('../db/database');
const { generateToken } = require('../middleware/auth');
const { startInProcessApp } = require('./helpers/inprocess-app');
const { appendEntry, verifyChain } = require('../lib/activity-chain');
const { deleteOrgCascade, deleteWorkspaceCascade } = require('../lib/user-deletion');

const P = 'UD-' + crypto.randomBytes(4).toString('hex');
const id = (s) => `${P}-${s}`;

let app, base;
const tokens = {};

async function user(key, role = 'user') {
  const u = { id: id(key), email: `${id(key).toLowerCase()}@test.local`, role };
  await db.prepare("INSERT INTO users (id, email, role, password_hash) VALUES (?, ?, ?, 'x')").run(u.id, u.email, role);
  return u;
}
const run = (sql, ...params) => db.prepare(sql).run(...params);
const exists = async (table, rowId) => !!(await db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(rowId));
const count = async (sql, ...params) => Number((await db.prepare(sql).get(...params)).c);

// Row counts OUTSIDE this file's data in every table the deletions touch.
const OWN_ORGS = `SELECT id FROM organizations WHERE id LIKE '${P}-%'`;
const OWN_WS = `SELECT id FROM workspaces WHERE id LIKE '${P}-%' OR organization_id IN (${OWN_ORGS})`;
const OUTSIDE = {
  users: `SELECT COUNT(*) AS c FROM users WHERE id NOT LIKE '${P}-%'`,
  organizations: `SELECT COUNT(*) AS c FROM organizations WHERE id NOT IN (${OWN_ORGS})`,
  workspaces: `SELECT COUNT(*) AS c FROM workspaces WHERE id NOT IN (${OWN_WS})`,
  organization_members: `SELECT COUNT(*) AS c FROM organization_members WHERE organization_id NOT IN (${OWN_ORGS}) AND user_id NOT LIKE '${P}-%'`,
  workspace_members: `SELECT COUNT(*) AS c FROM workspace_members WHERE workspace_id NOT IN (${OWN_WS}) AND user_id NOT LIKE '${P}-%'`,
  devices: `SELECT COUNT(*) AS c FROM devices WHERE id NOT LIKE '${P}-%'`,
};
async function outsideCounts() {
  const o = {};
  for (const [t, sql] of Object.entries(OUTSIDE)) o[t] = await count(sql);
  return o;
}
let outsideBefore;

// ---- seed: an admin caller + a separate org owner ----
test.before(async () => {
  await initDb();
  app = await startInProcessApp({ only: [] });
  base = app.base;
  outsideBefore = await outsideCounts();

  const admin = await user('u-admin', 'platform_admin');
  const regular = await user('u-regular', 'user');        // non-superadmin caller
  await user('u-owner', 'user');                          // owns org X (the "other" tenant)
  await run('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)', id('orgX'), `${P} Org X`, id('u-owner'));
  await run("INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'org_owner')", id('orgX'), id('u-owner'));
  await run('INSERT INTO workspaces (id, organization_id, name, created_by) VALUES (?, ?, ?, ?)', id('wsX'), id('orgX'), 'WS X', id('u-owner'));
  await run("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin')", id('wsX'), id('u-owner'));

  tokens.admin = generateToken(admin, null);
  tokens.regular = generateToken(regular, null);
});

// Only this file's rows: its orgs via the real cascade (workspaces, devices, content,
// playlists, memberships), leftover prefixed resources, then its users. Audit rows are
// kept (they keep user_id by design and the hash chain must stay verifiable).
test.after(async () => {
  try {
    if (app) {
      for (const o of await db.prepare(OWN_ORGS).all()) await deleteOrgCascade(db, { orgId: o.id });
      for (const t of ['playlists', 'content', 'devices']) await run(`DELETE FROM ${t} WHERE id LIKE ?`, `${P}-%`);
      await run('DELETE FROM users WHERE id LIKE ?', `${P}-%`);
    }
  } finally {
    if (app) await app.stop(); else await db.close();
  }
});

const del = (userId, token) => fetch(`${base}/api/auth/users/${userId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });

test('reproduces #18: a bare DELETE FROM users fails the FK constraint', async () => {
  await user('u-fkprobe');
  await run('INSERT INTO playlists (id, name, user_id) VALUES (?, ?, ?)', id('p-fkprobe'), 'FK probe', id('u-fkprobe'));
  await assert.rejects(run('DELETE FROM users WHERE id = ?', id('u-fkprobe')), /foreign key constraint fails/i);
  await run('DELETE FROM playlists WHERE id = ?', id('p-fkprobe'));
  await run('DELETE FROM users WHERE id = ?', id('u-fkprobe'));
});

test('provisioned member (owns no org): deleted; resources preserved + unlinked', async () => {
  await user('u-member');
  await run("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_editor')", id('wsX'), id('u-member'));
  await run('INSERT INTO playlists (id, name, user_id, workspace_id) VALUES (?, ?, ?, ?)', id('p1'), 'P1', id('u-member'), id('wsX'));
  await run('INSERT INTO devices (id, name, user_id, workspace_id) VALUES (?, ?, ?, ?)', id('d1'), 'D1', id('u-member'), id('wsX'));
  // A real, chained audit row for the member (appendEntry = the logActivity path).
  const audit = await appendEntry(db, { user_id: id('u-member'), action: 'login', details: `${P} member login` });
  const auditId = Number(audit.id);

  const res = await del(id('u-member'), tokens.admin);
  assert.equal(res.status, 200);
  assert.equal(await exists('users', id('u-member')), false, 'user deleted');
  assert.equal(await count('SELECT COUNT(*) AS c FROM workspace_members WHERE user_id = ?', id('u-member')), 0, 'membership cascaded');
  // org X untouched (not owned by the deleted user)
  assert.equal(await exists('organizations', id('orgX')), true);
  assert.equal(await exists('workspaces', id('wsX')), true);
  // playlist preserved, NOT NULL user_id reassigned to the workspace's org owner
  assert.equal((await db.prepare('SELECT user_id FROM playlists WHERE id = ?').get(id('p1'))).user_id, id('u-owner'), 'playlist reassigned to org owner');
  // device preserved, nullable user_id set null
  assert.equal((await db.prepare('SELECT user_id FROM devices WHERE id = ?').get(id('d1'))).user_id, null, 'device unlinked');
  // activity preserved and KEEPS user_id (61d179c: user_id is part of each row's hash,
  // so nulling it would break the audit chain); the chain over this row still verifies.
  assert.equal((await db.prepare('SELECT user_id FROM activity_log WHERE id = ?').get(auditId)).user_id, id('u-member'), 'activity preserved, user_id retained');
  const report = await verifyChain(db, { startId: auditId, endId: auditId });
  assert.equal(report.ok, true, JSON.stringify(report.failures));
});

test('solo-org owner: org + workspace + contents hard-deleted with the user', async () => {
  await user('u-solo');
  await run('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)', id('orgS'), `${P} Solo Org`, id('u-solo'));
  await run("INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'org_owner')", id('orgS'), id('u-solo'));
  await run('INSERT INTO workspaces (id, organization_id, name, created_by) VALUES (?, ?, ?, ?)', id('wsS'), id('orgS'), 'WS S', id('u-solo'));
  await run("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin')", id('wsS'), id('u-solo'));
  await run('INSERT INTO playlists (id, name, user_id, workspace_id) VALUES (?, ?, ?, ?)', id('pS'), 'PS', id('u-solo'), id('wsS'));
  await run('INSERT INTO devices (id, user_id, workspace_id) VALUES (?, ?, ?)', id('dS'), id('u-solo'), id('wsS'));
  await run("INSERT INTO content (id, filename, mime_type, user_id, workspace_id) VALUES (?, 'cs.png', 'image/png', ?, ?)", id('cS'), id('u-solo'), id('wsS'));

  const res = await del(id('u-solo'), tokens.admin);
  assert.equal(res.status, 200);
  assert.equal(await exists('users', id('u-solo')), false);
  assert.equal(await exists('organizations', id('orgS')), false, 'owned org deleted');
  assert.equal(await exists('workspaces', id('wsS')), false, 'workspace deleted');
  assert.equal(await exists('playlists', id('pS')), false);
  assert.equal(await exists('devices', id('dS')), false);
  assert.equal(await exists('content', id('cS')), false);
});

test('shared-org owner: refused (409), nothing deleted', async () => {
  await user('u-shared');
  await run('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)', id('orgH'), `${P} Shared Org`, id('u-shared'));
  await run("INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'org_owner')", id('orgH'), id('u-shared'));
  await run('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)', id('wsH'), id('orgH'), 'WS H');
  await run("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin')", id('wsH'), id('u-shared'));
  await run("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_editor')", id('wsH'), id('u-owner')); // OTHER member

  const res = await del(id('u-shared'), tokens.admin);
  assert.equal(res.status, 409);
  assert.equal(await exists('users', id('u-shared')), true, 'not deleted');
  assert.equal(await exists('organizations', id('orgH')), true, 'org intact');
});

test('cannot delete yourself (400) and non-superadmin denied (403)', async () => {
  const self = await del(id('u-admin'), tokens.admin);
  assert.equal(self.status, 400);
  const denied = await del(id('u-owner'), tokens.regular);
  assert.equal(denied.status, 403);
  assert.equal(await exists('users', id('u-owner')), true);
});

test('missing user -> 404', async () => {
  const res = await del(id('does-not-exist'), tokens.admin);
  assert.equal(res.status, 404);
});

// --- #36: deleteOrgCascade / deleteWorkspaceCascade (shared cascade helpers) ---
test('deleteOrgCascade: org + all workspaces/resources/members gone; member users kept', async () => {
  await user('u-cust');
  await run('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)', id('orgD'), `${P} Cust`, id('u-cust'));
  await run("INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'org_owner')", id('orgD'), id('u-cust'));
  await run('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?), (?, ?, ?)', id('wsD1'), id('orgD'), 'D1', id('wsD2'), id('orgD'), 'D2');
  await run("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin')", id('wsD1'), id('u-cust'));
  await run('INSERT INTO devices (id, workspace_id) VALUES (?, ?)', id('dvD'), id('wsD1'));
  await run("INSERT INTO content (id, filename, mime_type, workspace_id) VALUES (?, 'ct.png', 'image/png', ?)", id('ctD'), id('wsD2'));
  await run('INSERT INTO playlists (id, name, user_id, workspace_id) VALUES (?, ?, ?, ?)', id('plD'), 'PD', id('u-cust'), id('wsD1'));

  await deleteOrgCascade(db, { orgId: id('orgD') });

  assert.equal(await exists('organizations', id('orgD')), false, 'org gone');
  assert.equal((await exists('workspaces', id('wsD1'))) || (await exists('workspaces', id('wsD2'))), false, 'workspaces gone');
  assert.equal(await exists('devices', id('dvD')), false, 'device gone');
  assert.equal(await exists('content', id('ctD')), false, 'content gone');
  assert.equal(await exists('playlists', id('plD')), false, 'playlist gone');
  assert.equal(await count('SELECT COUNT(*) AS c FROM organization_members WHERE organization_id = ?', id('orgD')), 0, 'org members cascaded');
  assert.equal(await exists('users', id('u-cust')), true, 'member user is NOT deleted');
});

test('deleteWorkspaceCascade: one workspace + resources gone; org + sibling intact', async () => {
  await user('u-cust2');
  await run('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)', id('orgW'), `${P} W`, id('u-cust2'));
  await run('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?), (?, ?, ?)', id('wsW1'), id('orgW'), 'W1', id('wsW2'), id('orgW'), 'W2');
  await run("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin')", id('wsW1'), id('u-cust2'));
  await run('INSERT INTO devices (id, workspace_id) VALUES (?, ?), (?, ?)', id('dvW'), id('wsW1'), id('dvW2'), id('wsW2'));

  await deleteWorkspaceCascade(db, { workspaceId: id('wsW1') });

  assert.equal(await exists('workspaces', id('wsW1')), false, 'target ws gone');
  assert.equal(await exists('devices', id('dvW')), false, 'target ws device gone');
  assert.equal(await count('SELECT COUNT(*) AS c FROM workspace_members WHERE workspace_id = ?', id('wsW1')), 0, 'members cascaded');
  assert.equal(await exists('organizations', id('orgW')), true, 'org intact');
  assert.equal(await exists('workspaces', id('wsW2')), true, 'sibling ws intact');
  assert.equal(await exists('devices', id('dvW2')), true, 'sibling device intact');
});

test('isolation: the deletions touched no row outside this file\'s prefix', async () => {
  assert.deepEqual(await outsideCounts(), outsideBefore);
});
