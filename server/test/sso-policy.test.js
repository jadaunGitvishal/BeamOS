'use strict';

// Ref 5: lib/sso-policy.js isSsoOnlyUser() against the REAL MySQL database
// (after the real initDb(), so organizations.sso_only exists). Every row is a
// disposable, randomly-suffixed fixture deleted in after() (helpers/disposable.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { db, initDb } = require('../db/database');
const { isSsoOnlyUser } = require('../lib/sso-policy');
const { randTag, cleanupUsers } = require('./helpers/disposable');

const userIds = [];
const orgIds = [];

async function mkUser(role = 'user') {
  const id = crypto.randomUUID();
  await db.prepare('INSERT INTO users (id, email, name, role) VALUES (?, ?, ?, ?)')
    .run(id, `ssopolicy-${randTag()}@policy.local`, 'policy test', role);
  userIds.push(id);
  return { id, role };
}

// An org (owned by a throwaway owner) with one workspace.
async function mkOrg(ssoOnly) {
  const owner = await mkUser();
  const orgId = crypto.randomUUID();
  const wsId = crypto.randomUUID();
  await db.prepare('INSERT INTO organizations (id, name, owner_user_id, sso_only) VALUES (?, ?, ?, ?)')
    .run(orgId, `ssopolicy-org-${randTag()}`, owner.id, ssoOnly ? 1 : 0);
  await db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, 'Default')").run(wsId, orgId);
  orgIds.push(orgId);
  return { orgId, wsId };
}
const joinOrg = (user, org, role = 'org_admin') =>
  db.prepare('INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, ?)').run(org.orgId, user.id, role);
const joinWorkspace = (user, org, role = 'workspace_viewer') =>
  db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)').run(org.wsId, user.id, role);

test.before(async () => { await initDb(); });
test.after(async () => {
  // Orgs first (cascades members + workspaces + workspace_members), then users.
  for (const id of orgIds) await db.prepare('DELETE FROM organizations WHERE id = ?').run(id);
  await cleanupUsers(db, userIds);
  await db.close();
});

test('no memberships at all -> false', async () => {
  assert.equal(await isSsoOnlyUser(db, await mkUser()), false);
});

test('missing / id-less user -> false', async () => {
  assert.equal(await isSsoOnlyUser(db, null), false);
  assert.equal(await isSsoOnlyUser(db, {}), false);
});

test('direct org member: true only when that org is sso_only', async () => {
  const sso = await mkOrg(true);
  const plain = await mkOrg(false);
  const a = await mkUser();
  const b = await mkUser();
  await joinOrg(a, sso);
  await joinOrg(b, plain);
  assert.equal(await isSsoOnlyUser(db, a), true);
  assert.equal(await isSsoOnlyUser(db, b), false);
});

test('member ONLY via a workspace of an sso_only org -> true', async () => {
  const sso = await mkOrg(true);
  const plain = await mkOrg(false);
  const a = await mkUser();
  const b = await mkUser();
  await joinWorkspace(a, sso);
  await joinWorkspace(b, plain);
  assert.equal(await isSsoOnlyUser(db, a), true);
  assert.equal(await isSsoOnlyUser(db, b), false);
});

test('two orgs, one sso_only -> true (strictest wins), whichever membership path', async () => {
  const sso = await mkOrg(true);
  const plain = await mkOrg(false);
  const a = await mkUser();
  await joinOrg(a, plain);
  await joinWorkspace(a, plain);
  assert.equal(await isSsoOnlyUser(db, a), false);
  await joinWorkspace(a, sso);
  assert.equal(await isSsoOnlyUser(db, a), true);
});

test('platform admins are exempt even as direct members of an sso_only org', async () => {
  const sso = await mkOrg(true);
  for (const role of ['platform_admin', 'superadmin']) {
    const u = await mkUser(role);
    await joinOrg(u, sso);
    await joinWorkspace(u, sso);
    assert.equal(await isSsoOnlyUser(db, u), false, role);
  }
  // ...while a platform_operator (not in PLATFORM_ROLES) is not exempt.
  const op = await mkUser('platform_operator');
  await joinOrg(op, sso);
  assert.equal(await isSsoOnlyUser(db, op), true);
});
