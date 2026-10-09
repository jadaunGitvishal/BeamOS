'use strict';

// Audit-chain fix (follow-up to Refs 17/20): deleting a user must NOT touch the
// hashed columns of their activity_log rows. Before the fix, deleteUserCascade
// set activity_log.user_id / acting_user_id to NULL, and since user_id is part of
// each row's entry_hash, every such row then failed verifyChain as
// content_altered. Now the rows keep the id (the activity_log -> users FKs are
// dropped by lib/schema-check.js) and the audit view labels them 'Deleted user'.
//
// Real HTTP against the REAL MySQL database (in-process app,
// helpers/inprocess-app.js), after the real initDb() - which runs the FK repair.

const test = require('node:test');
const assert = require('node:assert/strict');

const { db, initDb } = require('../db/database');
const { appendEntry, verifyChain } = require('../lib/activity-chain');
const { dropUserForeignKeys } = require('../lib/schema-check');
const { startInProcessApp } = require('./helpers/inprocess-app');
const { randTag, cleanupUsers } = require('./helpers/disposable');

const PASSWORD = 'audit-user-deletion-pass-1';
const TAG = randTag();

let app;
const cleanup = [];
let admin, victim, bystander;

async function req(method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${app.base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}

async function registerUser(prefix) {
  const email = `${prefix}-${TAG}-${randTag()}@auditdel.local`;
  const name = `${prefix}-${TAG}`;
  const r = await req('POST', '/api/auth/register', { body: { email, password: PASSWORD, name, createOrg: true } });
  assert.equal(r.status, 201, r.text);
  cleanup.push(r.json.user.id);
  const ws = await app.db.prepare('SELECT organization_id FROM workspaces WHERE id = ?').get(r.json.current_workspace_id);
  return { id: r.json.user.id, email, name, token: r.json.token, workspaceId: r.json.current_workspace_id, orgId: ws.organization_id };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const maxId = async () => Number((await app.db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM activity_log').get()).m);
const row = (id) => app.db.prepare('SELECT id, user_id, acting_user_id, workspace_id, organization_id, action, details FROM activity_log WHERE id = ?').get(id);

// Audit writes are fire-and-forget after the response: poll for the row.
async function waitForRow(sql, ...params) {
  const deadline = Date.now() + 8000;
  for (;;) {
    const r = await app.db.prepare(sql).get(...params);
    if (r || Date.now() > deadline) return r;
    await sleep(50);
  }
}

const fksToUsers = async (table) =>
  (await app.db
    .prepare(`SELECT CONSTRAINT_NAME AS name FROM information_schema.KEY_COLUMN_USAGE
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME = 'users'`)
    .all(table)).map((r) => r.name);

test.before(async () => {
  await initDb(); // runs verifyAndRepairSchema -> dropUserForeignKeys('activity_log')
  app = await startInProcessApp({ only: ['/api/activity', '/api/admin', '/api/playlists'] });
  admin = await registerUser('auditdeladmin');
  await app.db.prepare("UPDATE users SET role = 'platform_admin' WHERE id = ?").run(admin.id);
  victim = await registerUser('auditdelvictim');
  bystander = await registerUser('auditdelbystander');
});

test.after(async () => {
  try {
    if (app) {
      if (admin) await app.db.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(admin.id).catch(() => {});
      await cleanupUsers(app.db, cleanup.reverse());
    }
  } finally {
    if (app) await app.stop(); else await db.close();
  }
});

// ---- user deletion keeps the hashed columns ----

const victimRows = {}; // name -> activity_log id
let deletionRange;

test('deleting a user keeps user_id / acting_user_id on their audit rows; chain stays valid', async () => {
  const start = (await maxId()) + 1;

  // A mutation (activityLogger) ...
  const p = await req('POST', '/api/playlists', { token: victim.token, body: { name: `victim-pl-${TAG}` } });
  assert.equal(p.status, 201, p.text);
  victimRows.mutation = (await waitForRow("SELECT id FROM activity_log WHERE user_id = ? AND details = ?", victim.id, `name: victim-pl-${TAG}`)).id;
  // ... an EXPORT ...
  const e = await req('GET', '/api/activity/export?format=csv', { token: victim.token });
  assert.equal(e.status, 200);
  victimRows.export = (await waitForRow("SELECT id FROM activity_log WHERE user_id = ? AND action = 'EXPORT /api/activity/export' AND id >= ?", victim.id, start)).id;
  // ... and a row with acting_user_id = victim. No production writer sets
  // acting_user_id today, so it goes through the real chained writer directly.
  victimRows.acting = (await appendEntry(app.db, { user_id: admin.id, acting_user_id: victim.id, action: `test:acting_as ${TAG}` })).id;
  // A row for a user who is NOT deleted.
  const b = await req('POST', '/api/playlists', { token: bystander.token, body: { name: `bystander-pl-${TAG}` } });
  assert.equal(b.status, 201, b.text);
  victimRows.bystander = (await waitForRow("SELECT id FROM activity_log WHERE user_id = ? AND details = ?", bystander.id, `name: bystander-pl-${TAG}`)).id;

  // Delete through the real admin route.
  const d = await req('DELETE', `/api/auth/users/${victim.id}`, { token: admin.token });
  assert.equal(d.status, 200, d.text);
  cleanup.splice(cleanup.indexOf(victim.id), 1);
  assert.equal(await app.db.prepare('SELECT id FROM users WHERE id = ?').get(victim.id), undefined, 'user row gone');
  await waitForRow("SELECT id FROM activity_log WHERE action = 'delete_user' AND user_id = ? AND id >= ?", admin.id, start);

  assert.equal((await row(victimRows.mutation)).user_id, victim.id);
  assert.equal((await row(victimRows.export)).user_id, victim.id);
  assert.equal((await row(victimRows.acting)).acting_user_id, victim.id);
  assert.equal((await row(victimRows.bystander)).user_id, bystander.id);

  const end = await maxId();
  deletionRange = { start, end };
  const report = await verifyChain(app.db, { startId: start, endId: end });
  assert.equal(report.ok, true, JSON.stringify(report.failures));
  assert.ok(report.checked >= 4);
});

test("audit list + export label the deleted user's rows 'Deleted user'; other rows unchanged", async () => {
  const list = await req('GET', '/api/activity?limit=200', { token: admin.token });
  assert.equal(list.status, 200);
  const byId = new Map(list.json.map((r) => [Number(r.id), r]));
  for (const k of ['mutation', 'export']) {
    const r = byId.get(victimRows[k]);
    assert.ok(r, `${k} row present in list`);
    assert.equal(r.user_name, 'Deleted user');
    assert.equal(r.user_email, null);
    assert.equal(r.user_id, victim.id);
  }
  const by = byId.get(victimRows.bystander);
  assert.equal(by.user_name, bystander.name);
  assert.equal(by.user_email, bystander.email);
  // acting row's user is the (existing) admin - unchanged.
  assert.equal(byId.get(victimRows.acting).user_name, admin.name);

  const exp = await req('GET', '/api/activity/export?format=json', { token: admin.token });
  assert.equal(exp.status, 200);
  // export columns: User Name, User Email, Action, Device ID, Details, ...
  const nameCol = 0, emailCol = 1, detailsCol = 4;
  const victimRow = exp.json.rows.find((r) => r[detailsCol] === `name: victim-pl-${TAG}`);
  const bystanderRow = exp.json.rows.find((r) => r[detailsCol] === `name: bystander-pl-${TAG}`);
  assert.equal(victimRow[nameCol], 'Deleted user');
  assert.equal(victimRow[emailCol], '');
  assert.equal(bystanderRow[nameCol], bystander.name);
  assert.equal(bystanderRow[emailCol], bystander.email);
});

// ---- org / workspace deletion still nulls the unhashed columns ----

test('org and workspace deletion still null workspace_id / organization_id; chain stays valid', async () => {
  const orgUser = await registerUser('auditdelorg');
  const wsUser = await registerUser('auditdelws');
  const start = (await maxId()) + 1;

  const p1 = await req('POST', '/api/playlists', { token: orgUser.token, body: { name: `org-pl-${TAG}` } });
  assert.equal(p1.status, 201, p1.text);
  const orgWsRow = (await waitForRow('SELECT id FROM activity_log WHERE user_id = ? AND details = ?', orgUser.id, `name: org-pl-${TAG}`)).id;
  const orgRow = (await appendEntry(app.db, { user_id: orgUser.id, organization_id: orgUser.orgId, action: `test:org_scoped ${TAG}` })).id;
  const p2 = await req('POST', '/api/playlists', { token: wsUser.token, body: { name: `ws-pl-${TAG}` } });
  assert.equal(p2.status, 201, p2.text);
  const wsRow = (await waitForRow('SELECT id FROM activity_log WHERE user_id = ? AND details = ?', wsUser.id, `name: ws-pl-${TAG}`)).id;

  assert.equal((await row(orgWsRow)).workspace_id, orgUser.workspaceId);
  assert.equal((await row(orgRow)).organization_id, orgUser.orgId);
  assert.equal((await row(wsRow)).workspace_id, wsUser.workspaceId);

  const d1 = await req('DELETE', `/api/admin/orgs/${orgUser.orgId}`, { token: admin.token });
  assert.equal(d1.status, 200, d1.text);
  const d2 = await req('DELETE', `/api/admin/workspaces/${wsUser.workspaceId}`, { token: admin.token });
  assert.equal(d2.status, 200, d2.text);

  assert.equal((await row(orgWsRow)).workspace_id, null);
  assert.equal((await row(orgRow)).organization_id, null);
  assert.equal((await row(wsRow)).workspace_id, null);
  assert.equal((await row(orgWsRow)).user_id, orgUser.id, 'user_id untouched');

  await sleep(300); // let the admin_delete_* audit rows land
  const report = await verifyChain(app.db, { startId: start, endId: await maxId() });
  assert.equal(report.ok, true, JSON.stringify(report.failures));
});

// ---- the FK repair ----

test('FK repair on a scratch table: drops every FK to users, second run is a no-op', async () => {
  const table = `audit_fk_scratch_${TAG}`;
  await app.db.exec(`CREATE TABLE ${table} (
    id INT PRIMARY KEY,
    user_id VARCHAR(64),
    acting_user_id VARCHAR(64),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (acting_user_id) REFERENCES users(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  try {
    assert.equal((await fksToUsers(table)).length, 2, 'precondition: two FKs to users');
    const dropped = await dropUserForeignKeys(app.db, table);
    assert.equal(dropped.length, 2);
    assert.deepEqual(await fksToUsers(table), []);
    assert.deepEqual(await dropUserForeignKeys(app.db, table), [], 'second run is a no-op');
    // Indexes created for the FKs are left in place.
    const idx = await app.db
      .prepare("SELECT DISTINCT INDEX_NAME AS n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?")
      .all(table);
    assert.ok(idx.some((r) => r.n === 'user_id') && idx.some((r) => r.n === 'acting_user_id'), JSON.stringify(idx));
  } finally {
    await app.db.exec(`DROP TABLE IF EXISTS ${table}`);
  }
});

test('real activity_log: startup repair left no FK to users; re-running is a no-op; other FKs kept', async () => {
  assert.deepEqual(await fksToUsers('activity_log'), []);
  assert.deepEqual(await dropUserForeignKeys(app.db), []);
  const others = (await app.db
    .prepare(`SELECT REFERENCED_TABLE_NAME AS t FROM information_schema.KEY_COLUMN_USAGE
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'activity_log' AND REFERENCED_TABLE_NAME IS NOT NULL`)
    .all()).map((r) => r.t).sort();
  assert.deepEqual(others, ['organizations', 'workspaces']);
});

test('invalid table name is rejected before any SQL runs', async () => {
  await assert.rejects(() => dropUserForeignKeys(app.db, 'activity_log; DROP TABLE users'), /invalid table name/);
});
