'use strict';

// Phase 1B batch 3: explicit, AWAITED audit rows for organization / workspace access
// changes (Entra role mappings, workspace member role / removal, invites, workspace ->
// region) and the locked "before" reads: token-lifetime, SSO-only, member role and region
// read their "before" value under FOR UPDATE in the UPDATE's transaction, and the
// last-owner / last-admin checks count with the member rows locked.
//
// Every explicit row is read IMMEDIATELY after the response (finding it proves the
// await); the generic activityLogger row for the same request must still appear (both
// are kept by decision), and every row since the test started is scanned for secrets
// (invite ids, session tokens).
//
// The REAL routers in-process (helpers/inprocess-app.js: /api/organizations and
// /api/workspaces, mounted after the activityLogger as in production) against the REAL
// MySQL test DB. services/email.sendEmail is replaced before the routers load, so no
// invite email is ever sent (and the graph_error rollback can be driven). Fixtures are
// test-owned (prefix oa-); audit rows stay (hash chain); the runner recreates beamos_test.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const config = require('../config');
const email = require('../services/email');
const { db } = require('../db/database');
const { generateToken } = require('../middleware/auth');
const { startInProcessApp } = require('./helpers/inprocess-app');
const { randTag, cleanupUsers } = require('./helpers/disposable');
const { maxAuditId, waitForAuditRows } = require('./helpers/wait-for-audit');

// Before any router is required: routes/workspaces.js destructures sendEmail at load.
let emailResult = { sent: false, reason: 'not_configured' };
const realSendEmail = email.sendEmail;
email.sendEmail = async () => emailResult;

const P = `oa-${randTag()}`;
let app;
const userIds = [];
const tokens = [];
const savedTenant = config.ssoTenantId;

test.before(async () => {
  app = await startInProcessApp({ only: ['/api/organizations', '/api/workspaces'] });
});

test.after(async () => {
  try {
    if (app) {
      config.ssoTenantId = savedTenant;
      email.sendEmail = realSendEmail;
      // Newest first: an org owner is deletable only once its other members are gone.
      await cleanupUsers(app.db, [...userIds].reverse());
    }
  } finally {
    if (app) await app.stop(); else await db.close();
  }
});

// ---- fixtures ----
async function mkUser(role = 'user') {
  const id = `${P}-${randTag()}`;
  const mail = `${id}@x.local`;
  await app.db.prepare("INSERT INTO users (id, email, name, password_hash, auth_provider, role) VALUES (?, ?, ?, 'x', 'local', ?)")
    .run(id, mail, id, role);
  userIds.push(id);
  const token = generateToken({ id, email: mail, role }, null);
  tokens.push(token);
  return { id, email: mail, role, token };
}
// An org owned by `owner` (an org_owner member unless ownerMember is false) with one workspace.
async function mkOrg(owner, { ownerMember = true } = {}) {
  const orgId = crypto.randomUUID();
  const wsId = crypto.randomUUID();
  await app.db.prepare("INSERT INTO organizations (id, name, owner_user_id, plan_id, subscription_status) VALUES (?, ?, ?, 'enterprise', 'active')")
    .run(orgId, `${P} Org ${randTag()}`, owner.id);
  if (ownerMember) await addOrgMember(orgId, owner, 'org_owner');
  const wsName = `${P} WS ${randTag()}`;
  await app.db.prepare('INSERT INTO workspaces (id, organization_id, name, created_by) VALUES (?, ?, ?, ?)').run(wsId, orgId, wsName, owner.id);
  const org = await app.db.prepare('SELECT id, name FROM organizations WHERE id = ?').get(orgId);
  return { orgId, orgName: org.name, wsId, wsName };
}
const addOrgMember = (orgId, u, role) => app.db.prepare('INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, ?)').run(orgId, u.id, role);
const addWsMember = (wsId, u, role) => app.db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)').run(wsId, u.id, role);
async function mkRegion(orgId, name) {
  const id = crypto.randomUUID();
  await app.db.prepare("INSERT INTO regions (id, organization_id, name, level, parent_id) VALUES (?, ?, ?, 'region', NULL)").run(id, orgId, `${P} ${name}`);
  return id;
}

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
async function oneRow(since, action) {
  const rows = (await rowsSince(since)).filter((r) => r.action === action);
  assert.equal(rows.length, 1, `exactly one ${action} row, read immediately after the response (got ${rows.length})`);
  return rows[0];
}
const noRow = async (since, action) => assert.deepEqual((await rowsSince(since)).filter((r) => r.action === action), [], `no ${action} row`);
// The generic activityLogger row for the same request (fire-and-forget, so waited for).
const genericRow = (since, userId, action) => waitForAuditRows(app.db, { sinceId: since, userId, actions: [action] });
async function assertNoSecrets(since, secrets) {
  const rows = await rowsSince(since);
  for (const s of [...tokens, ...secrets].filter(Boolean).map(String)) {
    for (const r of rows) assert.ok(!`${r.action} ${r.details ?? ''}`.includes(s), `audit row ${r.id} (${r.action}) must not contain a secret`);
  }
}

// Steps "a -> b" must chain from `start` to `final` with no gap (row ids follow the
// order the audit writes landed, not commit order, so chain by value).
function assertChain(steps, start, final) {
  let cur = start;
  const left = [...steps];
  while (left.length) {
    const i = left.findIndex((s) => s.from === cur);
    assert.notEqual(i, -1, `a change from "${cur}" is missing: ${JSON.stringify(steps)}`);
    cur = left.splice(i, 1)[0].to;
  }
  assert.equal(cur, final, `the recorded changes end at the final value (${JSON.stringify(steps)})`);
}

// ---- 12 + 13. Entra role mappings ----
test('entra_role_mapping_created / _deleted: org, claim, role, workspace; org + workspace ids set; generic rows kept', async () => {
  const owner = await mkUser();
  const o = await mkOrg(owner);
  const base = `/api/organizations/${o.orgId}/entra-role-mappings`;
  const claimOrg = `${P}.OrgAdmin`;
  const claimWs = `${P}.WsEditor`;

  let since = await maxAuditId(app.db);
  const c1 = await call('POST', base, owner.token, { claim_value: claimOrg, role: 'org_admin' });
  assert.equal(c1.status, 201, c1.text);
  let row = await oneRow(since, 'entra_role_mapping_created');
  assert.equal(row.user_id, owner.id);
  assert.equal(row.details, `org: ${o.orgName} (${o.orgId}), claim: ${claimOrg}, role: org_admin, workspace: org-level`);
  assert.equal(row.organization_id, o.orgId);
  assert.equal(row.workspace_id, null);
  await genericRow(since, owner.id, 'POST /api/organizations/:orgId/entra-role-mappings');

  since = await maxAuditId(app.db);
  const c2 = await call('POST', base, owner.token, { claim_value: claimWs, role: 'workspace_editor', workspace_id: o.wsId });
  assert.equal(c2.status, 201, c2.text);
  row = await oneRow(since, 'entra_role_mapping_created');
  assert.equal(row.details, `org: ${o.orgName} (${o.orgId}), claim: ${claimWs}, role: workspace_editor, workspace: ${o.wsId}`);
  assert.equal(row.workspace_id, o.wsId);

  since = await maxAuditId(app.db);
  const d = await call('DELETE', `${base}/${c2.json.id}`, owner.token);
  assert.equal(d.status, 200, d.text);
  row = await oneRow(since, 'entra_role_mapping_deleted');
  assert.equal(row.user_id, owner.id);
  assert.equal(row.details, `org: ${o.orgName} (${o.orgId}), claim: ${claimWs}, role: workspace_editor, workspace: ${o.wsId}`);
  assert.equal(row.organization_id, o.orgId);
  await genericRow(since, owner.id, 'DELETE /api/organizations/:orgId/entra-role-mappings/:id');
  await assertNoSecrets(since, []);
});

// ---- 14 + 15. workspace members ----
test('workspace_member_role_changed (before -> after, none when unchanged) and workspace_member_removed', async () => {
  const owner = await mkUser();
  const o = await mkOrg(owner);
  const member = await mkUser();
  await addWsMember(o.wsId, member, 'workspace_viewer');
  const url = `/api/workspaces/${o.wsId}/members/${member.id}`;

  let since = await maxAuditId(app.db);
  assert.equal((await call('PUT', url, owner.token, { role: 'workspace_editor' })).status, 200);
  let row = await oneRow(since, 'workspace_member_role_changed');
  assert.equal(row.user_id, owner.id);
  assert.equal(row.details, `workspace: ${o.wsName} (${o.wsId}), target: ${member.email}, role: workspace_viewer -> workspace_editor`);
  assert.equal(row.workspace_id, o.wsId);
  assert.equal(row.organization_id, o.orgId);
  await genericRow(since, owner.id, 'PUT /api/workspaces/:id/members/:userId');

  since = await maxAuditId(app.db);
  assert.equal((await call('PUT', url, owner.token, { role: 'workspace_editor' })).status, 200);
  await noRow(since, 'workspace_member_role_changed');

  since = await maxAuditId(app.db);
  assert.equal((await call('DELETE', url, owner.token)).status, 200);
  row = await oneRow(since, 'workspace_member_removed');
  assert.equal(row.details, `workspace: ${o.wsName} (${o.wsId}), target: ${member.email}, role: workspace_editor`);
  assert.equal(row.workspace_id, o.wsId);
  assert.equal(row.organization_id, o.orgId);
  await genericRow(since, owner.id, 'DELETE /api/workspaces/:id/members/:userId');
});

// ---- 16 + 17. invites ----
test('workspace_invite_created / _cancelled: email, role, expiry - never the invite id; a failed send is recorded as withdrawn', async () => {
  const owner = await mkUser();
  const o = await mkOrg(owner);
  const invitee = `${P}-inv-${randTag()}@x.local`;

  const start = await maxAuditId(app.db);
  let since = start;
  emailResult = { sent: false, reason: 'not_configured' };
  const c = await call('POST', `/api/workspaces/${o.wsId}/invites`, owner.token, { email: invitee, role: 'workspace_viewer' });
  assert.equal(c.status, 201, c.text);
  let row = await oneRow(since, 'workspace_invite_created');
  assert.equal(row.user_id, owner.id);
  assert.equal(row.details, `workspace: ${o.wsName} (${o.wsId}), email: ${invitee}, role: workspace_viewer, expires_at: ${c.json.expires_at}`);
  assert.equal(row.workspace_id, o.wsId);
  assert.equal(row.organization_id, o.orgId);
  await genericRow(since, owner.id, 'POST /api/workspaces/:id/invites');

  since = await maxAuditId(app.db);
  const d = await call('DELETE', `/api/workspaces/${o.wsId}/invites/${c.json.id}`, owner.token);
  assert.equal(d.status, 200, d.text);
  row = await oneRow(since, 'workspace_invite_cancelled');
  assert.equal(row.details, `workspace: ${o.wsName} (${o.wsId}), email: ${invitee}, role: workspace_viewer`);
  await genericRow(since, owner.id, 'DELETE /api/workspaces/:id/invites/:inviteId');
  await assertNoSecrets(start, [c.json.id]);

  // Graph rejected the send: the invite is deleted again (502). Phase 1C writes the created
  // row in the invite's own transaction, before the send, so the withdrawal is recorded
  // too (workspace_invite_send_failed, same details) and no invite row is left.
  since = await maxAuditId(app.db);
  emailResult = { sent: false, reason: 'graph_error' };
  const failEmail = `${P}-fail-${randTag()}@x.local`;
  const f = await call('POST', `/api/workspaces/${o.wsId}/invites`, owner.token, { email: failEmail, role: 'workspace_viewer' });
  assert.equal(f.status, 502, f.text);
  const created = await oneRow(since, 'workspace_invite_created');
  const failed = await oneRow(since, 'workspace_invite_send_failed');
  assert.equal(failed.details, created.details);
  assert.match(failed.details, new RegExp(`email: ${failEmail.replace(/[.]/g, '[.]')}, role: workspace_viewer`));
  assert.ok(failed.id > created.id);
  assert.equal((await app.db.prepare('SELECT COUNT(*) AS n FROM workspace_invites WHERE email = ?').get(failEmail)).n, 0);
  emailResult = { sent: false, reason: 'not_configured' };
});

// ---- 18. workspace -> region ----
test('workspace_region_changed: before -> after (none when unassigned); same region writes no row', async () => {
  const owner = await mkUser();
  const o = await mkOrg(owner);
  const r1 = await mkRegion(o.orgId, 'North');
  const r2 = await mkRegion(o.orgId, 'South');
  const url = `/api/workspaces/${o.wsId}/region`;

  let since = await maxAuditId(app.db);
  assert.equal((await call('PATCH', url, owner.token, { region_id: r1 })).status, 200);
  let row = await oneRow(since, 'workspace_region_changed');
  assert.equal(row.user_id, owner.id);
  assert.equal(row.details, `workspace: ${o.wsName} (${o.wsId}), region: none -> ${r1}`);
  assert.equal(row.workspace_id, o.wsId);
  assert.equal(row.organization_id, o.orgId);
  await genericRow(since, owner.id, 'PATCH /api/workspaces/:id/region');

  since = await maxAuditId(app.db);
  assert.equal((await call('PATCH', url, owner.token, { region_id: r1 })).status, 200);
  await noRow(since, 'workspace_region_changed');

  since = await maxAuditId(app.db);
  assert.equal((await call('PATCH', url, owner.token, { region_id: r2 })).status, 200);
  assert.equal((await oneRow(since, 'workspace_region_changed')).details, `workspace: ${o.wsName} (${o.wsId}), region: ${r1} -> ${r2}`);

  since = await maxAuditId(app.db);
  assert.equal((await call('PATCH', url, owner.token, { region_id: null })).status, 200);
  assert.equal((await oneRow(since, 'workspace_region_changed')).details, `workspace: ${o.wsName} (${o.wsId}), region: ${r2} -> none`);
});

// ---- token lifetime / SSO-only (locked "before") ----
test('org_token_lifetime_changed / org_sso_only_changed: organization_id set; same value writes no row', async () => {
  const admin = await mkUser('platform_admin');
  const o = await mkOrg(admin);
  const tp = `/api/organizations/${o.orgId}/token-policy`;
  let since = await maxAuditId(app.db);
  assert.equal((await call('PATCH', tp, admin.token, { max_token_lifetime_days: 30 })).status, 200);
  let row = await oneRow(since, 'org_token_lifetime_changed');
  assert.equal(row.details, `org: ${o.orgName} (${o.orgId}), max_token_lifetime_days: none -> 30`);
  assert.equal(row.organization_id, o.orgId);
  since = await maxAuditId(app.db);
  assert.equal((await call('PATCH', tp, admin.token, { max_token_lifetime_days: 30 })).status, 200);
  await noRow(since, 'org_token_lifetime_changed');

  config.ssoTenantId = 'aaaaaaaa-0000-0000-0000-000000000000'; // enabling SSO-only needs a tenant
  const ap = `/api/organizations/${o.orgId}/auth-policy`;
  since = await maxAuditId(app.db);
  assert.equal((await call('PATCH', ap, admin.token, { sso_only: true })).status, 200);
  row = await oneRow(since, 'org_sso_only_changed');
  assert.equal(row.details, `org: ${o.orgName} (${o.orgId}), sso_only: false -> true`);
  assert.equal(row.organization_id, o.orgId);
  since = await maxAuditId(app.db);
  assert.equal((await call('PATCH', ap, admin.token, { sso_only: true })).status, 200);
  await noRow(since, 'org_sso_only_changed');
  assert.equal((await call('PATCH', ap, admin.token, { sso_only: false })).status, 200);
  config.ssoTenantId = savedTenant;
});

test('concurrent token-lifetime changes chain from the locked "before" values (no lost change)', async () => {
  const admin = await mkUser('platform_admin');
  const o = await mkOrg(admin);
  const tp = `/api/organizations/${o.orgId}/token-policy`;
  const since = await maxAuditId(app.db);
  const wanted = [30, 60, null, 90, 30, null, 60, 120];
  for (const r of await Promise.all(wanted.map((v) => call('PATCH', tp, admin.token, { max_token_lifetime_days: v })))) {
    assert.equal(r.status, 200, r.text);
  }
  const final = (await app.db.prepare('SELECT max_token_lifetime_days AS v FROM organizations WHERE id = ?').get(o.orgId)).v;
  const steps = (await rowsSince(since)).filter((x) => x.action === 'org_token_lifetime_changed').map((x) => {
    const m = x.details.match(/max_token_lifetime_days: (\S+) -> (\S+)$/);
    assert.ok(m, x.details);
    assert.notEqual(m[1], m[2]);
    return { from: m[1], to: m[2] };
  });
  assertChain(steps, 'none', final == null ? 'none' : String(final));
});

test('concurrent workspace member-role changes chain from the locked "before" values (no lost change)', async () => {
  const owner = await mkUser();
  const o = await mkOrg(owner);
  const member = await mkUser();
  await addWsMember(o.wsId, member, 'workspace_viewer');
  const url = `/api/workspaces/${o.wsId}/members/${member.id}`;
  const since = await maxAuditId(app.db);
  const wanted = ['workspace_editor', 'workspace_viewer', 'workspace_admin', 'workspace_editor', 'workspace_viewer', 'workspace_admin', 'workspace_editor'];
  // Two of these may meet a lone workspace_admin being demoted - an allowed 409 is not a change.
  const results = await Promise.all(wanted.map((role) => call('PUT', url, owner.token, { role })));
  for (const r of results) assert.ok([200, 409].includes(r.status), r.text);
  const final = (await app.db.prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(o.wsId, member.id)).role;
  const steps = (await rowsSince(since)).filter((x) => x.action === 'workspace_member_role_changed').map((x) => {
    const m = x.details.match(/role: (\S+) -> (\S+)$/);
    assert.ok(m, x.details);
    assert.notEqual(m[1], m[2]);
    return { from: m[1], to: m[2] };
  });
  assertChain(steps, 'workspace_viewer', final);
});

// ---- last-owner / last-admin races ----
test('last workspace admin: two concurrent demotions (and two concurrent removals) - exactly one succeeds, one admin remains', async () => {
  const owner = await mkUser();
  const o = await mkOrg(owner);
  for (const op of ['demote', 'remove']) {
    const a = await mkUser();
    const b = await mkUser();
    await app.db.prepare("DELETE FROM workspace_members WHERE workspace_id = ? AND role = 'workspace_admin'").run(o.wsId);
    await addWsMember(o.wsId, a, 'workspace_admin');
    await addWsMember(o.wsId, b, 'workspace_admin');
    const req = (u) => (op === 'demote'
      ? call('PUT', `/api/workspaces/${o.wsId}/members/${u.id}`, owner.token, { role: 'workspace_viewer' })
      : call('DELETE', `/api/workspaces/${o.wsId}/members/${u.id}`, owner.token));
    const statuses = (await Promise.all([req(a), req(b)])).map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, 409], `${op}: exactly one of the two succeeds (got ${statuses})`);
    const admins = await app.db.prepare("SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id = ? AND role = 'workspace_admin'").get(o.wsId);
    assert.equal(Number(admins.n), 1, `${op}: one workspace admin remains`);
  }
});

test('last org owner: two concurrent removals of the only two owner members - exactly one succeeds, one owner remains', async () => {
  const platform = await mkUser('platform_admin');
  const primary = await mkUser();
  const o = await mkOrg(primary, { ownerMember: false }); // the primary owner holds no member row here
  const b = await mkUser();
  const c = await mkUser();
  await addOrgMember(o.orgId, b, 'org_owner');
  await addOrgMember(o.orgId, c, 'org_owner');
  const results = await Promise.all([b, c].map((u) => call('DELETE', `/api/organizations/${o.orgId}/members/${u.id}`, platform.token)));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409], results.map((r) => r.text).join(' | '));
  const owners = await app.db.prepare("SELECT COUNT(*) AS n FROM organization_members WHERE organization_id = ? AND role = 'org_owner'").get(o.orgId);
  assert.equal(Number(owners.n), 1, 'one org owner remains');

  // ... and two concurrent demotions of the remaining owner + a re-added one.
  const d = await mkUser();
  await addOrgMember(o.orgId, d, 'org_owner');
  const remaining = await app.db.prepare("SELECT user_id FROM organization_members WHERE organization_id = ? AND role = 'org_owner'").all(o.orgId);
  const demotes = await Promise.all(remaining.map((r) => call('PUT', `/api/organizations/${o.orgId}/members/${r.user_id}`, platform.token, { role: 'org_admin' })));
  assert.deepEqual(demotes.map((r) => r.status).sort(), [200, 409], demotes.map((r) => r.text).join(' | '));
  const left = await app.db.prepare("SELECT COUNT(*) AS n FROM organization_members WHERE organization_id = ? AND role = 'org_owner'").get(o.orgId);
  assert.equal(Number(left.n), 1, 'one org owner remains after concurrent demotions');
});
