'use strict';

// Ref 5: per-organization SSO-only mode (organizations.sso_only), end to end over
// real HTTP: the REAL routes/auth.js + routes/organizations.js mounted in-process
// (helpers/inprocess-app.js) against the REAL MySQL database after the real
// initDb(). Same harness as test/microsoft-sso.test.js - the only things faked
// are outbound identity calls: Entra's JWKS URL (globalThis.fetch, that one URL),
// Graph /v1.0/me (https.get to graph.microsoft.com only) and Google's
// OAuth2Client.verifyIdToken (returns a chosen payload).
//
// Covers: enforcement on /login and /google, account linking on /microsoft,
// the platform-admin exemption, audit rows, and GET/PATCH /auth-policy.

const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const crypto = require('node:crypto');
const { PassThrough } = require('node:stream');
const jose = require('jose');
const { OAuth2Client } = require('google-auth-library');
const { authenticator } = require('otplib');

const config = require('../config');
const { db, initDb } = require('../db/database');
const { ACCOUNT_DEACTIVATED_MESSAGE } = require('../middleware/auth');
const { startInProcessApp } = require('./helpers/inprocess-app');
const { randTag, cleanupUsers } = require('./helpers/disposable');

const TENANT_ID = 'aaaaaaaa-5555-2222-3333-444444444444';
const CLIENT_ID = 'cccccccc-5555-2222-3333-444444444444';
const ISSUER = `https://login.microsoftonline.com/${TENANT_ID}/v2.0`;
const KID = 'sso-only-test-kid';
const PASSWORD = 'sso-only-test-pass-1';
const SSO_REQUIRED = { code: 'SSO_REQUIRED', error: 'Your organization requires Microsoft sign-in.' };

let privateKey, jwksDoc;

// ---- outbound identity fakes ----
const REAL_JWKS_URL = `https://login.microsoftonline.com/${TENANT_ID}/discovery/v2.0/keys`;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url === REAL_JWKS_URL) {
    return new Response(JSON.stringify(jwksDoc), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(input, init);
};
const realHttpsGet = https.get;
let graphProfile = null;
https.get = function (options, cb) {
  if (options && options.hostname === 'graph.microsoft.com') {
    const resp = new PassThrough();
    process.nextTick(() => { cb(resp); resp.end(JSON.stringify(graphProfile)); });
    return { on() { return this; } };
  }
  return realHttpsGet.apply(this, arguments);
};
const realVerifyIdToken = OAuth2Client.prototype.verifyIdToken;
let googlePayload = null;
OAuth2Client.prototype.verifyIdToken = async function () {
  return { getPayload: () => googlePayload };
};

const saved = {
  ssoTenantId: config.ssoTenantId,
  entraTenantId: config.entraTenantId,
  microsoftClientId: config.microsoftClientId,
  entraRequireMfa: config.entraRequireMfa,
};
function configure({ tenant = '' } = {}) {
  config.ssoTenantId = tenant;
  config.entraTenantId = '';
  config.microsoftClientId = CLIENT_ID;
  config.entraRequireMfa = false;
}

function signIdToken(claims) {
  const now = Math.floor(Date.now() / 1000);
  return new jose.SignJWT({
    iss: ISSUER, aud: CLIENT_ID, tid: TENANT_ID, oid: crypto.randomUUID(), sub: 'pairwise',
    name: 'SSO Only', ver: '2.0', iat: now, nbf: now, exp: now + 3600, ...claims,
  })
    .setProtectedHeader({ alg: 'RS256', kid: KID, typ: 'JWT' })
    .sign(privateKey);
}

// ---- HTTP + fixtures ----
let app;
const cleanup = [];

async function j(method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${app.base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

async function registerUser(prefix) {
  const email = `${prefix}-${randTag()}@ssoonly.local`;
  const r = await j('POST', '/api/auth/register', { body: { email, password: PASSWORD, name: prefix, createOrg: true } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  cleanup.push(r.body.user.id);
  const ws = await app.db.prepare('SELECT organization_id FROM workspaces WHERE id = ?').get(r.body.current_workspace_id);
  return { id: r.body.user.id, email, token: r.body.token, workspaceId: r.body.current_workspace_id, orgId: ws.organization_id };
}

// A Microsoft-authenticated user (auth_provider = 'microsoft'), via the real route.
async function microsoftUser(prefix) {
  configure({ tenant: TENANT_ID });
  const email = `${prefix}-${randTag()}@ssoonly.local`;
  const r = await j('POST', '/api/auth/microsoft', { body: { id_token: await signIdToken({ preferred_username: email }) } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  cleanup.push(r.body.user.id);
  return { id: r.body.user.id, email, token: r.body.token };
}

const setSsoOnly = (orgId, on) => app.db.prepare('UPDATE organizations SET sso_only = ? WHERE id = ?').run(on ? 1 : 0, orgId);
const addOrgMember = (orgId, userId, role) =>
  app.db.prepare('INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, ?)').run(orgId, userId, role);
const addWsMember = (wsId, userId, role) =>
  app.db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)').run(wsId, userId, role);
const userRow = (id) => app.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
const failedLogins = (email) =>
  app.db.prepare("SELECT details FROM activity_log WHERE action = 'auth:login_failed' AND details LIKE ? ORDER BY id").all(`${email} - %`);
const login = (email, password = PASSWORD) => j('POST', '/api/auth/login', { body: { email, password } });

// owner: org_owner of the SSO-only org under test. member: workspace member of it.
let owner, member;

test.before(async () => {
  const kp = await jose.generateKeyPair('RS256', { extractable: true });
  privateKey = kp.privateKey;
  jwksDoc = { keys: [{ ...(await jose.exportJWK(kp.publicKey)), kid: KID, use: 'sig', alg: 'RS256' }] };
  await initDb();
  app = await startInProcessApp({ only: ['/api/organizations'] });
  owner = await registerUser('ssoowner');
  member = await registerUser('ssomember');
  await addWsMember(owner.workspaceId, member.id, 'workspace_editor');
});

test.after(async () => {
  try {
    if (app) {
      Object.assign(config, saved);
      globalThis.fetch = realFetch;
      https.get = realHttpsGet;
      OAuth2Client.prototype.verifyIdToken = realVerifyIdToken;
      await cleanupUsers(app.db, cleanup.reverse());
    }
  } finally {
    if (app) await app.stop(); else await db.close();
  }
});

test.beforeEach(async () => {
  configure({ tenant: '' });
  await setSsoOnly(owner.orgId, false);
});

// ===================== POST /api/auth/login =====================

test('login: sso_only = 0 (default) -> the member logs in exactly as before', async () => {
  const org = await app.db.prepare('SELECT sso_only FROM organizations WHERE id = ?').get(owner.orgId);
  assert.equal(org.sso_only, 0, 'a freshly created org is not SSO-only');
  const r = await login(member.email);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.token);
  assert.equal(r.body.code, undefined);
});

test('login: SSO-only org + correct password -> 403 SSO_REQUIRED, no session, audited', async () => {
  await setSsoOnly(owner.orgId, true);
  const r = await login(member.email);
  assert.equal(r.status, 403);
  assert.deepEqual(r.body, SSO_REQUIRED);
  // direct org member (the owner) too
  const o = await login(owner.email);
  assert.equal(o.status, 403);
  assert.deepEqual(o.body, SSO_REQUIRED);
  const rows = await failedLogins(member.email);
  assert.deepEqual(rows.map((x) => x.details), [`${member.email} - SSO required`]);
});

test('login: SSO-only org + wrong password / unknown user -> the existing generic 401 (no enumeration)', async () => {
  await setSsoOnly(owner.orgId, true);
  const wrong = await login(member.email, 'not-the-password');
  assert.equal(wrong.status, 401);
  assert.deepEqual(wrong.body, { error: 'Invalid email or password' });
  const unknown = await login(`nobody-${randTag()}@ssoonly.local`);
  assert.equal(unknown.status, 401);
  assert.deepEqual(unknown.body, { error: 'Invalid email or password' });
});

test('login: SSO-only org + deactivated account -> the existing deactivated 403 (not SSO_REQUIRED)', async () => {
  await setSsoOnly(owner.orgId, true);
  const u = await registerUser('ssodeact');
  await addWsMember(owner.workspaceId, u.id, 'workspace_viewer');
  await app.db.prepare('UPDATE users SET deactivated_at = UNIX_TIMESTAMP() WHERE id = ?').run(u.id);
  const r = await login(u.email);
  assert.equal(r.status, 403);
  assert.deepEqual(r.body, { error: ACCOUNT_DEACTIVATED_MESSAGE });
});

test('login: TOTP user in an SSO-only org -> 403 SSO_REQUIRED and NO mfa_token; with sso_only = 0 the TOTP step is unchanged', async () => {
  const u = await registerUser('ssototp');
  await addOrgMember(owner.orgId, u.id, 'org_admin');
  await app.db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(u.id);

  const before = await login(u.email);
  assert.equal(before.status, 200);
  assert.equal(before.body.mfa_required, true);
  assert.ok(before.body.mfa_token);

  await setSsoOnly(owner.orgId, true);
  const r = await login(u.email);
  assert.equal(r.status, 403);
  assert.deepEqual(r.body, SSO_REQUIRED);
  assert.equal(r.body.mfa_token, undefined);
});

test('totp/verify: mfa_token issued while sso_only = 0, org then switched to SSO-only -> 403 SSO_REQUIRED, no session', async () => {
  const u = await registerUser('ssototpgap');
  await addOrgMember(owner.orgId, u.id, 'org_admin');
  const setup = await j('POST', '/api/auth/totp/setup', { token: u.token, body: {} });
  assert.equal(setup.status, 200, JSON.stringify(setup.body));
  const enable = await j('POST', '/api/auth/totp/enable', { token: u.token, body: { code: authenticator.generate(setup.body.secret) } });
  assert.equal(enable.status, 200, JSON.stringify(enable.body));
  // enable recorded its code's step; clear it so a code from the same 30s window is usable below
  await app.db.prepare('UPDATE users SET totp_last_step = 0 WHERE id = ?').run(u.id);

  const step1 = await login(u.email);
  assert.equal(step1.status, 200);
  assert.ok(step1.body.mfa_token, 'mfa_token issued while the org is not SSO-only');

  await setSsoOnly(owner.orgId, true);
  const code = authenticator.generate(setup.body.secret);
  const r = await j('POST', '/api/auth/totp/verify', { body: { mfa_token: step1.body.mfa_token, code } });
  assert.equal(r.status, 403);
  assert.deepEqual(r.body, SSO_REQUIRED);
  assert.equal(r.body.token, undefined, 'no session token');
  assert.ok((await failedLogins(u.email)).some((x) => x.details === `${u.email} - SSO required`));
  assert.equal((await userRow(u.id)).totp_last_step, 0, 'refused attempt consumed no TOTP step');

  // Back to sso_only = 0: the same mfa_token + code complete exactly as before.
  await setSsoOnly(owner.orgId, false);
  const ok = await j('POST', '/api/auth/totp/verify', { body: { mfa_token: step1.body.mfa_token, code } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.ok(ok.body.token);
});

test('login: platform admin who is a member of an SSO-only org -> password login still works', async () => {
  const u = await registerUser('ssoplat');
  await addOrgMember(owner.orgId, u.id, 'org_admin');
  await app.db.prepare("UPDATE users SET role = 'platform_admin' WHERE id = ?").run(u.id);
  await setSsoOnly(owner.orgId, true);
  const r = await login(u.email);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.token);
});

test('login: a user in an UNRELATED org is unaffected by another org being SSO-only', async () => {
  const outsider = await registerUser('ssooutsider');
  await setSsoOnly(owner.orgId, true);
  assert.equal((await login(outsider.email)).status, 200);
});

// ===================== POST /api/auth/google =====================

test('google: existing user in an SSO-only org -> 403 SSO_REQUIRED, row unchanged, audited; sso_only = 0 -> original 409', async () => {
  googlePayload = { email: member.email, name: 'G', picture: '', sub: 'google-sub-1' };
  const plain = await j('POST', '/api/auth/google', { body: { credential: 'fake-google-credential' } });
  assert.equal(plain.status, 409, 'unchanged pre-Ref-5 behaviour for a password account');

  await setSsoOnly(owner.orgId, true);
  const r = await j('POST', '/api/auth/google', { body: { credential: 'fake-google-credential' } });
  assert.equal(r.status, 403);
  assert.deepEqual(r.body, SSO_REQUIRED);
  const row = await userRow(member.id);
  assert.equal(row.auth_provider, 'local');
  assert.ok((await failedLogins(member.email)).some((x) => x.details === `${member.email} - SSO required`));
});

test('google: a passwordless (e.g. microsoft) member of an SSO-only org is refused BEFORE the provider-link UPDATE', async () => {
  const ms = await microsoftUser('ssogoogms');
  await addWsMember(owner.workspaceId, ms.id, 'workspace_viewer');
  await setSsoOnly(owner.orgId, true);
  googlePayload = { email: ms.email, name: 'G', picture: '', sub: 'google-sub-2' };
  const r = await j('POST', '/api/auth/google', { body: { credential: 'fake-google-credential' } });
  assert.equal(r.status, 403);
  assert.deepEqual(r.body, SSO_REQUIRED);
  assert.equal((await userRow(ms.id)).auth_provider, 'microsoft', 'not relinked to google');
});

// ===================== POST /api/auth/microsoft (linking) =====================

test('microsoft: verified tenant id_token for an existing PASSWORD user in an SSO-only org -> 200 + linked + audited', async () => {
  const u = await registerUser('ssolink');
  await addWsMember(owner.workspaceId, u.id, 'workspace_viewer');
  await setSsoOnly(owner.orgId, true);
  configure({ tenant: TENANT_ID });
  const oid = crypto.randomUUID();
  const r = await j('POST', '/api/auth/microsoft', { body: { id_token: await signIdToken({ preferred_username: u.email, oid }) } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.user.id, u.id, 'same account, no duplicate');
  assert.ok(r.body.token);
  assert.equal(r.body.user.password_hash, undefined);

  const row = await userRow(u.id);
  assert.equal(row.auth_provider, 'microsoft');
  assert.equal(row.provider_id, oid);
  const audit = await app.db
    .prepare("SELECT user_id, details FROM activity_log WHERE action = 'account_linked_microsoft' AND user_id = ?")
    .all(u.id);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].details, u.email);

  // The issued session works, and the old password no longer does.
  assert.equal((await j('GET', '/api/auth/me', { token: r.body.token })).status, 200);
  assert.equal((await login(u.email)).status, 401);
});

test('microsoft: WITHOUT SSO_TENANT_ID (Graph path) -> password user in an SSO-only org still gets the 409', async () => {
  const u = await registerUser('ssograph');
  await addWsMember(owner.workspaceId, u.id, 'workspace_viewer');
  await setSsoOnly(owner.orgId, true);
  configure({ tenant: '' });
  graphProfile = { id: 'graph-id-ssoonly', mail: u.email, displayName: 'G' };
  const r = await j('POST', '/api/auth/microsoft', { body: { access_token: 'graph-token' } });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /log in with your password/);
  assert.equal((await userRow(u.id)).auth_provider, 'local');
});

test('microsoft: tenant set, password user NOT in any SSO-only org -> still 409', async () => {
  const u = await registerUser('ssonolink');
  configure({ tenant: TENANT_ID });
  const r = await j('POST', '/api/auth/microsoft', { body: { id_token: await signIdToken({ preferred_username: u.email }) } });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /log in with your password/);
  assert.equal((await userRow(u.id)).auth_provider, 'local');
});

// ===================== GET/PATCH /api/organizations/:orgId/auth-policy =====================

const policyPath = (orgId) => `/api/organizations/${orgId}/auth-policy`;

test('auth-policy: non-admins (workspace role, unrelated user) -> 403 on read and write', async () => {
  const outsider = await registerUser('ssopolout');
  for (const u of [member, outsider]) {
    assert.equal((await j('GET', policyPath(owner.orgId), { token: u.token })).status, 403);
    assert.equal((await j('PATCH', policyPath(owner.orgId), { token: u.token, body: { sso_only: true } })).status, 403);
  }
  assert.equal((await j('PATCH', policyPath('no-such-org'), { token: owner.token, body: { sso_only: false } })).status, 404);
});

test('auth-policy: GET shape, never exposes the tenant id; caller_can_enable reflects config + caller', async () => {
  configure({ tenant: '' });
  let g = await j('GET', policyPath(owner.orgId), { token: owner.token });
  assert.equal(g.status, 200);
  assert.deepEqual(g.body, { organization_id: owner.orgId, sso_only: false, sso_tenant_configured: false, caller_can_enable: false });

  configure({ tenant: TENANT_ID });
  g = await j('GET', policyPath(owner.orgId), { token: owner.token });
  assert.deepEqual(g.body, { organization_id: owner.orgId, sso_only: false, sso_tenant_configured: true, caller_can_enable: false });
  assert.ok(!JSON.stringify(g.body).includes(TENANT_ID), 'tenant id never returned');
});

test('auth-policy: validation - sso_only must be a boolean', async () => {
  for (const body of [{}, { sso_only: 'true' }, { sso_only: 1 }, { sso_only: null }]) {
    const r = await j('PATCH', policyPath(owner.orgId), { token: owner.token, body });
    assert.equal(r.status, 400, JSON.stringify(body));
  }
});

test('auth-policy: enabling without SSO_TENANT_ID -> 400, even for a Microsoft-authenticated org admin', async () => {
  const ms = await microsoftUser('ssopolms0');
  await addOrgMember(owner.orgId, ms.id, 'org_admin');
  configure({ tenant: '' });
  const r = await j('PATCH', policyPath(owner.orgId), { token: ms.token, body: { sso_only: true } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /SSO_TENANT_ID/);
  assert.equal((await app.db.prepare('SELECT sso_only FROM organizations WHERE id = ?').get(owner.orgId)).sso_only, 0);
});

test('auth-policy: enabling by a PASSWORD-authenticated org owner -> 403 (lock-out guard)', async () => {
  configure({ tenant: TENANT_ID });
  const r = await j('PATCH', policyPath(owner.orgId), { token: owner.token, body: { sso_only: true } });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, "Sign in with Microsoft before enabling SSO-only, so you don't lock yourself out.");
  assert.equal((await app.db.prepare('SELECT sso_only FROM organizations WHERE id = ?').get(owner.orgId)).sso_only, 0);
});

test('auth-policy: Microsoft-authenticated org admin enables (200 + audit); password owner disables (200 + audit)', async () => {
  const ms = await microsoftUser('ssopolms');
  await addOrgMember(owner.orgId, ms.id, 'org_admin');
  configure({ tenant: TENANT_ID });

  const g = await j('GET', policyPath(owner.orgId), { token: ms.token });
  assert.equal(g.body.caller_can_enable, true);

  const on = await j('PATCH', policyPath(owner.orgId), { token: ms.token, body: { sso_only: true } });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.deepEqual(on.body, { organization_id: owner.orgId, sso_only: true, sso_tenant_configured: true, caller_can_enable: true });
  assert.equal((await app.db.prepare('SELECT sso_only FROM organizations WHERE id = ?').get(owner.orgId)).sso_only, 1);
  // enforcement follows through the real API
  assert.deepEqual((await login(member.email)).body, SSO_REQUIRED);

  // A no-op PATCH writes no audit row.
  assert.equal((await j('PATCH', policyPath(owner.orgId), { token: ms.token, body: { sso_only: true } })).status, 200);

  // Disabling is always allowed - even for the password-authenticated owner, and
  // even with SSO_TENANT_ID unset.
  configure({ tenant: '' });
  const off = await j('PATCH', policyPath(owner.orgId), { token: owner.token, body: { sso_only: false } });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.equal(off.body.sso_only, false);
  assert.equal((await login(member.email)).status, 200);

  const audit = await app.db
    .prepare("SELECT user_id, details FROM activity_log WHERE action = 'org_sso_only_changed' AND details LIKE ? ORDER BY id")
    .all(`%(${owner.orgId})%`);
  assert.deepEqual(audit.map((r) => [r.user_id, r.details.split(', sso_only: ')[1]]), [
    [ms.id, 'false -> true'],
    [owner.id, 'true -> false'],
  ]);
});

test('auth-policy: a password-authenticated PLATFORM admin may enable (exempt from the lock-out guard)', async () => {
  const plat = await registerUser('ssopolplat');
  await app.db.prepare("UPDATE users SET role = 'platform_admin' WHERE id = ?").run(plat.id);
  configure({ tenant: TENANT_ID });
  const g = await j('GET', policyPath(owner.orgId), { token: plat.token });
  assert.equal(g.body.caller_can_enable, true);
  const r = await j('PATCH', policyPath(owner.orgId), { token: plat.token, body: { sso_only: true } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.sso_only, true);
});
