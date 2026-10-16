'use strict';

// Phase 1C batch 3: account grants write their audit row IN THE SAME TRANSACTION as the
// change (services/activity.js auditInTx) - no row, no change.
//
// Routes: registration, Google / Microsoft account creation (user + personal org + row in
// one transaction), Google / Microsoft provider linking (credential issuance), platform
// role (grant in-transaction, demotion post-commit), admin user create, SCIM user create /
// adopt (503 in the SCIM error shape) and the Entra role sync at a verified Microsoft
// sign-in (an audit failure fails the sign-in closed: 503 ROLE_SYNC_FAILED, nothing synced).
//
// Failure injection: helpers/fail-audit-in-tx.js (loaded first). Identity providers are the
// only fakes: Google's verifyIdToken (OAuth2Client.prototype), Microsoft Graph /v1.0/me
// (https.get to graph.microsoft.com) and Entra's JWKS URL (globalThis.fetch, that URL only;
// id_tokens are self-signed), as in auth-audit-rows / entra-role-signin.
//
// Also: duplicate-email races on register / admin create (one 201, the rest 409 - no 500s);
// a mixed load across these routes and batches 1-2; verifyChain + verify-integrity.
// The first-user race needs an empty users table: audit-in-tx-first-user.test.js.
//
// Real routers in-process (helpers/inprocess-app.js; /scim/v2 mounted as scim.test.js
// does) against the real MySQL test DB. Fixtures are test-owned (prefix aib-).

const failHook = require('./helpers/fail-audit-in-tx'); // before services/activity loads

const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const crypto = require('node:crypto');
const { PassThrough } = require('node:stream');
const jose = require('jose');
const bcrypt = require('bcryptjs');
const { OAuth2Client } = require('google-auth-library');
const config = require('../config');
const { db } = require('../db/database');
const { generateToken } = require('../middleware/auth');
const { logActivity } = require('../services/activity');
const { verifyChain } = require('../lib/activity-chain');
const { startInProcessApp } = require('./helpers/inprocess-app');
const { randTag, cleanupUsers } = require('./helpers/disposable');
const { maxAuditId } = require('./helpers/wait-for-audit');

const P = `aib-${randTag()}`; // lower-case: routes lower-case emails
const TAG = randTag();
const PW = 'Accounts-passw0rd';
const UNAVAILABLE = { error: 'Change not applied: audit unavailable', code: 'AUDIT_UNAVAILABLE' };
const ROLE_SYNC_FAILED = { code: 'ROLE_SYNC_FAILED', error: 'Sign-in could not complete; please try again.' };

// ---- identity-provider fakes ----
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
const TENANT_ID = 'aaaaaaaa-1c3b-2222-3333-444444444444';
const CLIENT_ID = 'cccccccc-1c3b-2222-3333-444444444444';
const ISSUER = `https://login.microsoftonline.com/${TENANT_ID}/v2.0`;
const KID = 'audit-in-tx-accounts-kid';
const JWKS_URL = `https://login.microsoftonline.com/${TENANT_ID}/discovery/v2.0/keys`;
let privateKey;
let jwksDoc;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url === JWKS_URL) return new Response(JSON.stringify(jwksDoc), { status: 200, headers: { 'content-type': 'application/json' } });
  return realFetch(input, init);
};
async function signIdToken(claims) {
  const now = Math.floor(Date.now() / 1000);
  return new jose.SignJWT({
    iss: ISSUER, aud: CLIENT_ID, tid: TENANT_ID, oid: crypto.randomUUID(), sub: 'pairwise',
    name: 'Accounts', ver: '2.0', iat: now, nbf: now, exp: now + 3600, ...claims,
  }).setProtectedHeader({ alg: 'RS256', kid: KID, typ: 'JWT' }).sign(privateKey);
}

const saved = {
  disableRegistration: config.disableRegistration,
  autoCreateOrgOnSignup: config.autoCreateOrgOnSignup,
  ssoTenantId: config.ssoTenantId,
  entraTenantId: config.entraTenantId,
  microsoftClientId: config.microsoftClientId,
  entraRequireMfa: config.entraRequireMfa,
};
const tenantOn = () => Object.assign(config, { ssoTenantId: TENANT_ID, entraTenantId: '', microsoftClientId: CLIENT_ID, entraRequireMfa: false });
const tenantOff = () => { config.ssoTenantId = ''; };

// console.error spy for the "[audit] NOT AUDITED" marker (still printed).
const realError = console.error;
const errors = [];
console.error = (...a) => { errors.push(a.join(' ')); realError(...a); };

let app;
let since0;
let scimToken;
const F = {};

test.before(async () => {
  const kp = await jose.generateKeyPair('RS256');
  privateKey = kp.privateKey;
  jwksDoc = { keys: [{ ...(await jose.exportJWK(kp.publicKey)), kid: KID, use: 'sig', alg: 'RS256' }] };
  app = await startInProcessApp({ only: ['/api/admin', '/api/organizations', '/api/workspaces', '/api/tokens', '/api/activity'] });
  app.app.use('/scim/v2', require('../routes/scim'));
  config.disableRegistration = false;
  config.autoCreateOrgOnSignup = true;
  tenantOff();
  since0 = await maxAuditId(app.db);
  F.platform = await mkUser({ role: 'platform_admin' });
  F.owner = await mkUser();
  F.orgId = crypto.randomUUID();
  F.wsId = crypto.randomUUID();
  await app.db.prepare("INSERT INTO organizations (id, name, owner_user_id, plan_id, subscription_status) VALUES (?, ?, ?, 'enterprise', 'active')").run(F.orgId, `${P} Org`, F.owner.id);
  await app.db.prepare("INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'org_owner')").run(F.orgId, F.owner.id);
  await app.db.prepare('INSERT INTO workspaces (id, organization_id, name, created_by) VALUES (?, ?, ?, ?)').run(F.wsId, F.orgId, `${P} WS`, F.owner.id);
  await app.db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin')").run(F.wsId, F.owner.id);
  F.ownerToken = generateToken(F.owner, F.wsId);
  const s = await call('POST', '/api/admin/scim-tokens', F.platform.token, { name: `${P} scim`, organization_id: F.orgId });
  assert.equal(s.status, 201, s.text);
  scimToken = s.json.token;
});

test.after(async () => {
  try {
    if (app) {
      failHook.disarm();
      Object.assign(config, saved);
      await app.db.prepare('DELETE FROM entra_role_mappings WHERE organization_id = ?').run(F.orgId);
      await app.db.prepare('DELETE FROM scim_tokens WHERE organization_id = ?').run(F.orgId);
      // Every account this file made (directly or through a route) has the P prefix.
      const ids = (await app.db.prepare('SELECT id FROM users WHERE email LIKE ? ORDER BY created_at, id').all(`${P}%`)).map((r) => r.id);
      // Newest first: an org owner is deletable only once its other members are gone.
      await cleanupUsers(app.db, ids.reverse());
    }
  } finally {
    OAuth2Client.prototype.verifyIdToken = realVerifyIdToken;
    https.get = realHttpsGet;
    globalThis.fetch = realFetch;
    console.error = realError;
    if (app) await app.stop(); else await db.close();
  }
});

// ---- helpers ----
const newEmail = (tag) => `${P}-${tag}-${randTag()}@x.local`;
async function mkUser({ role = 'user', password = PW, provider = 'local' } = {}) {
  const id = `${P}-${randTag()}`;
  const email = `${id}@x.local`;
  await app.db.prepare(
    `INSERT INTO users (id, email, name, password_hash, auth_provider, role, plan_id) VALUES (?, ?, ?, ?, ?, ?, 'enterprise')`,
  ).run(id, email, id, password ? bcrypt.hashSync(password, 4) : null, provider, role);
  return { id, email, role, token: generateToken({ id, email, role }, null) };
}
async function call(method, path, token, body, headers = {}) {
  const r = await fetch(`${app.base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, json, text };
}
const scim = (method, path, body) => call(method, `/scim/v2${path}`, scimToken, body, { 'content-type': 'application/scim+json' });
const rowsSince = (since) => app.db.prepare(
  'SELECT id, user_id, action, details, workspace_id, organization_id FROM activity_log WHERE id > ? ORDER BY id',
).all(since);
const rowsOf = async (since, action) => (await rowsSince(since)).filter((r) => r.action === action);
async function oneRow(since, action) {
  const rows = await rowsOf(since, action);
  assert.equal(rows.length, 1, `exactly one ${action} row, read immediately after the response (got ${rows.length})`);
  return rows[0];
}

// Everything an account can hold, for the given emails, plus this file's org - as one value.
async function snapshot(emails) {
  const q = (sql, ...p) => app.db.prepare(sql).all(...p);
  const ph = emails.map(() => '?').join(',');
  const users = emails.length ? await q(`SELECT id, email, role, auth_provider, provider_id, deactivated_at FROM users WHERE email IN (${ph}) ORDER BY email`, ...emails) : [];
  const ids = users.map((u) => u.id);
  const iph = ids.map(() => '?').join(',');
  return JSON.stringify({
    users,
    ownedOrgs: ids.length ? await q(`SELECT id, owner_user_id FROM organizations WHERE owner_user_id IN (${iph}) ORDER BY id`, ...ids) : [],
    orgMembers: ids.length ? await q(`SELECT organization_id, user_id, role, source FROM organization_members WHERE user_id IN (${iph}) ORDER BY organization_id, user_id`, ...ids) : [],
    wsMembers: ids.length ? await q(`SELECT workspace_id, user_id, role, source FROM workspace_members WHERE user_id IN (${iph}) ORDER BY workspace_id, user_id`, ...ids) : [],
    fileOrg: await q('SELECT user_id, role FROM organization_members WHERE organization_id = ? ORDER BY user_id', F.orgId),
  });
}

// Injected in-transaction audit failure for `action`: the expected refusal, the accounts'
// state unchanged, no row.
async function assertFailureNotApplied(emails, action, request, { status = 503, body = UNAVAILABLE } = {}) {
  const before = await snapshot(emails);
  const since = await maxAuditId(app.db);
  const fired0 = failHook.fired();
  failHook.failNextAuditInTx(action);
  const r = await request();
  const disarmed = failHook.disarm();
  const after = await snapshot(emails);
  const rows = await rowsOf(since, action);
  if (after !== before && rows.length === 0) {
    assert.fail(`change applied, no row: ${action} answered ${r.status} and changed the DB without an audit row`);
  }
  assert.equal(disarmed, false, `the injected failure for ${action} fired`);
  assert.equal(failHook.fired(), fired0 + 1);
  assert.equal(r.status, status, `${r.status} ${r.text}`);
  if (typeof body === 'function') body(r.json); else assert.deepEqual(r.json, body);
  assert.equal(after, before, 'nothing was created or changed');
  assert.deepEqual(rows, [], `no ${action} row`);
}

// ---- registration and SSO account creation ----
test('register: audit failure -> 503, no user, no org; next attempt -> one row (user + org + row together)', async () => {
  const email = newEmail('reg');
  const body = { email, password: PW, name: 'Reg', createOrg: true };
  await assertFailureNotApplied([email], 'user_registered', () => call('POST', '/api/auth/register', null, body));
  const since = await maxAuditId(app.db);
  const ok = await call('POST', '/api/auth/register', null, body);
  assert.equal(ok.status, 201, ok.text);
  const org = await app.db.prepare('SELECT id, name FROM organizations WHERE owner_user_id = ?').get(ok.json.user.id);
  const row = await oneRow(since, 'user_registered');
  assert.equal(row.details, `email: ${email}, role: user, org_created: true, org: ${org.name} (${org.id})`);
  assert.equal(row.organization_id, org.id);
  assert.equal(row.workspace_id, ok.json.current_workspace_id);
});

test('race: 8 concurrent registrations of one email -> one 201, seven 409 (no 500), one user, one row', async () => {
  const email = newEmail('dup');
  const since = await maxAuditId(app.db);
  const results = await Promise.all(Array.from({ length: 8 }, () => call('POST', '/api/auth/register', null, { email, password: PW, createOrg: false })));
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409, 409, 409, 409, 409, 409, 409], results.map((r) => `${r.status} ${r.text}`).join(' | '));
  assert.equal((await app.db.prepare('SELECT COUNT(*) AS n FROM users WHERE email = ?').get(email)).n, 1);
  assert.equal((await rowsOf(since, 'user_registered')).filter((r) => r.details.startsWith(`email: ${email},`)).length, 1);
});

test('Google: account creation and linking - audit failure -> 503, nothing created / linked; next attempt -> one row', async () => {
  const email = newEmail('g');
  googlePayload = { email, name: 'G User', picture: '', sub: `g-${randTag()}` };
  await assertFailureNotApplied([email], 'user_created_sso', () => call('POST', '/api/auth/google', null, { credential: 'x' }));
  let since = await maxAuditId(app.db);
  const ok = await call('POST', '/api/auth/google', null, { credential: 'x' });
  assert.equal(ok.status, 200, ok.text);
  assert.equal((await oneRow(since, 'user_created_sso')).details, `email: ${email}, provider: google, role: user`);
  assert.ok(await app.db.prepare('SELECT 1 FROM organizations WHERE owner_user_id = ?').get(ok.json.user.id), 'the personal org was created with the account');

  // Link: a passwordless Microsoft account signs in with Google.
  const ms = await mkUser({ password: null, provider: 'microsoft' });
  googlePayload = { email: ms.email, name: 'Linked', picture: '', sub: `g-${randTag()}` };
  await assertFailureNotApplied([ms.email], 'account_linked_google', () => call('POST', '/api/auth/google', null, { credential: 'x' }));
  since = await maxAuditId(app.db);
  assert.equal((await call('POST', '/api/auth/google', null, { credential: 'x' })).status, 200);
  assert.equal((await oneRow(since, 'account_linked_google')).details, ms.email);
  assert.equal((await app.db.prepare('SELECT auth_provider FROM users WHERE id = ?').get(ms.id)).auth_provider, 'google');
});

test('Microsoft (Graph): account creation and linking - audit failure -> 503; next attempt -> one row', async () => {
  tenantOff();
  const email = newEmail('m');
  graphProfile = { id: `m-${randTag()}`, mail: email, displayName: 'M User' };
  await assertFailureNotApplied([email], 'user_created_sso', () => call('POST', '/api/auth/microsoft', null, { access_token: 'x' }));
  let since = await maxAuditId(app.db);
  const ok = await call('POST', '/api/auth/microsoft', null, { access_token: 'x' });
  assert.equal(ok.status, 200, ok.text);
  assert.equal((await oneRow(since, 'user_created_sso')).details, `email: ${email}, provider: microsoft, role: user`);

  const g = await mkUser({ password: null, provider: 'google' });
  graphProfile = { id: `m-${randTag()}`, mail: g.email, displayName: 'Linked' };
  await assertFailureNotApplied([g.email], 'account_linked_microsoft', () => call('POST', '/api/auth/microsoft', null, { access_token: 'x' }));
  since = await maxAuditId(app.db);
  assert.equal((await call('POST', '/api/auth/microsoft', null, { access_token: 'x' })).status, 200);
  assert.equal((await oneRow(since, 'account_linked_microsoft')).details, g.email);
});

test('Microsoft (verified id_token): SSO-only link exception and Entra role sync - audit failure fails closed; next attempt -> one row', async () => {
  tenantOn();
  try {
    // SSO-only link (a password account in an SSO-only org): was a plain logActivity.
    const u = await mkUser();
    const orgId = crypto.randomUUID();
    await app.db.prepare("INSERT INTO organizations (id, name, owner_user_id, plan_id, subscription_status, sso_only) VALUES (?, ?, ?, 'enterprise', 'active', 1)").run(orgId, `${P} SSO Org`, F.owner.id);
    await app.db.prepare("INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'org_admin')").run(orgId, u.id);
    const signIn = async (email, roles) => call('POST', '/api/auth/microsoft', null, { id_token: await signIdToken({ preferred_username: email, ...(roles ? { roles } : {}) }) });
    await assertFailureNotApplied([u.email], 'account_linked_microsoft', () => signIn(u.email));
    let since = await maxAuditId(app.db);
    const linked = await signIn(u.email);
    assert.equal(linked.status, 200, linked.text);
    assert.equal((await oneRow(since, 'account_linked_microsoft')).details, u.email);
    await app.db.prepare('DELETE FROM organizations WHERE id = ?').run(orgId);

    // Role sync: a mapped app role grants workspace_editor at sign-in.
    const claim = `AIB.Editors.${TAG}`;
    await app.db.prepare("INSERT INTO entra_role_mappings (organization_id, claim_value, workspace_id, role) VALUES (?, ?, ?, 'workspace_editor')").run(F.orgId, claim, F.wsId);
    const v = await mkUser({ password: null, provider: 'microsoft' });
    await assertFailureNotApplied([v.email], 'entra_role_sync', () => signIn(v.email, [claim]), { status: 503, body: ROLE_SYNC_FAILED });
    since = await maxAuditId(app.db);
    const ok = await signIn(v.email, [claim]);
    assert.equal(ok.status, 200, ok.text);
    const row = await oneRow(since, 'entra_role_sync');
    assert.deepEqual(JSON.parse(row.details).added, [`ws:${F.wsId}:workspace_editor`]);
    assert.equal(row.user_id, v.id);
  } finally {
    tenantOff();
  }
});

// ---- platform role, admin user create ----
test('platform role: a grant is in-transaction; a demotion still applies when its write fails', async () => {
  const t = await mkUser();
  const url = `/api/auth/users/${t.id}/role`;
  await assertFailureNotApplied([t.email], 'platform_role_changed', () => call('PUT', url, F.platform.token, { role: 'platform_operator' }));
  const since = await maxAuditId(app.db);
  assert.equal((await call('PUT', url, F.platform.token, { role: 'platform_operator' })).status, 200);
  assert.equal((await oneRow(since, 'platform_role_changed')).details, `target: ${t.email}, role: user -> platform_operator`);

  // Demotion: never reaches auditInTx; its post-commit write fails; it applies anyway.
  const s2 = await maxAuditId(app.db);
  errors.length = 0;
  failHook.failNextAuditInTx('platform_role_changed');
  failHook.failNextPostCommitAudit('platform_role_changed');
  const d = await call('PUT', url, F.platform.token, { role: 'user' });
  assert.equal(failHook.disarm(), true, 'a demotion never reaches auditInTx');
  assert.equal(d.status, 200, d.text);
  assert.equal((await app.db.prepare('SELECT role FROM users WHERE id = ?').get(t.id)).role, 'user');
  assert.deepEqual(await rowsOf(s2, 'platform_role_changed'), []);
  assert.ok(errors.some((e) => e.includes('[audit] NOT AUDITED: action=platform_role_changed')), errors.join('\n'));
});

test('admin user create: audit failure -> 503, no user, no membership; next attempt -> one row; a duplicate-email race -> 409s, not 500s', async () => {
  const email = newEmail('adm');
  const body = { email, name: 'Adm', password: PW, workspaceId: F.wsId, role: 'workspace_editor' };
  await assertFailureNotApplied([email], 'admin_create_user', () => call('POST', '/api/admin/users', F.platform.token, body));
  const since = await maxAuditId(app.db);
  const ok = await call('POST', '/api/admin/users', F.platform.token, body);
  assert.equal(ok.status, 201, ok.text);
  const row = await oneRow(since, 'admin_create_user');
  assert.equal(row.details, `target: ${email}, role: workspace_editor`);
  assert.equal(row.workspace_id, F.wsId);

  const dup = newEmail('admdup');
  const results = await Promise.all(Array.from({ length: 6 }, () => call('POST', '/api/admin/users', F.platform.token, { ...body, email: dup })));
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409, 409, 409, 409, 409], results.map((r) => `${r.status} ${r.text}`).join(' | '));
});

// ---- SCIM ----
test('SCIM user create / adopt: audit failure -> 503 (SCIM error shape), nothing created; next attempt -> one row', async () => {
  const scim503 = (b) => {
    assert.deepEqual(b.schemas, ['urn:ietf:params:scim:api:messages:2.0:Error']);
    assert.equal(String(b.status), '503');
    assert.equal(b.detail, 'Change not applied: audit unavailable');
  };
  const email = newEmail('scim');
  await assertFailureNotApplied([email], 'scim:user_created', () => scim('POST', '/Users', { schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName: email, active: true }), { status: 503, body: scim503 });
  let since = await maxAuditId(app.db);
  const c = await scim('POST', '/Users', { schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName: email, active: true });
  assert.equal(c.status, 201, c.text);
  const row = await oneRow(since, 'scim:user_created');
  assert.equal(row.details, `${email} (SCIM token "${P} scim")`);
  assert.equal(row.organization_id, F.orgId);

  // Adopt: an existing account, not yet in this org, is linked into it.
  const existing = await mkUser();
  await assertFailureNotApplied([existing.email], 'scim:user_linked', () => scim('POST', '/Users', { schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName: existing.email, active: true }), { status: 503, body: scim503 });
  since = await maxAuditId(app.db);
  const a = await scim('POST', '/Users', { schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName: existing.email, active: true });
  assert.equal(a.status, 201, a.text);
  assert.equal((await oneRow(since, 'scim:user_linked')).details, `${existing.email} (SCIM token "${P} scim")`);
});

// ---- mixed load ----
test('mixed load: concurrent account creations / role changes / SCIM + batch 1-2 grants + fire-and-forget rows -> no errors, every change has its row', async () => {
  const targets = [await mkUser(), await mkUser(), await mkUser()];
  const wsMember = await mkUser();
  await app.db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_viewer')").run(F.wsId, wsMember.id);
  const since = await maxAuditId(app.db);
  const regEmails = Array.from({ length: 6 }, (_, i) => newEmail(`mreg${i}`));
  const admEmails = Array.from({ length: 4 }, (_, i) => newEmail(`madm${i}`));
  const scimEmails = Array.from({ length: 4 }, (_, i) => newEmail(`mscim${i}`));
  const reqs = [
    ...regEmails.map((email, i) => call('POST', '/api/auth/register', null, { email, password: PW, createOrg: i % 2 === 0 })),
    ...admEmails.map((email) => call('POST', '/api/admin/users', F.platform.token, { email, password: PW, workspaceId: F.wsId, role: 'workspace_viewer' })),
    ...scimEmails.map((email) => scim('POST', '/Users', { schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName: email, active: true })),
    ...targets.flatMap((t) => ['platform_operator', 'user', 'platform_operator'].map((role) => call('PUT', `/api/auth/users/${t.id}/role`, F.platform.token, { role }))),
    ...['workspace_editor', 'workspace_admin', 'workspace_viewer'].map((role) => call('PUT', `/api/workspaces/${F.wsId}/members/${wsMember.id}`, F.ownerToken, { role })),
    ...Array.from({ length: 3 }, (_, i) => call('POST', '/api/tokens', F.ownerToken, { name: `${P} mixed ${i}`, scope: 'read' })),
  ];
  const ff = Array.from({ length: 20 }, (_, i) => logActivity(F.owner.id, 'accounts_fire_and_forget', `${P} ${i}`));
  const results = await Promise.all(reqs);
  assert.deepEqual(await Promise.all(ff), Array(20).fill(true));
  const bad = results.filter((r) => ![200, 201].includes(r.status));
  assert.deepEqual(bad.map((r) => `${r.status} ${r.text}`), [], 'no errors (no 500s / 503s)');

  const rows = await rowsSince(since);
  const has = (action, pred) => rows.filter((r) => r.action === action && pred(r)).length;
  for (const e of regEmails) assert.equal(has('user_registered', (r) => r.details.startsWith(`email: ${e},`)), 1, e);
  for (const e of admEmails) assert.equal(has('admin_create_user', (r) => r.details === `target: ${e}, role: workspace_viewer`), 1, e);
  for (const e of scimEmails) assert.equal(has('scim:user_created', (r) => r.details.startsWith(`${e} (`)), 1, e);
  // Platform roles: the recorded changes per target chain user -> ... -> the final role.
  function chainExists(left, cur, final) {
    if (!left.length) return cur === final;
    return left.some((s, i) => s.from === cur && chainExists([...left.slice(0, i), ...left.slice(i + 1)], s.to, final));
  }
  for (const t of targets) {
    const final = (await app.db.prepare('SELECT role FROM users WHERE id = ?').get(t.id)).role;
    const steps = rows.filter((r) => r.action === 'platform_role_changed' && r.details.startsWith(`target: ${t.email},`))
      .map((r) => { const m = /role: (\S+) -> (\S+)$/.exec(r.details); return { from: m[1], to: m[2] }; });
    assert.ok(chainExists(steps, 'user', final), `${t.email}: ${JSON.stringify(steps)} -> ${final}`);
  }
  assert.equal(has('api_token_created', (r) => r.details.includes(`name: ${P} mixed `)), 3);
  assert.equal(has('accounts_fire_and_forget', () => true), 20);
});

// ---- chain integrity ----
test('chain: verifyChain and GET /api/activity/verify-integrity pass over every row this file wrote', async () => {
  const end = await maxAuditId(app.db);
  assert.ok(end > since0 + 40, `rows written: ${end - since0}`);
  const report = await verifyChain(app.db, { startId: since0 + 1, endId: end });
  assert.equal(report.ok, true, JSON.stringify(report).slice(0, 2000));
  const r = await call('GET', `/api/activity/verify-integrity?start_id=${since0 + 1}&end_id=${end}`, F.platform.token);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.ok, true, r.text.slice(0, 2000));
});
