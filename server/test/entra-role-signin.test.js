'use strict';

// Ref 7: the Entra role sync on POST /api/auth/microsoft, end to end over real
// HTTP: the REAL routes/auth.js + organizations/workspaces/admin routers mounted
// in-process (helpers/inprocess-app.js) against the REAL MySQL database. Same
// harness as test/sso-only.test.js / microsoft-sso.test.js - only Entra's JWKS
// URL (globalThis.fetch, that one URL) and Graph /v1.0/me (https.get to
// graph.microsoft.com only) are faked; id_tokens are self-signed with a `roles`
// claim. Also covers manual takeover through the real member routes.

const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const crypto = require('node:crypto');
const { PassThrough } = require('node:stream');
const jose = require('jose');

const config = require('../config');
const { initDb } = require('../db/database');
const { ACCOUNT_DEACTIVATED_MESSAGE } = require('../middleware/auth');
const { startInProcessApp } = require('./helpers/inprocess-app');
const { randTag, cleanupUsers } = require('./helpers/disposable');

const TENANT_ID = 'aaaaaaaa-7777-2222-3333-444444444444';
const CLIENT_ID = 'cccccccc-7777-2222-3333-444444444444';
const ISSUER = `https://login.microsoftonline.com/${TENANT_ID}/v2.0`;
const KID = 'entra-role-signin-kid';
const PASSWORD = 'ref7-signin-pass-1';
const TAG = randTag();
const R = (n) => `Ref7Signin.${n}.${TAG}`;
const ROLE_SYNC_FAILED = { code: 'ROLE_SYNC_FAILED', error: 'Sign-in could not complete; please try again.' };

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

const saved = {
  ssoTenantId: config.ssoTenantId,
  entraTenantId: config.entraTenantId,
  microsoftClientId: config.microsoftClientId,
  entraRequireMfa: config.entraRequireMfa,
};
function configure({ tenant = TENANT_ID } = {}) {
  config.ssoTenantId = tenant;
  config.entraTenantId = '';
  config.microsoftClientId = CLIENT_ID;
  config.entraRequireMfa = false;
}

function signIdToken(claims) {
  const now = Math.floor(Date.now() / 1000);
  return new jose.SignJWT({
    iss: ISSUER, aud: CLIENT_ID, tid: TENANT_ID, oid: crypto.randomUUID(), sub: 'pairwise',
    name: 'Role Sync', ver: '2.0', iat: now, nbf: now, exp: now + 3600, ...claims,
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

async function registerUser(prefix, createOrg = true) {
  const email = `${prefix}-${randTag()}@ref7signin.local`;
  const r = await j('POST', '/api/auth/register', { body: { email, password: PASSWORD, name: prefix, createOrg } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  cleanup.push(r.body.user.id);
  const ws = r.body.current_workspace_id
    ? await app.db.prepare('SELECT organization_id FROM workspaces WHERE id = ?').get(r.body.current_workspace_id)
    : null;
  return { id: r.body.user.id, email, token: r.body.token, workspaceId: r.body.current_workspace_id, orgId: ws?.organization_id };
}

// POST /api/auth/microsoft with a verified (self-signed) id_token. roles: array,
// or undefined for no `roles` claim at all.
async function msSignIn(email, roles) {
  const claims = { preferred_username: email };
  if (roles !== undefined) claims.roles = roles;
  const r = await j('POST', '/api/auth/microsoft', { body: { id_token: await signIdToken(claims) } });
  if (r.status === 200 && !cleanup.includes(r.body.user.id)) cleanup.push(r.body.user.id);
  return r;
}
const newEmail = (p) => `${p}-${randTag()}@ref7signin.local`;

// The user's memberships in the fixture org O (org row + W1/W2), "kind:id:role:source".
async function memberships(userId) {
  const o = await app.db
    .prepare('SELECT role, source FROM organization_members WHERE organization_id = ? AND user_id = ?')
    .all(O, userId);
  const w = await app.db
    .prepare('SELECT workspace_id, role, source FROM workspace_members WHERE user_id = ? AND workspace_id IN (?, ?) ORDER BY workspace_id')
    .all(userId, W1, W2);
  return [
    ...o.map((r) => `org:${O}:${r.role}:${r.source ?? 'manual'}`),
    ...w.map((r) => `ws:${r.workspace_id}:${r.role}:${r.source ?? 'manual'}`),
  ].sort();
}
const syncAudit = (userId) =>
  app.db.prepare("SELECT details FROM activity_log WHERE action = 'entra_role_sync' AND user_id = ? ORDER BY id").all(userId);
const setSsoOnly = (orgId, on) => app.db.prepare('UPDATE organizations SET sso_only = ? WHERE id = ?').run(on ? 1 : 0, orgId);

let owner, platAdmin, O, W1, W2;

test.before(async () => {
  const kp = await jose.generateKeyPair('RS256', { extractable: true });
  privateKey = kp.privateKey;
  jwksDoc = { keys: [{ ...(await jose.exportJWK(kp.publicKey)), kid: KID, use: 'sig', alg: 'RS256' }] };
  await initDb();
  app = await startInProcessApp({ only: ['/api/organizations', '/api/workspaces', '/api/admin'] });
  owner = await registerUser('ref7siown');
  platAdmin = await registerUser('ref7siplat', false);
  await app.db.prepare("UPDATE users SET role = 'platform_admin' WHERE id = ?").run(platAdmin.id);
  O = owner.orgId;
  W1 = owner.workspaceId;
  W2 = crypto.randomUUID();
  await app.db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run(W2, O, `ref7si-w2-${TAG}`);
  const map = (claim, role, ws = null) =>
    app.db.prepare('INSERT INTO entra_role_mappings (organization_id, claim_value, workspace_id, role) VALUES (?, ?, ?, ?)').run(O, claim, ws, role);
  await map(R('Editors'), 'workspace_editor', W1);
  await map(R('Admins'), 'org_admin');
  await map(R('W2Admins'), 'workspace_admin', W2);
});

test.after(async () => {
  Object.assign(config, saved);
  globalThis.fetch = realFetch;
  https.get = realHttpsGet;
  await setSsoOnly(O, false);
  await cleanupUsers(app.db, cleanup.reverse());
  await app.stop();
});

test.beforeEach(() => configure({ tenant: TENANT_ID }));

let first; // { id, email } - the user from the first test, reused by the second
test('verified token with roles: a NEW user gets source = entra memberships before the session is issued', async () => {
  const email = newEmail('ref7sinew');
  const r = await msSignIn(email, [R('Editors'), R('Admins'), 'Some.Unmapped.Role']);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.token);
  first = { id: r.body.user.id, email };
  assert.deepEqual(await memberships(first.id), [`org:${O}:org_admin:entra`, `ws:${W1}:workspace_editor:entra`].sort());
  assert.equal(r.body.current_workspace_id, W1, 'the session lands in the mapped workspace (no personal org minted)');
  const audit = await syncAudit(first.id);
  assert.equal(audit.length, 1);
  assert.deepEqual(JSON.parse(audit[0].details).added, [`org:${O}:org_admin`, `ws:${W1}:workspace_editor`]);
  assert.ok(!audit[0].details.includes(email) && !audit[0].details.includes(TAG));
});

test('a second sign-in without the role removes the entra memberships', async () => {
  const r = await msSignIn(first.email, undefined); // no roles claim at all
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(await memberships(first.id), []);
  const audit = await syncAudit(first.id);
  assert.equal(audit.length, 2);
  assert.deepEqual(JSON.parse(audit[1].details).removed.sort(), [`org:${O}:org_admin`, `ws:${W1}:workspace_editor`].sort());
  // An empty roles array behaves the same (nothing left to remove; no audit row).
  assert.equal((await msSignIn(first.email, [])).status, 200);
  assert.equal((await syncAudit(first.id)).length, 2);
});

test('manual memberships are untouched (role and source), with or without the role', async () => {
  const email = newEmail('ref7siman');
  const u = (await msSignIn(email, [])).body.user;
  await app.db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)').run(W2, u.id, 'workspace_viewer');
  const r = await msSignIn(email, [R('W2Admins')]);
  assert.equal(r.status, 200);
  assert.deepEqual(await memberships(u.id), [`ws:${W2}:workspace_viewer:manual`]);
  assert.equal((await syncAudit(u.id)).length, 0, 'a skip-only sync writes NO audit entry');
  assert.equal((await msSignIn(email, [])).status, 200);
  assert.deepEqual(await memberships(u.id), [`ws:${W2}:workspace_viewer:manual`]);
  assert.equal((await syncAudit(u.id)).length, 0);
});

test('a sign-in with a change plus a skipped manual row writes ONE audit entry containing both', async () => {
  const email = newEmail('ref7simix');
  const u = (await msSignIn(email, [])).body.user;
  await app.db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)').run(W2, u.id, 'workspace_viewer');
  const r = await msSignIn(email, [R('W2Admins'), R('Editors')]);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(await memberships(u.id), [`ws:${W1}:workspace_editor:entra`, `ws:${W2}:workspace_viewer:manual`].sort());
  const audit = await syncAudit(u.id);
  assert.equal(audit.length, 1);
  assert.deepEqual(JSON.parse(audit[0].details), {
    added: [`ws:${W1}:workspace_editor`],
    updated: [],
    removed: [],
    skipped_manual: [`ws:${W2}:workspace_admin`],
  });
});

test('no SSO_TENANT_ID (Graph flow): no sync at all - entra rows stay, no audit row', async () => {
  const email = newEmail('ref7sinotenant');
  const u = (await msSignIn(email, [R('Editors')])).body.user;
  assert.deepEqual(await memberships(u.id), [`ws:${W1}:workspace_editor:entra`]);
  const auditBefore = (await syncAudit(u.id)).length;

  configure({ tenant: '' });
  graphProfile = { id: crypto.randomUUID(), mail: email, displayName: 'No Tenant' };
  const r = await j('POST', '/api/auth/microsoft', { body: { access_token: 'graph-access-token' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.user.id, u.id);
  assert.deepEqual(await memberships(u.id), [`ws:${W1}:workspace_editor:entra`], 'not removed: the sync did not run');
  assert.equal((await syncAudit(u.id)).length, auditBefore);
});

test('the Ref 5 account-link path (password user in an SSO-only org) syncs too', async () => {
  const u = await registerUser('ref7silink', false);
  await app.db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)').run(W2, u.id, 'workspace_viewer');
  await setSsoOnly(O, true);
  try {
    const r = await msSignIn(u.email, [R('Editors')]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.user.id, u.id);
    assert.equal(r.body.user.auth_provider, 'microsoft', 'linked');
    assert.deepEqual(await memberships(u.id), [`ws:${W1}:workspace_editor:entra`, `ws:${W2}:workspace_viewer:manual`].sort());
  } finally {
    await setSsoOnly(O, false);
  }
});

test('a forced sync failure -> 503 ROLE_SYNC_FAILED, no session token, nothing changed', async () => {
  const email = newEmail('ref7sifail');
  const u = (await msSignIn(email, [R('Editors')])).body.user;
  const before = await memberships(u.id);
  const auditBefore = (await syncAudit(u.id)).length;

  const realTransaction = app.db.transaction;
  let wrote = 0;
  app.db.transaction = (fn) =>
    realTransaction(async (tx) =>
      fn({
        exec: tx.exec,
        prepare(sql) {
          const st = tx.prepare(sql);
          if (!/^(INSERT|DELETE)/.test(sql)) return st;
          // Let the first write (the org_admin INSERT) run, then fail the DELETE.
          return { ...st, run: async (...a) => { if (wrote++ > 0) throw new Error('forced sync failure'); return st.run(...a); } };
        },
      }),
    );
  let r;
  try {
    r = await msSignIn(email, [R('Admins')]); // would add org_admin and remove W1
  } finally {
    app.db.transaction = realTransaction;
  }
  assert.equal(wrote, 2, 'the INSERT ran, then the DELETE failed');
  assert.equal(r.status, 503);
  assert.deepEqual(r.body, ROLE_SYNC_FAILED, 'no token, no user in the body');
  assert.deepEqual(await memberships(u.id), before, 'rolled back');
  assert.equal((await syncAudit(u.id)).length, auditBefore);
  // With the fault gone, the same sign-in succeeds.
  const ok = await msSignIn(email, [R('Admins')]);
  assert.equal(ok.status, 200);
  assert.deepEqual(await memberships(u.id), [`org:${O}:org_admin:entra`]);
});

test('a deactivated user is still refused BEFORE any sync', async () => {
  const email = newEmail('ref7sideact');
  const u = (await msSignIn(email, [])).body.user;
  await app.db.prepare('UPDATE users SET deactivated_at = UNIX_TIMESTAMP() WHERE id = ?').run(u.id);
  const r = await msSignIn(email, [R('Editors'), R('Admins')]);
  assert.equal(r.status, 403);
  assert.deepEqual(r.body, { error: ACCOUNT_DEACTIVATED_MESSAGE });
  assert.deepEqual(await memberships(u.id), []);
  assert.equal((await syncAudit(u.id)).length, 0);
});

// ===================== manual takeover =====================

test('manual takeover: workspace member role change sets source NULL; later syncs leave it alone', async () => {
  const email = newEmail('ref7sitakews');
  const u = (await msSignIn(email, [R('Editors')])).body.user;
  assert.deepEqual(await memberships(u.id), [`ws:${W1}:workspace_editor:entra`]);
  const put = await j('PUT', `/api/workspaces/${W1}/members/${u.id}`, { token: owner.token, body: { role: 'workspace_viewer' } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.deepEqual(await memberships(u.id), [`ws:${W1}:workspace_viewer:manual`]);

  assert.equal((await msSignIn(email, [R('Editors')])).status, 200);
  assert.deepEqual(await memberships(u.id), [`ws:${W1}:workspace_viewer:manual`], 'not promoted back');
  assert.equal((await syncAudit(u.id)).length, 1, 'only the original add; the skip-only sync wrote nothing');
  assert.equal((await msSignIn(email, [])).status, 200);
  assert.deepEqual(await memberships(u.id), [`ws:${W1}:workspace_viewer:manual`], 'not removed');
});

test('manual takeover: org member role change sets source NULL; later syncs leave it alone', async () => {
  const email = newEmail('ref7sitakeorg');
  const u = (await msSignIn(email, [R('Admins')])).body.user;
  assert.deepEqual(await memberships(u.id), [`org:${O}:org_admin:entra`]);
  const put = await j('PUT', `/api/organizations/${O}/members/${u.id}`, { token: owner.token, body: { role: 'org_admin' } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.deepEqual(await memberships(u.id), [`org:${O}:org_admin:manual`]);
  assert.equal((await msSignIn(email, [])).status, 200);
  assert.deepEqual(await memberships(u.id), [`org:${O}:org_admin:manual`]);
});

test('manual takeover: platform admin re-add and role change (admin.js) set source NULL', async () => {
  const email = newEmail('ref7sitakeadm');
  const u = (await msSignIn(email, [R('Editors'), R('W2Admins')])).body.user;
  assert.deepEqual(await memberships(u.id), [`ws:${W1}:workspace_editor:entra`, `ws:${W2}:workspace_admin:entra`].sort());

  const add = await j('POST', `/api/admin/users/${u.id}/workspaces`, { token: platAdmin.token, body: { workspaceId: W1, role: 'workspace_editor' } });
  assert.equal(add.status, 200, JSON.stringify(add.body));
  const put = await j('PUT', `/api/admin/users/${u.id}/workspaces/${W2}`, { token: platAdmin.token, body: { role: 'workspace_viewer' } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.deepEqual(await memberships(u.id), [`ws:${W1}:workspace_editor:manual`, `ws:${W2}:workspace_viewer:manual`].sort());

  assert.equal((await msSignIn(email, [])).status, 200);
  assert.deepEqual(await memberships(u.id), [`ws:${W1}:workspace_editor:manual`, `ws:${W2}:workspace_viewer:manual`].sort());
});
