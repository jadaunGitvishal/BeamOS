'use strict';

// Phase 1C batch 2: org / workspace access grants write their audit row IN THE SAME
// TRANSACTION as the change (services/activity.js auditInTx). Policy: a change that is not
// strictly lower is a grant - if its audit write fails the change is rolled back and the
// request gets 503 { error: 'Change not applied: audit unavailable', code:
// 'AUDIT_UNAVAILABLE' }. A strict demotion / narrowing always applies, with the awaited
// post-commit row (auditOrWarn prints "[audit] NOT AUDITED" if that write fails).
//
// Routes: org member add / role, workspace member role, invite create / accept, Entra
// role mapping create, region scopes, region move, workspace -> region, token-lifetime
// policy, SSO-only, admin.js membership move / upsert / role and POST /orgs.
//
// Failure injection: helpers/fail-audit-in-tx.js (loaded first) - failNextAuditInTx arms
// one in-transaction failure, failNextPostCommitAudit one post-commit (appendEntry)
// failure. Each failure proof snapshots the touched tables before / after.
//
// Also: race tests for three pre-existing races fixed in this batch (org member add,
// invite double-accept, region-scope role check) and for the region move checks; a mixed
// load test (concurrent grants / demotions / scope changes in one org + a cascade delete of
// a second org + fire-and-forget rows); verifyChain + GET /api/activity/verify-integrity.
//
// Real routers in-process (helpers/inprocess-app.js) against the real MySQL test DB.
// services/email.sendEmail is replaced before the routers load (counts sends, never
// sends). Fixtures are test-owned (prefix aia-).

const failHook = require('./helpers/fail-audit-in-tx'); // before services/activity loads

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const config = require('../config');
const email = require('../services/email');
const { db } = require('../db/database');
const { generateToken } = require('../middleware/auth');
const { logActivity } = require('../services/activity');
const { verifyChain } = require('../lib/activity-chain');
const { startInProcessApp } = require('./helpers/inprocess-app');
const { randTag, cleanupUsers } = require('./helpers/disposable');
const { maxAuditId, waitForAuditRows } = require('./helpers/wait-for-audit');

// Before any router is required: routes/workspaces.js destructures sendEmail at load.
let emailResult = { sent: false, reason: 'not_configured' };
let emailsSent = 0;
const realSendEmail = email.sendEmail;
email.sendEmail = async () => { emailsSent++; return emailResult; };

const P = `aia-${randTag()}`;
const id = (n) => `${P}-${n}`;
let app;
let since0;
const userIds = [];
const savedTenant = config.ssoTenantId;
const UNAVAILABLE = { error: 'Change not applied: audit unavailable', code: 'AUDIT_UNAVAILABLE' };

// console.error spy for the "[audit] NOT AUDITED" marker (still printed).
const realError = console.error;
const errors = [];
console.error = (...a) => { errors.push(a.join(' ')); realError(...a); };

test.before(async () => {
  app = await startInProcessApp({ only: ['/api/organizations', '/api/workspaces', '/api/admin', '/api/activity'] });
  since0 = await maxAuditId(app.db);
});

test.after(async () => {
  try {
    if (app) {
      failHook.disarm();
      config.ssoTenantId = savedTenant;
      // Newest first: an org owner is deletable only once its other members are gone.
      await cleanupUsers(app.db, [...userIds].reverse());
    }
  } finally {
    email.sendEmail = realSendEmail;
    console.error = realError;
    if (app) await app.stop(); else await db.close();
  }
});

// ---- fixtures ----
async function mkUser(role = 'user') {
  const uid = id(randTag());
  const mail = `${uid}@x.local`;
  await app.db.prepare("INSERT INTO users (id, email, name, password_hash, auth_provider, role) VALUES (?, ?, ?, 'x', 'local', ?)").run(uid, mail, uid, role);
  userIds.push(uid);
  return { id: uid, email: mail, role, token: generateToken({ id: uid, email: mail, role }, null) };
}
// An org owned by `owner` (org_owner member) with one workspace where the owner is admin.
async function mkOrg(owner) {
  const orgId = crypto.randomUUID();
  const wsId = crypto.randomUUID();
  const name = `${P} Org ${randTag()}`;
  await app.db.prepare("INSERT INTO organizations (id, name, owner_user_id, plan_id, subscription_status) VALUES (?, ?, ?, 'enterprise', 'active')").run(orgId, name, owner.id);
  await addOrgMember(orgId, owner, 'org_owner');
  const wsName = `${P} WS ${randTag()}`;
  await app.db.prepare('INSERT INTO workspaces (id, organization_id, name, created_by) VALUES (?, ?, ?, ?)').run(wsId, orgId, wsName, owner.id);
  await addWsMember(wsId, owner, 'workspace_admin');
  return { orgId, orgName: name, wsId, wsName };
}
async function mkWorkspace(o, owner) {
  const wsId = crypto.randomUUID();
  const wsName = `${P} WS ${randTag()}`;
  await app.db.prepare('INSERT INTO workspaces (id, organization_id, name, created_by) VALUES (?, ?, ?, ?)').run(wsId, o.orgId, wsName, owner.id);
  await addWsMember(wsId, owner, 'workspace_admin');
  return { wsId, wsName };
}
const addOrgMember = (orgId, u, role) => app.db.prepare('INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, ?)').run(orgId, u.id, role);
const addWsMember = (wsId, u, role) => app.db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)').run(wsId, u.id, role);
async function mkRegion(orgId, name, level = 'region', parentId = null) {
  const rid = crypto.randomUUID();
  await app.db.prepare('INSERT INTO regions (id, organization_id, name, level, parent_id) VALUES (?, ?, ?, ?, ?)').run(rid, orgId, `${P} ${name} ${randTag()}`, level, parentId);
  return rid;
}

// ---- request / row helpers ----
async function call(method, path, token, body) {
  const r = await fetch(`${app.base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, json, text };
}
const rowsSince = (since) => app.db.prepare(
  'SELECT id, user_id, action, details, workspace_id, organization_id FROM activity_log WHERE id > ? ORDER BY id',
).all(since);
const rowsOf = async (since, action) => (await rowsSince(since)).filter((r) => r.action === action);
async function oneRow(since, action) {
  const rows = await rowsOf(since, action);
  assert.equal(rows.length, 1, `exactly one ${action} row, read immediately after the response (got ${rows.length})`);
  return rows[0];
}

// Every row an org's access can depend on, as one comparable value.
async function snapshot(orgId) {
  const q = (sql, ...p) => app.db.prepare(sql).all(...p);
  return JSON.stringify({
    org: await q('SELECT name, sso_only, max_token_lifetime_days FROM organizations WHERE id = ?', orgId),
    orgMembers: await q('SELECT user_id, role, source FROM organization_members WHERE organization_id = ? ORDER BY user_id', orgId),
    workspaces: await q('SELECT id, region_id FROM workspaces WHERE organization_id = ? ORDER BY id', orgId),
    wsMembers: await q('SELECT wm.workspace_id, wm.user_id, wm.role FROM workspace_members wm JOIN workspaces w ON w.id = wm.workspace_id WHERE w.organization_id = ? ORDER BY wm.workspace_id, wm.user_id', orgId),
    invites: await q('SELECT i.id, i.email, i.role FROM workspace_invites i JOIN workspaces w ON w.id = i.workspace_id WHERE w.organization_id = ? ORDER BY i.id', orgId),
    regions: await q('SELECT id, name, level, parent_id FROM regions WHERE organization_id = ? ORDER BY id', orgId),
    scopes: await q('SELECT user_id, region_id FROM region_viewer_scopes WHERE organization_id = ? ORDER BY user_id, region_id', orgId),
    mappings: await q('SELECT claim_value, workspace_id, role FROM entra_role_mappings WHERE organization_id = ? ORDER BY id', orgId),
  });
}

// Injected in-transaction audit failure for `action`: 503 AUDIT_UNAVAILABLE, the org's
// rows unchanged, no row. `extra()` returns more state that must not change.
async function assertFailureNotApplied(orgId, action, request, extra = async () => '') {
  const before = (await snapshot(orgId)) + (await extra());
  const since = await maxAuditId(app.db);
  const fired0 = failHook.fired();
  failHook.failNextAuditInTx(action);
  const r = await request();
  const disarmed = failHook.disarm();
  const after = (await snapshot(orgId)) + (await extra());
  const rows = await rowsOf(since, action);
  if (after !== before && rows.length === 0) {
    assert.fail(`change applied, no row: ${action} answered ${r.status} and changed the DB without an audit row`);
  }
  assert.equal(disarmed, false, `the injected failure for ${action} fired`);
  assert.equal(failHook.fired(), fired0 + 1);
  assert.equal(r.status, 503, `${r.status} ${r.text}`);
  assert.deepEqual(r.json, UNAVAILABLE);
  assert.equal(after, before, 'the change was not applied');
  assert.deepEqual(rows, [], `no ${action} row`);
}

// A demotion / narrowing with BOTH failures armed: the in-transaction one never fires (it is
// not a grant), the post-commit write fails, the change still applies and the marker prints.
async function assertDemotionStillApplies(orgId, action, request) {
  const before = await snapshot(orgId);
  const since = await maxAuditId(app.db);
  errors.length = 0;
  const firedPost0 = failHook.firedPostCommit();
  failHook.failNextAuditInTx(action);
  failHook.failNextPostCommitAudit(action);
  const r = await request();
  const inTxStillArmed = failHook.disarm();
  assert.ok(r.status === 200 || r.status === 201, `${r.status} ${r.text}`);
  assert.equal(inTxStillArmed, true, `${action}: a demotion never reaches auditInTx`);
  assert.equal(failHook.firedPostCommit(), firedPost0 + 1, 'its post-commit write failed');
  assert.notEqual(await snapshot(orgId), before, 'the change applied anyway');
  assert.deepEqual(await rowsOf(since, action), [], 'no row (the write failed)');
  assert.ok(errors.some((e) => e.includes(`[audit] NOT AUDITED: action=${action}`)), errors.join('\n'));
}

// ---- failure proofs: org members ----
test('org member add: audit failure -> 503, no membership; next attempt -> one row', async () => {
  const owner = await mkUser();
  const o = await mkOrg(owner);
  const u = await mkUser();
  const body = { email: u.email, role: 'org_admin' };
  await assertFailureNotApplied(o.orgId, 'org_member_added', () => call('POST', `/api/organizations/${o.orgId}/members`, owner.token, body));
  const since = await maxAuditId(app.db);
  const ok = await call('POST', `/api/organizations/${o.orgId}/members`, owner.token, body);
  assert.equal(ok.status, 201, ok.text);
  const row = await oneRow(since, 'org_member_added');
  assert.equal(row.details, `org: ${o.orgName} (${o.orgId}), target: ${u.email}, role: org_admin`);
  assert.equal(row.organization_id, o.orgId);
});

test('org member role: grant (incl. a lateral swap) in-transaction with before -> after; demotion still applies when its write fails', async () => {
  const owner = await mkUser();
  const o = await mkOrg(owner);
  const u = await mkUser();
  await addOrgMember(o.orgId, u, 'field_technician');
  const url = `/api/organizations/${o.orgId}/members/${u.id}`;

  await assertFailureNotApplied(o.orgId, 'org_member_role_changed', () => call('PUT', url, owner.token, { role: 'regional_viewer' }));
  let since = await maxAuditId(app.db);
  assert.equal((await call('PUT', url, owner.token, { role: 'regional_viewer' })).status, 200);
  assert.equal((await oneRow(since, 'org_member_role_changed')).details, `org: ${o.orgName} (${o.orgId}), target: ${u.email}, role: field_technician -> regional_viewer`);

  await assertFailureNotApplied(o.orgId, 'org_member_role_changed', () => call('PUT', url, owner.token, { role: 'org_admin' }));
  since = await maxAuditId(app.db);
  assert.equal((await call('PUT', url, owner.token, { role: 'org_admin' })).status, 200);
  assert.equal((await oneRow(since, 'org_member_role_changed')).details, `org: ${o.orgName} (${o.orgId}), target: ${u.email}, role: regional_viewer -> org_admin`);

  await assertDemotionStillApplies(o.orgId, 'org_member_role_changed', () => call('PUT', url, owner.token, { role: 'field_technician' }));
  // An unchanged role writes no row.
  since = await maxAuditId(app.db);
  assert.equal((await call('PUT', url, owner.token, { role: 'field_technician' })).status, 200);
  assert.deepEqual(await rowsOf(since, 'org_member_role_changed'), []);
});

test('workspace member role: grant in-transaction; demotion still applies when its write fails', async () => {
  const owner = await mkUser();
  const o = await mkOrg(owner);
  const u = await mkUser();
  await addWsMember(o.wsId, u, 'workspace_viewer');
  const url = `/api/workspaces/${o.wsId}/members/${u.id}`;
  await assertFailureNotApplied(o.orgId, 'workspace_member_role_changed', () => call('PUT', url, owner.token, { role: 'workspace_editor' }));
  const since = await maxAuditId(app.db);
  assert.equal((await call('PUT', url, owner.token, { role: 'workspace_editor' })).status, 200);
  assert.equal((await oneRow(since, 'workspace_member_role_changed')).details, `workspace: ${o.wsName} (${o.wsId}), target: ${u.email}, role: workspace_viewer -> workspace_editor`);
  await assertDemotionStillApplies(o.orgId, 'workspace_member_role_changed', () => call('PUT', url, owner.token, { role: 'workspace_viewer' }));
});

// ---- invites ----
test('invite create: audit failure -> 503, no invite and NO email; next attempt -> one row and one email', async () => {
  const owner = await mkUser();
  const o = await mkOrg(owner);
  const invitee = `${P}-inv-${randTag()}@x.local`;
  const sent0 = emailsSent;
  await assertFailureNotApplied(o.orgId, 'workspace_invite_created', () => call('POST', `/api/workspaces/${o.wsId}/invites`, owner.token, { email: invitee, role: 'workspace_editor' }));
  assert.equal(emailsSent, sent0, 'no email was sent');
  const since = await maxAuditId(app.db);
  const ok = await call('POST', `/api/workspaces/${o.wsId}/invites`, owner.token, { email: invitee, role: 'workspace_editor' });
  assert.equal(ok.status, 201, ok.text);
  assert.equal(emailsSent, sent0 + 1);
  assert.equal((await oneRow(since, 'workspace_invite_created')).details, `workspace: ${o.wsName} (${o.wsId}), email: ${invitee}, role: workspace_editor, expires_at: ${ok.json.expires_at}`);
});

test('invite accept: audit failure -> 503, invite kept, no membership; next attempt -> one row', async () => {
  const owner = await mkUser();
  const o = await mkOrg(owner);
  const invitee = await mkUser();
  const c = await call('POST', `/api/workspaces/${o.wsId}/invites`, owner.token, { email: invitee.email, role: 'workspace_editor' });
  assert.equal(c.status, 201, c.text);
  const url = `/api/auth/accept-invite/${c.json.id}`;
  await assertFailureNotApplied(o.orgId, 'workspace_invite_accepted', () => call('POST', url, invitee.token));
  const since = await maxAuditId(app.db);
  const ok = await call('POST', url, invitee.token);
  assert.equal(ok.status, 200, ok.text);
  assert.equal((await oneRow(since, 'workspace_invite_accepted')).details, `workspace: ${o.wsName} (${o.wsId}), role: workspace_editor`);
  assert.ok(await app.db.prepare('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(o.wsId, invitee.id));
});

// ---- Entra mapping, regions, workspace -> region ----
test('Entra role mapping create: audit failure -> 503, no mapping; next attempt -> one row', async () => {
  const owner = await mkUser();
  const o = await mkOrg(owner);
  const body = { claim_value: `${P}.Editor`, role: 'workspace_editor', workspace_id: o.wsId };
  await assertFailureNotApplied(o.orgId, 'entra_role_mapping_created', () => call('POST', `/api/organizations/${o.orgId}/entra-role-mappings`, owner.token, body));
  const since = await maxAuditId(app.db);
  const ok = await call('POST', `/api/organizations/${o.orgId}/entra-role-mappings`, owner.token, body);
  assert.equal(ok.status, 201, ok.text);
  assert.equal((await oneRow(since, 'entra_role_mapping_created')).details, `org: ${o.orgName} (${o.orgId}), claim: ${P}.Editor, role: workspace_editor, workspace: ${o.wsId}`);
});

test('region scopes: adding a region is a grant (in-transaction, before -> after); narrowing still applies when its write fails', async () => {
  const owner = await mkUser();
  const o = await mkOrg(owner);
  const rv = await mkUser();
  await addOrgMember(o.orgId, rv, 'regional_viewer');
  const r1 = await mkRegion(o.orgId, 'R1');
  const r2 = await mkRegion(o.orgId, 'R2');
  const url = `/api/organizations/${o.orgId}/members/${rv.id}/region-scopes`;
  const list = (ids) => `[${[...ids].sort().join(', ')}]`;
  await assertFailureNotApplied(o.orgId, 'region_scopes_set', () => call('PUT', url, owner.token, { region_ids: [r1] }));
  let since = await maxAuditId(app.db);
  assert.equal((await call('PUT', url, owner.token, { region_ids: [r1] })).status, 200);
  assert.equal((await oneRow(since, 'region_scopes_set')).details, `org: ${o.orgName} (${o.orgId}), target: ${rv.email}, regions: [] -> ${list([r1])}`);
  // A swap (one removed, one added) is a grant too.
  await assertFailureNotApplied(o.orgId, 'region_scopes_set', () => call('PUT', url, owner.token, { region_ids: [r2] }));
  since = await maxAuditId(app.db);
  assert.equal((await call('PUT', url, owner.token, { region_ids: [r1, r2] })).status, 200);
  assert.equal((await oneRow(since, 'region_scopes_set')).details, `org: ${o.orgName} (${o.orgId}), target: ${rv.email}, regions: ${list([r1])} -> ${list([r1, r2])}`);
  await assertDemotionStillApplies(o.orgId, 'region_scopes_set', () => call('PUT', url, owner.token, { region_ids: [r2] }));
});

test('region move is a grant (in-transaction); rename and create are not (awaited after commit)', async () => {
  const owner = await mkUser();
  const o = await mkOrg(owner);
  const r1 = await mkRegion(o.orgId, 'R1');
  const r2 = await mkRegion(o.orgId, 'R2');
  const c1 = await mkRegion(o.orgId, 'C1', 'cluster', r1);
  const url = `/api/organizations/${o.orgId}/regions/${c1}`;
  await assertFailureNotApplied(o.orgId, 'region_moved', () => call('PATCH', url, owner.token, { parent_id: r2 }));
  let since = await maxAuditId(app.db);
  assert.equal((await call('PATCH', url, owner.token, { parent_id: r2 })).status, 200);
  assert.match((await oneRow(since, 'region_moved')).details, new RegExp(`\\(${c1}\\), level: cluster -> cluster, parent: ${r1} -> ${r2}$`));

  // Rename: the in-transaction hook never fires; the row is written after commit.
  since = await maxAuditId(app.db);
  failHook.failNextAuditInTx('region_renamed');
  const rn = await call('PATCH', url, owner.token, { name: `${P} renamed` });
  assert.equal(failHook.disarm(), true, 'a rename never reaches auditInTx');
  assert.equal(rn.status, 200, rn.text);
  assert.match((await oneRow(since, 'region_renamed')).details, new RegExp(`-> ${P} renamed$`));
  assert.deepEqual(await rowsOf(since, 'region_moved'), []);

  // Create: awaited post-commit row; a failed write still creates the region (loud).
  since = await maxAuditId(app.db);
  errors.length = 0;
  failHook.failNextPostCommitAudit('region_created');
  const cr = await call('POST', `/api/organizations/${o.orgId}/regions`, owner.token, { name: `${P} new` });
  assert.equal(cr.status, 201, cr.text);
  assert.ok(errors.some((e) => e.includes('[audit] NOT AUDITED: action=region_created')));
  const cr2 = await call('POST', `/api/organizations/${o.orgId}/regions`, owner.token, { name: `${P} new2` });
  assert.equal(cr2.status, 201, cr2.text);
  assert.equal((await rowsOf(since, 'region_created')).length, 1, 'the second create is audited');
});

test('workspace -> region: assign / change in-transaction; unassign still applies when its write fails', async () => {
  const owner = await mkUser();
  const o = await mkOrg(owner);
  const r1 = await mkRegion(o.orgId, 'R1');
  const r2 = await mkRegion(o.orgId, 'R2');
  const url = `/api/workspaces/${o.wsId}/region`;
  await assertFailureNotApplied(o.orgId, 'workspace_region_changed', () => call('PATCH', url, owner.token, { region_id: r1 }));
  let since = await maxAuditId(app.db);
  assert.equal((await call('PATCH', url, owner.token, { region_id: r1 })).status, 200);
  assert.equal((await oneRow(since, 'workspace_region_changed')).details, `workspace: ${o.wsName} (${o.wsId}), region: none -> ${r1}`);
  await assertFailureNotApplied(o.orgId, 'workspace_region_changed', () => call('PATCH', url, owner.token, { region_id: r2 }));
  since = await maxAuditId(app.db);
  assert.equal((await call('PATCH', url, owner.token, { region_id: r2 })).status, 200);
  assert.equal((await oneRow(since, 'workspace_region_changed')).details, `workspace: ${o.wsName} (${o.wsId}), region: ${r1} -> ${r2}`);
  await assertDemotionStillApplies(o.orgId, 'workspace_region_changed', () => call('PATCH', url, owner.token, { region_id: null }));
});

// ---- security settings ----
test('token-lifetime: raising or removing the cap is in-transaction; setting / lowering still applies when its write fails', async () => {
  const owner = await mkUser();
  const o = await mkOrg(owner);
  const url = `/api/organizations/${o.orgId}/token-policy`;
  let since = await maxAuditId(app.db);
  assert.equal((await call('PATCH', url, owner.token, { max_token_lifetime_days: 30 })).status, 200); // setting = restrict
  assert.equal((await oneRow(since, 'org_token_lifetime_changed')).details, `org: ${o.orgName} (${o.orgId}), max_token_lifetime_days: none -> 30`);
  await assertFailureNotApplied(o.orgId, 'org_token_lifetime_changed', () => call('PATCH', url, owner.token, { max_token_lifetime_days: 60 }));
  await assertFailureNotApplied(o.orgId, 'org_token_lifetime_changed', () => call('PATCH', url, owner.token, { max_token_lifetime_days: null }));
  since = await maxAuditId(app.db);
  assert.equal((await call('PATCH', url, owner.token, { max_token_lifetime_days: 60 })).status, 200);
  assert.equal((await oneRow(since, 'org_token_lifetime_changed')).details, `org: ${o.orgName} (${o.orgId}), max_token_lifetime_days: 30 -> 60`);
  await assertDemotionStillApplies(o.orgId, 'org_token_lifetime_changed', () => call('PATCH', url, owner.token, { max_token_lifetime_days: 10 }));
});

test('SSO-only: disabling is in-transaction; enabling still applies when its write fails', async () => {
  const owner = await mkUser();
  const o = await mkOrg(owner);
  const platform = await mkUser('platform_admin');
  config.ssoTenantId = '11111111-2222-3333-4444-555555555555';
  try {
    const url = `/api/organizations/${o.orgId}/auth-policy`;
    await assertDemotionStillApplies(o.orgId, 'org_sso_only_changed', () => call('PATCH', url, platform.token, { sso_only: true }));
    await assertFailureNotApplied(o.orgId, 'org_sso_only_changed', () => call('PATCH', url, platform.token, { sso_only: false }));
    const since = await maxAuditId(app.db);
    assert.equal((await call('PATCH', url, platform.token, { sso_only: false })).status, 200);
    assert.equal((await oneRow(since, 'org_sso_only_changed')).details, `org: ${o.orgName} (${o.orgId}), sso_only: true -> false`);
  } finally {
    config.ssoTenantId = savedTenant;
  }
});

// ---- admin.js ----
test('admin membership move / upsert / role and POST /orgs: grants in-transaction; a demotion still applies when its write fails', async () => {
  const owner = await mkUser();
  const o = await mkOrg(owner);
  const w2 = await mkWorkspace(o, owner);
  const platform = await mkUser('platform_admin');
  const u = await mkUser();
  await addWsMember(o.wsId, u, 'workspace_editor');

  // Move (single membership -> another workspace, as viewer).
  await assertFailureNotApplied(o.orgId, 'admin_set_user_workspace', () => call('PUT', `/api/admin/users/${u.id}/workspace`, platform.token, { workspaceId: w2.wsId }));
  let since = await maxAuditId(app.db);
  assert.equal((await call('PUT', `/api/admin/users/${u.id}/workspace`, platform.token, { workspaceId: w2.wsId })).status, 200);
  assert.equal((await oneRow(since, 'admin_set_user_workspace')).details, `target: ${u.email}, workspace: ${w2.wsId}`);

  // Upsert: a new membership is a grant; re-adding with a lower role is a demotion.
  await assertFailureNotApplied(o.orgId, 'admin_add_user_workspace', () => call('POST', `/api/admin/users/${u.id}/workspaces`, platform.token, { workspaceId: o.wsId, role: 'workspace_editor' }));
  since = await maxAuditId(app.db);
  assert.equal((await call('POST', `/api/admin/users/${u.id}/workspaces`, platform.token, { workspaceId: o.wsId, role: 'workspace_editor' })).status, 201);
  assert.equal((await oneRow(since, 'admin_add_user_workspace')).details, `target: ${u.email}, workspace: ${o.wsId}, role: workspace_editor`);
  await assertDemotionStillApplies(o.orgId, 'admin_add_user_workspace', () => call('POST', `/api/admin/users/${u.id}/workspaces`, platform.token, { workspaceId: o.wsId, role: 'workspace_viewer' }));

  // Role: promotion is a grant; demotion still applies.
  const roleUrl = `/api/admin/users/${u.id}/workspaces/${o.wsId}`;
  await assertFailureNotApplied(o.orgId, 'admin_set_user_workspace_role', () => call('PUT', roleUrl, platform.token, { role: 'workspace_admin' }));
  since = await maxAuditId(app.db);
  assert.equal((await call('PUT', roleUrl, platform.token, { role: 'workspace_admin' })).status, 200);
  assert.equal((await oneRow(since, 'admin_set_user_workspace_role')).details, `target: ${u.email}, workspace: ${o.wsId}, role: workspace_admin`);
  await assertDemotionStillApplies(o.orgId, 'admin_set_user_workspace_role', () => call('PUT', roleUrl, platform.token, { role: 'workspace_editor' }));

  // POST /orgs: the creator becomes owner - no org without its row.
  const name = `${P} admin org ${randTag()}`;
  const orgsNamed = async () => JSON.stringify(await app.db.prepare('SELECT id FROM organizations WHERE name = ?').all(name));
  await assertFailureNotApplied(o.orgId, 'admin_create_org', () => call('POST', '/api/admin/orgs', platform.token, { name }), orgsNamed);
  since = await maxAuditId(app.db);
  const created = await call('POST', '/api/admin/orgs', platform.token, { name });
  assert.equal(created.status, 201, created.text);
  const row = await oneRow(since, 'admin_create_org');
  assert.equal(row.details, `org: ${name}`);
  assert.equal(row.organization_id, created.json.id);
});

// ---- races fixed in this batch ----
// The old route checked "already a member?" with a plain SELECT and then INSERTed, outside
// any transaction. That check's statement (exact SQL below; the fixed route no longer runs
// it) is held for 200ms here, so every request is inside the window at once - the fixed
// route reads the members under a lock instead and is unaffected by the delay.
test('race: 8 concurrent adds of the same user to an org -> one 201, seven 409, one membership, one row', async () => {
  const owner = await mkUser();
  const o = await mkOrg(owner);
  const u = await mkUser();
  const realPrepare = db.prepare;
  const OLD_CHECK = 'SELECT 1 FROM organization_members WHERE organization_id = ? AND user_id = ?';
  db.prepare = function prepare(sql) {
    const stmt = realPrepare.call(this, sql);
    if (sql !== OLD_CHECK) return stmt;
    const get = stmt.get;
    stmt.get = async (...params) => { await new Promise((r) => setTimeout(r, 200)); return get.apply(stmt, params); };
    return stmt;
  };
  const since = await maxAuditId(app.db);
  let results;
  try {
    results = await Promise.all(Array.from({ length: 8 }, () => call('POST', `/api/organizations/${o.orgId}/members`, owner.token, { email: u.email, role: 'org_admin' })));
  } finally {
    db.prepare = realPrepare;
  }
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409, 409, 409, 409, 409, 409, 409], results.map((r) => r.text).join(' | '));
  assert.equal((await app.db.prepare('SELECT COUNT(*) AS n FROM organization_members WHERE organization_id = ? AND user_id = ?').get(o.orgId, u.id)).n, 1);
  assert.equal((await rowsOf(since, 'org_member_added')).length, 1);
});

test('race: 8 concurrent accepts of one invite -> one 200, the rest 404, one membership, one row, invite consumed', async () => {
  const owner = await mkUser();
  const o = await mkOrg(owner);
  const invitee = await mkUser();
  const c = await call('POST', `/api/workspaces/${o.wsId}/invites`, owner.token, { email: invitee.email, role: 'workspace_viewer' });
  assert.equal(c.status, 201, c.text);
  const since = await maxAuditId(app.db);
  const results = await Promise.all(Array.from({ length: 8 }, () => call('POST', `/api/auth/accept-invite/${c.json.id}`, invitee.token)));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 404, 404, 404, 404, 404, 404, 404], results.map((r) => `${r.status} ${r.text}`).join(' | '));
  assert.equal((await app.db.prepare('SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(o.wsId, invitee.id)).n, 1);
  assert.equal((await rowsOf(since, 'workspace_invite_accepted')).length, 1);
  assert.equal(await app.db.prepare('SELECT id FROM workspace_invites WHERE id = ?').get(c.json.id), undefined);
});

// The window: the scopes PUT checks the member's role, then validates the regions, then
// writes the scopes. Here its region-validation query (the last read before the write) is
// held for 400ms - the db.prepare wrap below delays only that statement - while the
// member's role is changed away from regional_viewer (which deletes their scopes in its own
// transaction). The scopes PUT must then refuse (400), never leave scopes on a member who
// no longer has the role.
test('race: region scopes vs a role change away from regional_viewer -> never scopes without the role', async () => {
  const realPrepare = db.prepare;
  const SLOW_SQL = 'SELECT id FROM regions WHERE organization_id = ? AND id IN (';
  let slowed = 0;
  db.prepare = function prepare(sql) {
    const stmt = realPrepare.call(this, sql);
    if (typeof sql !== 'string' || !sql.startsWith(SLOW_SQL)) return stmt;
    const all = stmt.all;
    stmt.all = async (...params) => {
      slowed++;
      await new Promise((r) => setTimeout(r, 400));
      return all.apply(stmt, params);
    };
    return stmt;
  };
  try {
    for (let i = 0; i < 3; i++) {
      const owner = await mkUser();
      const o = await mkOrg(owner);
      const rv = await mkUser();
      await addOrgMember(o.orgId, rv, 'regional_viewer');
      const r1 = await mkRegion(o.orgId, 'R1');
      const slowed0 = slowed;
      const scopes = call('PUT', `/api/organizations/${o.orgId}/members/${rv.id}/region-scopes`, owner.token, { region_ids: [r1] });
      while (slowed === slowed0) await new Promise((r) => setTimeout(r, 10)); // the PUT is in its window
      const role = await call('PUT', `/api/organizations/${o.orgId}/members/${rv.id}`, owner.token, { role: 'org_admin' });
      assert.equal(role.status, 200, role.text);
      const s = await scopes;
      const member = await app.db.prepare('SELECT role FROM organization_members WHERE organization_id = ? AND user_id = ?').get(o.orgId, rv.id);
      const left = await app.db.prepare('SELECT region_id FROM region_viewer_scopes WHERE organization_id = ? AND user_id = ?').all(o.orgId, rv.id);
      assert.equal(member.role, 'org_admin');
      assert.deepEqual(left, [], `iteration ${i}: scopes PUT answered ${s.status}, yet ${left.length} scope(s) left on a member who is no longer a regional_viewer`);
      assert.equal(s.status, 400, s.text);
    }
  } finally {
    db.prepare = realPrepare;
  }
});

test('race: concurrent region move + parent level change -> never a child at or above its parent level', async () => {
  for (let i = 0; i < 10; i++) {
    const owner = await mkUser();
    const o = await mkOrg(owner);
    const r1 = await mkRegion(o.orgId, 'R1');
    const r2 = await mkRegion(o.orgId, 'R2');
    const c1 = await mkRegion(o.orgId, 'C1', 'cluster', r1);
    const [mv, lv] = await Promise.all([
      call('PATCH', `/api/organizations/${o.orgId}/regions/${c1}`, owner.token, { parent_id: r2 }),
      call('PATCH', `/api/organizations/${o.orgId}/regions/${r2}`, owner.token, { level: 'territory' }),
    ]);
    assert.ok([200, 400].includes(mv.status) && [200, 400].includes(lv.status), `${mv.status} ${mv.text} | ${lv.status} ${lv.text}`);
    const bad = await app.db.prepare(
      `SELECT c.name, c.level AS cl, p.level AS pl FROM regions c JOIN regions p ON p.id = c.parent_id
       WHERE c.organization_id = ?`,
    ).all(o.orgId);
    const rank = { region: 0, cluster: 1, area: 2, territory: 3 };
    for (const b of bad) assert.ok(rank[b.pl] < rank[b.cl], `iteration ${i}: a ${b.cl} sits under a ${b.pl} (move ${mv.status}, level ${lv.status})`);
  }
});

// ---- mixed load ----
test('mixed load: ~40 concurrent grants / demotions / scope changes in one org + a cascade delete of a second org + fire-and-forget rows', async () => {
  const owner = await mkUser();
  const o = await mkOrg(owner);
  const platform = await mkUser('platform_admin');
  const members = [];
  for (let i = 0; i < 4; i++) {
    const m = await mkUser();
    await addWsMember(o.wsId, m, 'workspace_viewer');
    members.push(m);
  }
  const orgMembers = [];
  for (let i = 0; i < 3; i++) {
    const m = await mkUser();
    await addOrgMember(o.orgId, m, 'field_technician');
    orgMembers.push(m);
  }
  const rv = await mkUser();
  await addOrgMember(o.orgId, rv, 'regional_viewer');
  const regions = [await mkRegion(o.orgId, 'A'), await mkRegion(o.orgId, 'B'), await mkRegion(o.orgId, 'C')];
  // The second org, with members and audit rows of its own, to be cascade-deleted mid-load.
  const owner2 = await mkUser();
  const o2 = await mkOrg(owner2);
  const x = await mkUser();
  assert.equal((await call('POST', `/api/organizations/${o2.orgId}/members`, owner2.token, { email: x.email, role: 'org_admin' })).status, 201);

  const wsRoles = ['workspace_viewer', 'workspace_editor', 'workspace_admin'];
  const orgRoles = ['field_technician', 'regional_viewer', 'org_admin'];
  const pick = (a, i) => a[i % a.length];
  const since = await maxAuditId(app.db);
  const reqs = [];
  for (let i = 0; i < 12; i++) reqs.push(call('PUT', `/api/workspaces/${o.wsId}/members/${pick(members, i).id}`, owner.token, { role: pick(wsRoles, i * 7 + 1) }));
  for (let i = 0; i < 9; i++) reqs.push(call('PUT', `/api/organizations/${o.orgId}/members/${pick(orgMembers, i).id}`, owner.token, { role: pick(orgRoles, i * 5 + 2) }));
  for (let i = 0; i < 8; i++) reqs.push(call('PUT', `/api/organizations/${o.orgId}/members/${rv.id}/region-scopes`, owner.token, { region_ids: regions.slice(0, (i % 3) + 1).slice(i % 2) }));
  for (let i = 0; i < 6; i++) reqs.push(call('PATCH', `/api/organizations/${o.orgId}/token-policy`, owner.token, { max_token_lifetime_days: [30, 90, null, 10, 60, null][i] }));
  for (let i = 0; i < 4; i++) reqs.push(call('PATCH', `/api/workspaces/${o.wsId}/region`, owner.token, { region_id: [regions[0], null, regions[1], regions[2]][i] }));
  const del = call('DELETE', `/api/admin/orgs/${o2.orgId}`, platform.token);
  const ff = Array.from({ length: 20 }, (_, i) => logActivity(owner.id, 'mixed_fire_and_forget', `${P} ${i}`));
  const results = await Promise.all(reqs);
  const d = await del;
  assert.deepEqual(await Promise.all(ff), Array(20).fill(true));
  assert.equal(d.status, 200, d.text);
  const bad = results.filter((r) => ![200, 201].includes(r.status));
  assert.deepEqual(bad.map((r) => `${r.status} ${r.text}`), [], 'no errors (no deadlock 500s, no 503s)');
  assert.equal(await app.db.prepare('SELECT id FROM organizations WHERE id = ?').get(o2.orgId), undefined, 'second org deleted');

  const rows = await rowsSince(since);
  const steps = (action, pred, re) => rows.filter((r) => r.action === action && pred(r)).map((r) => {
    const m = re.exec(r.details);
    assert.ok(m, `${action} format: ${r.details}`);
    return { from: m[1], to: m[2] };
  });
  // Row ids don't give the commit order (a demotion's row is written after its commit),
  // so: some order must use every recorded change exactly once, from `start` to `final`
  // (a lost or doubled change makes that impossible). Backtracking - the lists are small.
  function chainExists(left, cur, final) {
    if (!left.length) return cur === final;
    for (let i = 0; i < left.length; i++) {
      if (left[i].from !== cur) continue;
      if (chainExists([...left.slice(0, i), ...left.slice(i + 1)], left[i].to, final)) return true;
    }
    return false;
  }
  function assertChain(label, list, start, final) {
    assert.ok(chainExists(list, start, final), `${label}: the recorded changes don't chain ${start} -> ... -> ${final}: ${JSON.stringify(list)}`);
  }
  for (const m of members) {
    const final = (await app.db.prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(o.wsId, m.id)).role;
    assertChain(`ws member ${m.email}`, steps('workspace_member_role_changed', (r) => r.details.includes(`target: ${m.email},`), /role: (\S+) -> (\S+)$/), 'workspace_viewer', final);
  }
  for (const m of orgMembers) {
    const final = (await app.db.prepare('SELECT role FROM organization_members WHERE organization_id = ? AND user_id = ?').get(o.orgId, m.id)).role;
    assertChain(`org member ${m.email}`, steps('org_member_role_changed', (r) => r.details.includes(`target: ${m.email},`), /role: (\S+) -> (\S+)$/), 'field_technician', final);
  }
  const finalScopes = `[${(await app.db.prepare('SELECT region_id FROM region_viewer_scopes WHERE organization_id = ? AND user_id = ?').all(o.orgId, rv.id)).map((r) => r.region_id).sort().join(', ')}]`;
  assertChain('scopes', steps('region_scopes_set', (r) => r.details.includes(`target: ${rv.email},`), /regions: (\[[^\]]*\]) -> (\[[^\]]*\])$/).filter((s) => s.from !== s.to), '[]', finalScopes);
  const finalCap = (await app.db.prepare('SELECT max_token_lifetime_days AS c FROM organizations WHERE id = ?').get(o.orgId)).c;
  assertChain('token lifetime', steps('org_token_lifetime_changed', (r) => r.organization_id === o.orgId, /max_token_lifetime_days: (\S+) -> (\S+)$/), 'none', finalCap == null ? 'none' : String(finalCap));
  const finalRegion = (await app.db.prepare('SELECT region_id FROM workspaces WHERE id = ?').get(o.wsId)).region_id;
  assertChain('workspace region', steps('workspace_region_changed', (r) => r.workspace_id === o.wsId, /region: (\S+) -> (\S+)$/), 'none', finalRegion || 'none');
  assert.equal(rows.filter((r) => r.action === 'mixed_fire_and_forget').length, 20);
  assert.equal(rows.filter((r) => r.action === 'admin_delete_org' && r.details.includes(o2.orgId)).length, 1);
});

// ---- chain integrity over everything written here ----
test('chain: verifyChain and GET /api/activity/verify-integrity pass over every row this file wrote', async () => {
  const platform = await mkUser('platform_admin');
  const end = await maxAuditId(app.db);
  assert.ok(end > since0 + 50, `rows written: ${end - since0}`);
  const report = await verifyChain(app.db, { startId: since0 + 1, endId: end });
  assert.equal(report.ok, true, JSON.stringify(report).slice(0, 2000));
  const r = await call('GET', `/api/activity/verify-integrity?start_id=${since0 + 1}&end_id=${end}`, platform.token);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.ok, true, r.text.slice(0, 2000));
});
