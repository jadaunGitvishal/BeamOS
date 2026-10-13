'use strict';

// Phase 1B batch 2: explicit, AWAITED audit rows for the sign-in / account routes in
// routes/auth.js. That router is mounted BEFORE the generic activityLogger (server.js,
// mirrored by helpers/inprocess-app.js), so these rows are the only record.
//
// Every check reads the row IMMEDIATELY after the response - no polling - so finding it
// proves the route awaited the write. Every test also scans every audit row written
// since it started for the secrets it submitted (passwords, TOTP secret / otpauth URI /
// codes / recovery codes, invite id, full phone number).
//
// The REAL router in-process against the REAL MySQL test DB (beamos_test via npm test).
// The only things faked are the two identity providers: Google's verifyIdToken
// (OAuth2Client.prototype) and Microsoft Graph's /v1.0/me (https.get to
// graph.microsoft.com), same technique as microsoft-sso.test.js. Users (and the orgs /
// workspaces they own) are test-owned and removed afterwards; audit rows stay (hash
// chain), and the runner recreates beamos_test on every run.

const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const crypto = require('node:crypto');
const { PassThrough } = require('node:stream');
const bcrypt = require('bcryptjs');
const { authenticator } = require('otplib');
const { OAuth2Client } = require('google-auth-library');
const config = require('../config');
const { db } = require('../db/database');
const { generateToken } = require('../middleware/auth');
const { startInProcessApp } = require('./helpers/inprocess-app');
const { randTag, cleanupUsers } = require('./helpers/disposable');
const { maxAuditId } = require('./helpers/wait-for-audit');
const { maskPhone } = require('../lib/mask');

const P = `aa-${randTag()}`; // lower-case: routes lower-case emails
const PW = 'Old-passw0rd-aa';
let app;
const userIds = [];
const saved = {
  disableRegistration: config.disableRegistration,
  autoCreateOrgOnSignup: config.autoCreateOrgOnSignup,
  ssoTenantId: config.ssoTenantId,
};

// ---- identity-provider stubs (only the provider calls; everything else is real) ----
let googlePayload = null;
const realVerifyIdToken = OAuth2Client.prototype.verifyIdToken;
OAuth2Client.prototype.verifyIdToken = async function () {
  if (!googlePayload) throw new Error('no stubbed Google payload');
  const p = googlePayload;
  return { getPayload: () => p };
};
let graphProfile = null;
const realHttpsGet = https.get;
https.get = function (options, cb) {
  if (options && options.hostname === 'graph.microsoft.com') {
    const resp = new PassThrough();
    process.nextTick(() => { cb(resp); resp.end(JSON.stringify(graphProfile)); });
    return { on() { return this; } };
  }
  return realHttpsGet.apply(this, arguments);
};

test.before(async () => {
  app = await startInProcessApp({ only: [] }); // /api/auth only (+ the generic logger after it)
  config.disableRegistration = false;
  config.ssoTenantId = ''; // Microsoft: the Graph /me path
});

test.after(async () => {
  try {
    if (app) {
      Object.assign(config, saved);
      OAuth2Client.prototype.verifyIdToken = realVerifyIdToken;
      https.get = realHttpsGet;
      // Newest first: an org owner can only be deleted once the users who joined its
      // workspace (invite test) are gone (deleteUserCascade refuses a shared org).
      const sso = await app.db.prepare('SELECT id FROM users WHERE email LIKE ?').all(`${P}%`);
      await cleanupUsers(app.db, [...new Set([...userIds, ...sso.map((r) => r.id)])].reverse());
    }
  } finally {
    if (app) await app.stop(); else await db.close();
  }
});

// ---- helpers ----
async function mkUser({ role = 'user', password = PW, provider = 'local', mustChange = 0 } = {}) {
  const id = `${P}-${randTag()}`;
  const email = `${id}@x.local`;
  await app.db.prepare(
    `INSERT INTO users (id, email, name, password_hash, auth_provider, role, plan_id, must_change_password)
     VALUES (?, ?, ?, ?, ?, ?, 'enterprise', ?)`,
  ).run(id, email, id, password ? bcrypt.hashSync(password, 4) : null, provider, role, mustChange);
  userIds.push(id);
  return { id, email, role, token: generateToken({ id, email, role }, null) };
}

async function call(method, path, token, body) {
  const r = await fetch(`${app.base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
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

// Exactly one `action` row since `since`, read right now (no wait).
async function oneRow(since, action) {
  const rows = (await rowsSince(since)).filter((r) => r.action === action);
  assert.equal(rows.length, 1, `exactly one ${action} row, read immediately after the response (got ${rows.length})`);
  return rows[0];
}

// No audit row since `since` (any action) contains any of the secrets.
async function assertNoSecrets(since, secrets) {
  const rows = await rowsSince(since);
  for (const s of secrets.filter(Boolean).map(String)) {
    for (const r of rows) {
      assert.ok(!`${r.action} ${r.details ?? ''}`.includes(s), `audit row ${r.id} (${r.action}) must not contain a secret`);
    }
  }
}

// A TOTP code for the NEXT 30s step: accepted (±1 window) and always newer than the step
// the previous call consumed, so back-to-back calls aren't refused as replays.
const nextStepCode = (secret) => authenticator.clone({ epoch: Date.now() + 30000 }).generate(secret);

// ---- 1. platform role ----
test('platform_role_changed: before -> after from a locked read; unchanged role writes no row', async () => {
  const admin = await mkUser({ role: 'platform_admin' });
  const target = await mkUser();
  let since = await maxAuditId(app.db);
  const r = await call('PUT', `/api/auth/users/${target.id}/role`, admin.token, { role: 'platform_operator' });
  assert.equal(r.status, 200, r.text);
  const row = await oneRow(since, 'platform_role_changed');
  assert.equal(row.user_id, admin.id);
  assert.equal(row.details, `target: ${target.email}, role: user -> platform_operator`);

  since = await maxAuditId(app.db);
  assert.equal((await call('PUT', `/api/auth/users/${target.id}/role`, admin.token, { role: 'platform_operator' })).status, 200);
  assert.deepEqual((await rowsSince(since)).filter((x) => x.action === 'platform_role_changed'), [], 'same role -> no row');
});

test('platform_role_changed: concurrent changes are recorded as the sequence that actually applied (no lost change)', async () => {
  const admin = await mkUser({ role: 'platform_admin' });
  const target = await mkUser();
  const since = await maxAuditId(app.db);
  const wanted = ['platform_operator', 'user', 'platform_admin', 'user', 'platform_operator', 'platform_admin', 'user', 'platform_operator'];
  const results = await Promise.all(wanted.map((role) => call('PUT', `/api/auth/users/${target.id}/role`, admin.token, { role })));
  for (const r of results) assert.equal(r.status, 200, r.text);
  const finalRole = (await app.db.prepare('SELECT role FROM users WHERE id = ?').get(target.id)).role;

  const rows = (await rowsSince(since)).filter((x) => x.action === 'platform_role_changed');
  const steps = rows.map((x) => {
    const m = x.details.match(/^target: (\S+), role: (\S+) -> (\S+)$/);
    assert.ok(m && m[1] === target.email, x.details);
    assert.notEqual(m[2], m[3], 'every row is a real change');
    return { from: m[2], to: m[3] };
  });
  // The rows must chain from the starting role to the final one with no gap: each
  // change's "before" is the previous change's "after". (Row ids follow the order the
  // audit writes landed, which can differ from commit order - so chain by value.)
  let cur = 'user';
  const left = [...steps];
  while (left.length) {
    const i = left.findIndex((s) => s.from === cur);
    assert.notEqual(i, -1, `a change from "${cur}" is missing: ${JSON.stringify(steps)}`);
    cur = left.splice(i, 1)[0].to;
  }
  assert.equal(cur, finalRole, `the recorded changes end at the final role (${JSON.stringify(steps)})`);
});

// ---- 2. registration ----
test('user_registered: email, role, org_created (with the org when one was made)', async () => {
  let since = await maxAuditId(app.db);
  const email = `${P}-reg-org@x.local`;
  const r = await call('POST', '/api/auth/register', null, { email, password: PW, name: 'Reg Org', createOrg: true });
  assert.equal(r.status, 201, r.text);
  userIds.push(r.json.user.id);
  const org = await app.db.prepare('SELECT id, name FROM organizations WHERE owner_user_id = ?').get(r.json.user.id);
  assert.ok(org, 'the org was created');
  const row = await oneRow(since, 'user_registered');
  assert.equal(row.user_id, r.json.user.id, 'actor = the new user');
  assert.equal(row.details, `email: ${email}, role: user, org_created: true, org: ${org.name} (${org.id})`);
  assert.equal(row.organization_id, org.id);
  assert.equal(row.workspace_id, r.json.current_workspace_id);
  await assertNoSecrets(since, [PW]);

  since = await maxAuditId(app.db);
  const email2 = `${P}-reg-noorg@x.local`;
  const r2 = await call('POST', '/api/auth/register', null, { email: email2, password: PW, createOrg: false });
  assert.equal(r2.status, 201, r2.text);
  userIds.push(r2.json.user.id);
  const row2 = await oneRow(since, 'user_registered');
  assert.equal(row2.details, `email: ${email2}, role: user, org_created: false`);
  assert.equal(row2.organization_id, null);
  await assertNoSecrets(since, [PW]);
});

// ---- 3 + 4. SSO account creation / linking ----
test('user_created_sso + account_linked_google (Google)', async () => {
  let since = await maxAuditId(app.db);
  const email = `${P}-g-new@x.local`;
  googlePayload = { email, name: 'G New', picture: '', sub: `g-${randTag()}` };
  const r = await call('POST', '/api/auth/google', null, { credential: 'stubbed' });
  assert.equal(r.status, 200, r.text);
  const row = await oneRow(since, 'user_created_sso');
  assert.equal(row.user_id, r.json.user.id);
  assert.equal(row.details, `email: ${email}, provider: google, role: user`);
  await assertNoSecrets(since, ['stubbed']);

  // An existing password-less account on another provider is linked to Google.
  const other = await mkUser({ password: null, provider: 'microsoft' });
  since = await maxAuditId(app.db);
  googlePayload = { email: other.email, name: 'G Link', picture: '', sub: `g-${randTag()}` };
  const r2 = await call('POST', '/api/auth/google', null, { credential: 'stubbed' });
  assert.equal(r2.status, 200, r2.text);
  const link = await oneRow(since, 'account_linked_google');
  assert.equal(link.user_id, other.id);
  assert.equal(link.details, other.email);
});

test('user_created_sso + account_linked_microsoft (Microsoft, no-password link)', async () => {
  let since = await maxAuditId(app.db);
  const email = `${P}-m-new@x.local`;
  graphProfile = { id: `m-${randTag()}`, mail: email, displayName: 'M New' };
  const r = await call('POST', '/api/auth/microsoft', null, { access_token: 'stubbed-ms' });
  assert.equal(r.status, 200, r.text);
  const row = await oneRow(since, 'user_created_sso');
  assert.equal(row.user_id, r.json.user.id);
  assert.equal(row.details, `email: ${email}, provider: microsoft, role: user`);
  await assertNoSecrets(since, ['stubbed-ms']);

  const other = await mkUser({ password: null, provider: 'google' });
  since = await maxAuditId(app.db);
  graphProfile = { id: `m-${randTag()}`, mail: other.email, displayName: 'M Link' };
  const r2 = await call('POST', '/api/auth/microsoft', null, { access_token: 'stubbed-ms' });
  assert.equal(r2.status, 200, r2.text);
  const link = await oneRow(since, 'account_linked_microsoft');
  assert.equal(link.user_id, other.id);
  assert.equal(link.details, other.email);
});

// ---- 5. invite acceptance ----
async function mkWorkspace(owner) {
  const orgId = crypto.randomUUID();
  const wsId = crypto.randomUUID();
  await app.db.prepare("INSERT INTO organizations (id, name, owner_user_id, plan_id, subscription_status) VALUES (?, ?, ?, 'enterprise', 'active')")
    .run(orgId, `${P} Org`, owner.id);
  await app.db.prepare('INSERT INTO workspaces (id, organization_id, name, created_by) VALUES (?, ?, ?, ?)').run(wsId, orgId, `${P} WS`, owner.id);
  return { orgId, wsId, wsName: `${P} WS` };
}
async function mkInvite(ws, email, role, by) {
  const id = crypto.randomUUID();
  await app.db.prepare('INSERT INTO workspace_invites (id, workspace_id, email, role, invited_by, expires_at) VALUES (?, ?, ?, ?, ?, UNIX_TIMESTAMP() + 3600)')
    .run(id, ws.wsId, email, role, by.id);
  return id;
}

test('workspace_invite_accepted: workspace + role (or already_member), workspace/org ids set, never the invite id', async () => {
  const owner = await mkUser();
  const ws = await mkWorkspace(owner);
  const invitee = await mkUser();
  const inviteId = await mkInvite(ws, invitee.email, 'workspace_editor', owner);
  let since = await maxAuditId(app.db);
  const r = await call('POST', `/api/auth/accept-invite/${inviteId}`, invitee.token);
  assert.equal(r.status, 200, r.text);
  const row = await oneRow(since, 'workspace_invite_accepted');
  assert.equal(row.user_id, invitee.id);
  assert.equal(row.details, `workspace: ${ws.wsName} (${ws.wsId}), role: workspace_editor`);
  assert.equal(row.workspace_id, ws.wsId);
  assert.equal(row.organization_id, ws.orgId);
  await assertNoSecrets(since, [inviteId]);

  // Already a member: role kept, invite consumed.
  const member = await mkUser();
  await app.db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_viewer')").run(ws.wsId, member.id);
  const invite2 = await mkInvite(ws, member.email, 'workspace_admin', owner);
  since = await maxAuditId(app.db);
  const r2 = await call('POST', `/api/auth/accept-invite/${invite2}`, member.token);
  assert.equal(r2.status, 200, r2.text);
  const row2 = await oneRow(since, 'workspace_invite_accepted');
  assert.equal(row2.details, `workspace: ${ws.wsName} (${ws.wsId}), already_member, role kept: workspace_viewer`);
  await assertNoSecrets(since, [invite2]);
});

// ---- 7-9. TOTP ----
test('totp_enabled / totp_recovery_codes_regenerated / totp_disabled (via a TOTP code and via a recovery code), no secrets', async () => {
  const u = await mkUser();
  const since = await maxAuditId(app.db);
  const secrets = [];

  const s1 = await call('POST', '/api/auth/totp/setup', u.token);
  assert.equal(s1.status, 200, s1.text);
  secrets.push(s1.json.secret, s1.json.otpauth_uri);
  const enableCode = authenticator.generate(s1.json.secret);
  const e1 = await call('POST', '/api/auth/totp/enable', u.token, { code: enableCode });
  assert.equal(e1.status, 200, e1.text);
  secrets.push(enableCode, ...e1.json.recovery_codes);
  let row = await oneRow(since, 'totp_enabled');
  assert.equal(row.user_id, u.id);
  assert.equal(row.details, `recovery_codes: ${e1.json.recovery_codes.length}`);

  const disableCode = nextStepCode(s1.json.secret);
  secrets.push(disableCode);
  const d1 = await call('POST', '/api/auth/totp/disable', u.token, { code: disableCode });
  assert.equal(d1.status, 200, d1.text);
  row = await oneRow(since, 'totp_disabled');
  assert.equal(row.details, 'via: totp_code');

  // Re-enrol, regenerate the recovery codes, then disable with a recovery code.
  const mark = await maxAuditId(app.db);
  const s2 = await call('POST', '/api/auth/totp/setup', u.token);
  secrets.push(s2.json.secret, s2.json.otpauth_uri);
  const code2 = authenticator.generate(s2.json.secret);
  const e2 = await call('POST', '/api/auth/totp/enable', u.token, { code: code2 });
  assert.equal(e2.status, 200, e2.text);
  secrets.push(code2, ...e2.json.recovery_codes);
  const regenCode = nextStepCode(s2.json.secret);
  secrets.push(regenCode);
  const g = await call('POST', '/api/auth/totp/recovery-codes/regenerate', u.token, { code: regenCode });
  assert.equal(g.status, 200, g.text);
  secrets.push(...g.json.recovery_codes);
  row = await oneRow(mark, 'totp_recovery_codes_regenerated');
  assert.equal(row.details, `count: ${g.json.recovery_codes.length}`);

  const d2 = await call('POST', '/api/auth/totp/disable', u.token, { code: g.json.recovery_codes[0] });
  assert.equal(d2.status, 200, d2.text);
  row = await oneRow(mark, 'totp_disabled');
  assert.equal(row.details, 'via: recovery_code');

  await assertNoSecrets(since, secrets);
});

// ---- 10. own password ----
test('password_changed: self, must_change_password cleared true/false; never the password or hash', async () => {
  const u = await mkUser({ mustChange: 1 });
  const NEW1 = `New-pass-1-${randTag()}`;
  const NEW2 = `New-pass-2-${randTag()}`;
  let since = await maxAuditId(app.db);
  const r = await call('PUT', '/api/auth/me', u.token, { password: NEW1, current_password: PW });
  assert.equal(r.status, 200, r.text);
  let row = await oneRow(since, 'password_changed');
  assert.equal(row.user_id, u.id);
  assert.equal(row.details, 'self, must_change_password cleared: true');
  const hash = (await app.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(u.id)).password_hash;
  await assertNoSecrets(since, [PW, NEW1, hash]);

  since = await maxAuditId(app.db);
  assert.equal((await call('PUT', '/api/auth/me', u.token, { password: NEW2, current_password: NEW1 })).status, 200);
  row = await oneRow(since, 'password_changed');
  assert.equal(row.details, 'self, must_change_password cleared: false');
  await assertNoSecrets(since, [NEW1, NEW2]);
});

// ---- 11. own phone ----
const randPhone = () => `+9198${String(crypto.randomInt(0, 1e8)).padStart(8, '0')}`;

test('phone_changed: masked before -> after (set, change, clear); same phone writes no row; never the full number', async () => {
  const u = await mkUser();
  const a = randPhone();
  const b = randPhone();
  const start = await maxAuditId(app.db);

  let since = await maxAuditId(app.db);
  assert.equal((await call('PUT', '/api/auth/me', u.token, { phone: a })).status, 200);
  let row = await oneRow(since, 'phone_changed');
  assert.equal(row.user_id, u.id);
  assert.equal(row.details, `phone: none -> ${maskPhone(a)}`);

  since = await maxAuditId(app.db);
  assert.equal((await call('PUT', '/api/auth/me', u.token, { phone: a })).status, 200);
  assert.deepEqual((await rowsSince(since)).filter((x) => x.action === 'phone_changed'), [], 'same phone -> no row');

  since = await maxAuditId(app.db);
  assert.equal((await call('PUT', '/api/auth/me', u.token, { phone: b })).status, 200);
  row = await oneRow(since, 'phone_changed');
  assert.equal(row.details, `phone: ${maskPhone(a)} -> ${maskPhone(b)}`);

  since = await maxAuditId(app.db);
  assert.equal((await call('PUT', '/api/auth/me', u.token, { phone: '' })).status, 200);
  row = await oneRow(since, 'phone_changed');
  assert.equal(row.details, `phone: ${maskPhone(b)} -> none`);

  await assertNoSecrets(start, [a, b, a.replace(/\D/g, ''), b.replace(/\D/g, '')]);
});

test('phone_changed: concurrent changes chain from the locked "before" values (no lost change)', async () => {
  const u = await mkUser();
  const phones = [randPhone(), randPhone(), randPhone(), randPhone()];
  const since = await maxAuditId(app.db);
  const wanted = [phones[0], phones[1], '', phones[2], phones[3], '', phones[0]];
  const results = await Promise.all(wanted.map((phone) => call('PUT', '/api/auth/me', u.token, { phone })));
  for (const r of results) assert.equal(r.status, 200, r.text);
  const final = (await app.db.prepare('SELECT phone FROM users WHERE id = ?').get(u.id)).phone;
  const steps = (await rowsSince(since)).filter((x) => x.action === 'phone_changed').map((x) => {
    const m = x.details.match(/^phone: (\S+) -> (\S+)$/);
    assert.ok(m, x.details);
    assert.notEqual(m[1], m[2]);
    return { from: m[1], to: m[2] };
  });
  let cur = 'none';
  const left = [...steps];
  while (left.length) {
    const i = left.findIndex((s) => s.from === cur);
    assert.notEqual(i, -1, `a change from "${cur}" is missing: ${JSON.stringify(steps)}`);
    cur = left.splice(i, 1)[0].to;
  }
  assert.equal(cur, maskPhone(final), 'the recorded changes end at the final phone');
});

// ---- existing rows switched to awaited ----
test('password_reset_for_user and delete_user are written before the response (awaited)', async () => {
  const admin = await mkUser({ role: 'platform_admin' });
  const target = await mkUser();
  const NEWPW = `Reset-pass-${randTag()}`;
  let since = await maxAuditId(app.db);
  const r = await call('PUT', `/api/auth/users/${target.id}/password`, admin.token, { password: NEWPW });
  assert.equal(r.status, 200, r.text);
  let row = await oneRow(since, 'password_reset_for_user');
  assert.equal(row.user_id, admin.id);
  assert.equal(row.details, `target: ${target.email}`);
  await assertNoSecrets(since, [NEWPW]);

  since = await maxAuditId(app.db);
  const d = await call('DELETE', `/api/auth/users/${target.id}`, admin.token);
  assert.equal(d.status, 200, d.text);
  row = await oneRow(since, 'delete_user');
  assert.equal(row.user_id, admin.id);
  assert.equal(row.details, `target: ${target.email}`);
});
