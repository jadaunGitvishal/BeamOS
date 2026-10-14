'use strict';

// Last-active-platform-admin protection (lib/platform-admin-guard.js) + the last-
// workspace-admin check on routes/admin.js's membership routes.
//
// Every path that can remove an active platform admin - PUT /api/auth/users/:id/role,
// DELETE /api/auth/users/:id, and SCIM's POST (adopt) / PATCH / PUT / DELETE
// deactivations - decides under the app_locks 'platform_admins' row lock, so a change
// that would leave ZERO active platform admins is refused (409 on the auth routes,
// SCIM's 403) even when two of them race.
//
// Isolation: the whole process runs against a SCRATCH MySQL database (real schema via
// initDb, real routers) created here and dropped in after(), because "how many active
// platform admins are there" is a whole-table count - the shared test DB can hold
// other files' admins. Each test first demotes every platform admin left by earlier
// tests, so it controls the count exactly. Same technique as audit-prune.test.js.

const crypto = require('node:crypto');
const DB_NAME = `beamos_test_last_admin_${crypto.randomBytes(4).toString('hex')}`;
process.env.MYSQL_DATABASE = DB_NAME;

const test = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const config = require('../config');
const mysqlTls = require('../lib/mysql-tls');
const { assertSafeTestDb, isAllowedTestDbName } = require('../lib/test-db-guard');
const { initDb, db } = require('../db/database');
const { generateToken } = require('../middleware/auth');
const { hashToken } = require('../middleware/apiToken');
const { generateScimToken, displayPrefix } = require('../middleware/scimAuth');
const { deleteUserCascade } = require('../lib/user-deletion');
const { setUserDeactivated } = require('../lib/user-deactivation');
const { LastPlatformAdminError, lockPlatformAdmins, assertNotLastActivePlatformAdmin } = require('../lib/platform-admin-guard');

let app;
let n = 0;
let ORG;      // the SCIM token's organization
let SCIM;     // its plaintext token
const PLATFORM = "('platform_admin', 'superadmin')";

function baseOptions() {
  const o = { host: config.mysqlHost, port: config.mysqlPort, user: config.mysqlUser, password: config.mysqlPassword };
  if (config.mysqlSocketPath) o.socketPath = config.mysqlSocketPath;
  const ssl = mysqlTls.mysqlSslOptions(config);
  if (ssl) o.ssl = ssl;
  return o;
}

test.before(async () => {
  assertSafeTestDb({ database: DB_NAME, user: config.mysqlUser });
  const conn = await mysql.createConnection(baseOptions());
  await conn.query(`CREATE DATABASE \`${DB_NAME}\``);
  await conn.end();
  await initDb();
  const { startInProcessApp } = require('./helpers/inprocess-app');
  app = await startInProcessApp({ only: ['/api/admin'] }); // + /api/auth, always mounted
  app.app.use('/scim/v2', require('../routes/scim'));

  // The org SCIM provisions into, owned by a plain user, and a SCIM token bound to it.
  const owner = await mkUser('user');
  ORG = crypto.randomUUID();
  await db.prepare("INSERT INTO organizations (id, name, owner_user_id, plan_id, subscription_status) VALUES (?, 'SCIM org', ?, 'enterprise', 'active')").run(ORG, owner.id);
  SCIM = generateScimToken();
  await db.prepare('INSERT INTO scim_tokens (id, token_hash, prefix, name, organization_id, created_by) VALUES (?, ?, ?, ?, ?, ?)')
    .run(crypto.randomUUID(), hashToken(SCIM), displayPrefix(SCIM), 'last-admin test', ORG, owner.id);
});

test.after(async () => {
  try {
    if (app) await app.server.close();
  } finally {
    try {
      if (!(isAllowedTestDbName(DB_NAME) && DB_NAME.startsWith('beamos_test_'))) throw new Error(`refusing to drop non-scratch database ${DB_NAME}`);
      await db.exec(`DROP DATABASE \`${DB_NAME}\``);
    } finally {
      await db.close();
    }
  }
});

// ---- fixtures / helpers ----
async function mkUser(role, { deactivated = false, scimMember = false } = {}) {
  n += 1;
  const id = `u${n}-${crypto.randomBytes(3).toString('hex')}`;
  const email = `${id}@x.local`;
  await db.prepare("INSERT INTO users (id, email, name, password_hash, auth_provider, role, deactivated_at) VALUES (?, ?, ?, NULL, 'local', ?, ?)")
    .run(id, email, id, role, deactivated ? Math.floor(Date.now() / 1000) : null);
  if (scimMember) await db.prepare("INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'org_admin')").run(ORG, id);
  return { id, email, token: generateToken({ id, email, role }, null) };
}
// Start every test from zero active platform admins (earlier tests leave some).
const resetPlatformAdmins = () => db.prepare(`UPDATE users SET role = 'user' WHERE role IN ${PLATFORM}`).run();
const activeAdminIds = async () => (await db.prepare(`SELECT id FROM users WHERE role IN ${PLATFORM} AND deactivated_at IS NULL ORDER BY id`).all()).map((r) => r.id);
const userRow = (id) => db.prepare('SELECT id, role, deactivated_at FROM users WHERE id = ?').get(id);
const isMember = async (id) => !!(await db.prepare('SELECT 1 AS hit FROM organization_members WHERE organization_id = ? AND user_id = ?').get(ORG, id));

async function call(method, path, token, body, contentType = 'application/json') {
  const headers = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers['content-type'] = contentType;
  const r = await fetch(`${app.base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, json, text };
}
const demote = (actor, target, role = 'user') => call('PUT', `/api/auth/users/${target.id}/role`, actor.token, { role });
const del = (actor, target) => call('DELETE', `/api/auth/users/${target.id}`, actor.token);
const scim = (method, path, body) => call(method, `/scim/v2${path}`, SCIM, body, 'application/scim+json');
const PATCH_OP = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const scimPatchInactive = (u) => scim('PATCH', `/Users/${u.id}`, { schemas: [PATCH_OP], Operations: [{ op: 'replace', path: 'active', value: false }] });
const scimPutInactive = (u) => scim('PUT', `/Users/${u.id}`, { schemas: [USER_SCHEMA], userName: u.email, active: false });
const scimDelete = (u) => scim('DELETE', `/Users/${u.id}`);
const scimAdoptInactive = (u) => scim('POST', '/Users', { schemas: [USER_SCHEMA], userName: u.email, active: false });

// The guard, exactly as the auth role route uses it, for the cases HTTP can't reach.
const guardedDemoteInTx = (target) => db.transaction(async (tx) => {
  await lockPlatformAdmins(tx);
  const cur = await tx.prepare('SELECT role, deactivated_at FROM users WHERE id = ? FOR UPDATE').get(target.id);
  await assertNotLastActivePlatformAdmin(tx, cur);
  await tx.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(target.id);
})();

// ---- single active platform admin ----
test('single active platform admin: every SCIM deactivation path is refused (403) and nothing changes', async () => {
  await resetPlatformAdmins();
  const a = await mkUser('platform_admin');

  // POST adopt with active:false - refused before the membership is even created.
  const adopt = await scimAdoptInactive(a);
  assert.equal(adopt.status, 403, adopt.text);
  assert.equal(await isMember(a.id), false, 'not adopted');

  await db.prepare("INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'org_admin')").run(ORG, a.id);
  for (const [label, run] of [['PATCH', scimPatchInactive], ['PUT', scimPutInactive], ['DELETE', scimDelete]]) {
    const r = await run(a);
    assert.equal(r.status, 403, `${label}: ${r.text}`);
    assert.match(r.json.detail, /last active platform admin/, label);
  }
  const row = await userRow(a.id);
  assert.equal(row.deactivated_at, null, 'still active');
  assert.equal(row.role, 'platform_admin');
  assert.equal(await isMember(a.id), true, 'membership kept');
  assert.deepEqual(await activeAdminIds(), [a.id]);
});

test('single active platform admin: the locked guard refuses demotion, deletion and deactivation (409 cases HTTP cannot reach)', async () => {
  // Over HTTP the auth routes need ANOTHER active platform admin as the actor (and
  // refuse acting on yourself), so a lone admin can't be targeted there; the guard
  // underneath is exercised directly instead - with exactly the calls the routes make.
  await resetPlatformAdmins();
  const a = await mkUser('platform_admin');
  await assert.rejects(() => guardedDemoteInTx(a), LastPlatformAdminError);
  await assert.rejects(() => deleteUserCascade(db, { targetId: a.id, actingAdminId: a.id, protectLastPlatformAdmin: true }), LastPlatformAdminError);
  await assert.rejects(() => setUserDeactivated(db, a.id, true, { protectLastPlatformAdmin: true }), LastPlatformAdminError);
  const row = await userRow(a.id);
  assert.deepEqual([row.role, row.deactivated_at], ['platform_admin', null], 'unchanged');

  // A lone admin can't demote or delete themselves either (the existing guards, unchanged).
  assert.equal((await demote(a, a)).status, 400);
  assert.equal((await del(a, a)).status, 400);
});

// ---- two admins ----
test('two active platform admins: demoting or deleting one succeeds; the other is then protected', async () => {
  await resetPlatformAdmins();
  const a = await mkUser('platform_admin', { scimMember: true });
  const b = await mkUser('platform_admin');
  const r = await demote(a, b);
  assert.equal(r.status, 200, r.text);
  assert.equal((await userRow(b.id)).role, 'user');
  assert.deepEqual(await activeAdminIds(), [a.id]);
  // a is now the last one: SCIM and the guard refuse.
  assert.equal((await scimPatchInactive(a)).status, 403);
  await assert.rejects(() => guardedDemoteInTx(a), LastPlatformAdminError);

  await resetPlatformAdmins();
  const c = await mkUser('platform_admin', { scimMember: true });
  const d = await mkUser('platform_admin');
  const dr = await del(c, d);
  assert.equal(dr.status, 200, dr.text);
  assert.equal(await userRow(d.id), undefined, 'deleted');
  assert.equal((await scimDelete(c)).status, 403);
  assert.deepEqual(await activeAdminIds(), [c.id]);
});

test('a deactivated platform admin does not count as active', async () => {
  await resetPlatformAdmins();
  const a = await mkUser('platform_admin', { scimMember: true });
  const gone = await mkUser('platform_admin', { deactivated: true });
  assert.deepEqual(await activeAdminIds(), [a.id]);
  assert.equal((await scimPatchInactive(a)).status, 403, 'the deactivated admin is not "another"');
  await assert.rejects(() => setUserDeactivated(db, a.id, true, { protectLastPlatformAdmin: true }), LastPlatformAdminError);
  // ...and changing the deactivated one never needs protecting.
  const r = await demote(a, gone);
  assert.equal(r.status, 200, r.text);
});

// ---- races ----
// A gate makes each race deterministic: the test itself holds the lock both requests
// need (in its own transaction), fires them, waits until both are authenticated and
// queued behind it, then releases - so they genuinely contend for the lock, one after
// the other, instead of one finishing before the other has even started. (Remove the
// lock from the code and the requests no longer wait at the gate: both run at once.)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PLATFORM_GATE = ["SELECT name FROM app_locks WHERE name = 'platform_admins' FOR UPDATE", []];
async function throughGate([sql, params], fire) {
  const conn = await mysql.createConnection({ ...baseOptions(), database: DB_NAME });
  try {
    await conn.query('START TRANSACTION');
    await conn.query(sql, params);
    const pending = fire();
    await sleep(500);
    await conn.query('COMMIT');
    return await pending;
  } finally {
    await conn.end();
  }
}
const ROUNDS = 3;
async function raceRound(setup, run) {
  await resetPlatformAdmins();
  const { a, b } = await setup();
  const results = await throughGate(PLATFORM_GATE, () => run(a, b));
  const statuses = results.map((r) => r.status);
  return { statuses, active: await activeAdminIds(), a, b };
}
const okStatus = (s) => s === 200 || s === 204;
const refused = (s) => s === 409 || s === 403;

test('race: two platform admins demote each other at the same time - exactly one succeeds, one active admin remains', async () => {
  for (let i = 0; i < ROUNDS; i++) {
    const { statuses, active } = await raceRound(
      async () => ({ a: await mkUser('platform_admin'), b: await mkUser('platform_admin') }),
      (a, b) => Promise.all([demote(a, b), demote(b, a)]),
    );
    assert.deepEqual(statuses.slice().sort(), [200, 409], `round ${i}: ${statuses}`);
    assert.equal(active.length, 1, `round ${i}: one active platform admin remains`);
  }
});

test('race: two platform admins delete each other at the same time - exactly one succeeds, one active admin remains', async () => {
  for (let i = 0; i < ROUNDS; i++) {
    const { statuses, active } = await raceRound(
      async () => ({ a: await mkUser('platform_admin'), b: await mkUser('platform_admin') }),
      (a, b) => Promise.all([del(a, b), del(b, a)]),
    );
    assert.deepEqual(statuses.slice().sort(), [200, 409], `round ${i}: ${statuses}`);
    assert.equal(active.length, 1, `round ${i}: one active platform admin remains`);
  }
});

test('race (SCIM): both platform admins deactivated at the same time - exactly one succeeds (403 for the other)', async () => {
  for (let i = 0; i < ROUNDS; i++) {
    const { statuses, active } = await raceRound(
      async () => ({ a: await mkUser('platform_admin', { scimMember: true }), b: await mkUser('platform_admin', { scimMember: true }) }),
      (a, b) => Promise.all([scimDelete(a), scimPatchInactive(b)]),
    );
    assert.equal(statuses.filter(okStatus).length, 1, `round ${i}: ${statuses}`);
    assert.equal(statuses.filter((s) => s === 403).length, 1, `round ${i}: ${statuses}`);
    assert.equal(active.length, 1, `round ${i}: one active platform admin remains`);
  }
});

test('race (cross-path): an auth demotion and a SCIM deactivation at the same time - exactly one succeeds', async () => {
  for (let i = 0; i < ROUNDS; i++) {
    const { statuses, active } = await raceRound(
      async () => ({ a: await mkUser('platform_admin', { scimMember: true }), b: await mkUser('platform_admin') }),
      (a, b) => Promise.all([demote(a, b), scimPatchInactive(a)]),
    );
    assert.equal(statuses.filter(okStatus).length, 1, `round ${i}: ${statuses}`);
    assert.equal(statuses.filter(refused).length, 1, `round ${i}: ${statuses}`);
    assert.equal(active.length, 1, `round ${i}: one active platform admin remains`);
  }
});

// ---- routes/admin.js: last workspace admin ----
async function workspaceWithTwoAdmins() {
  const ws = crypto.randomUUID();
  const ws2 = crypto.randomUUID();
  await db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?), (?, ?, ?)').run(ws, ORG, 'WS', ws2, ORG, 'WS2');
  const x = await mkUser('user');
  const y = await mkUser('user');
  const wm = "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin')";
  await db.prepare(wm).run(ws, x.id);
  await db.prepare(wm).run(ws, y.id);
  return { ws, ws2, x, y };
}
const wsAdmins = async (ws) => Number((await db.prepare("SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id = ? AND role = 'workspace_admin'").get(ws)).n);

test('admin.js: the last workspace admin cannot be demoted, removed, re-added lower or moved out (409)', async () => {
  const p = await mkUser('platform_admin');
  const { ws, ws2, x, y } = await workspaceWithTwoAdmins();
  await db.prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?').run(ws, y.id); // x is the only admin now
  const checks = [
    ['PUT role', () => call('PUT', `/api/admin/users/${x.id}/workspaces/${ws}`, p.token, { role: 'workspace_viewer' })],
    ['POST re-add lower', () => call('POST', `/api/admin/users/${x.id}/workspaces`, p.token, { workspaceId: ws, role: 'workspace_editor' })],
    ['DELETE', () => call('DELETE', `/api/admin/users/${x.id}/workspaces/${ws}`, p.token)],
    ['PUT move', () => call('PUT', `/api/admin/users/${x.id}/workspace`, p.token, { workspaceId: ws2 })],
  ];
  for (const [label, run] of checks) {
    const r = await run();
    assert.equal(r.status, 409, `${label}: ${r.text}`);
    assert.match(r.json.error, /last admin/, label);
  }
  assert.equal(await wsAdmins(ws), 1, 'x is still the admin');
});

const ADMIN_RACES = [
  ['PUT role', (p, ws) => (u) => call('PUT', `/api/admin/users/${u.id}/workspaces/${ws}`, p.token, { role: 'workspace_viewer' })],
  ['POST re-add lower', (p, ws) => (u) => call('POST', `/api/admin/users/${u.id}/workspaces`, p.token, { workspaceId: ws, role: 'workspace_editor' })],
  ['DELETE', (p, ws) => (u) => call('DELETE', `/api/admin/users/${u.id}/workspaces/${ws}`, p.token)],
  ['PUT move', (p, ws, ws2) => (u) => call('PUT', `/api/admin/users/${u.id}/workspace`, p.token, { workspaceId: ws2 })],
];

test('admin.js race: the two admins of a workspace demoted / re-added / removed / moved at the same time - exactly one succeeds', async () => {
  const p = await mkUser('platform_admin');
  for (const [label, make] of ADMIN_RACES) {
    for (let i = 0; i < ROUNDS; i++) {
      const { ws, ws2, x, y } = await workspaceWithTwoAdmins();
      const op = make(p, ws, ws2);
      const gate = ['SELECT user_id FROM workspace_members WHERE workspace_id = ? FOR UPDATE', [ws]];
      const results = await throughGate(gate, () => Promise.all([op(x), op(y)]));
      const statuses = results.map((r) => r.status);
      assert.deepEqual(statuses.slice().sort(), [200, 409], `${label} round ${i}: ${statuses} ${results.map((r) => r.text).join(' | ')}`);
      assert.equal(await wsAdmins(ws), 1, `${label} round ${i}: one workspace admin remains`);
    }
  }
});

// ---- the lock row is part of the schema contract ----
test('startup schema repair: a missing app_locks row or table is recreated (and the guard refuses to run without it)', async () => {
  const { verifyAndRepairSchema } = require('../lib/schema-check');
  const lockRow = () => db.prepare("SELECT name FROM app_locks WHERE name = 'platform_admins'").get();
  const repair = () => verifyAndRepairSchema(db, { onMissing: (m) => { throw new Error(`unexpected missing schema: ${m.join(', ')}`); } });

  await db.prepare("DELETE FROM app_locks WHERE name = 'platform_admins'").run();
  await assert.rejects(() => guardedDemoteInTx({ id: 'nobody' }), /app_locks row 'platform_admins' is missing/);
  await repair();
  assert.ok(await lockRow(), 'row re-seeded');

  await db.exec('DROP TABLE app_locks');
  await repair();
  assert.ok(await lockRow(), 'table recreated and row seeded');
});
