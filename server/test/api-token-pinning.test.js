'use strict';

// API tokens and Entra service principals are pinned to their bound workspace
// (lib/tenancy.js resolveTenancy, req.viaToken branch). When the owner (or the
// SP's registering admin) loses access to it, every request is refused with
// 403 TOKEN_WORKSPACE_ACCESS_LOST - never re-pointed at another workspace the
// owner can still reach - and the token keeps working once access is restored.
// Session requests keep their stale-current-workspace fallback.
//
// Real HTTP against the REAL MySQL database (helpers/inprocess-app.js mounts
// every router server.js mounts). Entra SP tokens are self-signed with a local
// RSA key; only the JWKS fetch is intercepted, as in entra-token-integration.
// test.js. Disposable, randomly tagged fixtures, deleted in after(). Audit rows
// written here stay (activity_log is hash-chained, Ref 17).

const crypto = require('node:crypto');

const TENANT_ID = crypto.randomUUID();
const AUDIENCE = crypto.randomUUID();
process.env.ENTRA_TENANT_ID = TENANT_ID;
process.env.ENTRA_API_CLIENT_ID = AUDIENCE;

const test = require('node:test');
const assert = require('node:assert/strict');
const jose = require('jose');

const { initDb } = require('../db/database');
const { deleteUserCascade } = require('../lib/user-deletion');
const { startInProcessApp } = require('./helpers/inprocess-app');
const { randTag, cleanupUsers } = require('./helpers/disposable');

const TAG = randTag();
const PASSWORD = 'pin-test-pass-1';
const DAY = 86400;
const LOST = { code: 'TOKEN_WORKSPACE_ACCESS_LOST', error: "This API token's workspace is no longer accessible to its owner" };

let app;
const cleanup = [];
let owner, user, admin, rv;
const R = {}; // region ids
const W = {}; // workspace ids
const D = {}; // device id per workspace key
const devName = (k) => `pin-dev-${k}-${TAG}`;
let tokenA, rvToken, sp, sessionA;

// ---- Entra: real RSA keypair, self-signed app-only token, JWKS fetch intercepted ----
let privateKey, jwksDoc;
const SP_CLIENT_ID = crypto.randomUUID();
const JWKS_URL = `https://login.microsoftonline.com/${TENANT_ID}/discovery/v2.0/keys`;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url === JWKS_URL) {
    return new Response(JSON.stringify(jwksDoc), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(input, init);
};
function signSpToken() {
  const now = Math.floor(Date.now() / 1000);
  return new jose.SignJWT({
    iss: `https://login.microsoftonline.com/${TENANT_ID}/v2.0`,
    aud: AUDIENCE, azp: SP_CLIENT_ID, idtyp: 'app', iat: now, nbf: now, exp: now + 3600,
  }).setProtectedHeader({ alg: 'RS256', kid: 'pin-kid' }).sign(privateKey);
}

async function j(method, path, { token, body, ws } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (ws) headers['X-Workspace-Id'] = ws;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${app.base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed, text, headers: res.headers };
}

async function registerUser(prefix, createOrg = false) {
  const email = `${prefix}-${randTag()}@pin.local`;
  const r = await j('POST', '/api/auth/register', { body: { email, password: PASSWORD, name: prefix, createOrg } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  cleanup.push(r.body.user.id);
  const ws = r.body.current_workspace_id
    ? await app.db.prepare('SELECT organization_id FROM workspaces WHERE id = ?').get(r.body.current_workspace_id)
    : null;
  return { id: r.body.user.id, email, token: r.body.token, orgId: ws?.organization_id };
}

const addMember = (wsKey, userId, role, joinedAt) =>
  app.db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)').run(W[wsKey], userId, role, joinedAt);
const removeMember = (wsKey, userId) =>
  app.db.prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?').run(W[wsKey], userId);
const setRegion = (wsKey, regionKey) =>
  app.db.prepare('UPDATE workspaces SET region_id = ? WHERE id = ?').run(R[regionKey], W[wsKey]);
async function setScopes(regionKeys) {
  const r = await j('PUT', `/api/organizations/${owner.orgId}/members/${rv.id}/region-scopes`, { token: owner.token, body: { region_ids: regionKeys.map((k) => R[k]) } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
}
async function mint(sessionToken, wsKey, scope = 'write', name = 'pin test') {
  const r = await j('POST', '/api/tokens', { token: sessionToken, ws: W[wsKey], body: { name, scope } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}
const devicesSeen = (body) => (Array.isArray(body) ? body.map((d) => d.id).sort() : []);
// The refusal must carry nothing from any workspace: exact body, and no device id/name anywhere.
function assertLostNoLeak(r, label) {
  assert.equal(r.status, 403, `${label}: ${r.text}`);
  assert.deepEqual(r.body, LOST, label);
  for (const k of Object.keys(D)) {
    assert.ok(!r.text.includes(D[k]) && !r.text.includes(devName(k)), `${label}: leaked ${k}`);
  }
}

// Audit: run one request and return every activity_log row written after it.
// logActivity is fire-and-forget, so first let earlier writes (e.g. fixture setup
// done through the API) land, then wait for the first row plus a grace period.
async function auditOf(fn) {
  const maxId = async () => (await app.db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM activity_log').get()).m;
  let m = await maxId();
  for (let i = 0; i < 20; i++) {
    await new Promise((res) => setTimeout(res, 250));
    const now = await maxId();
    if (now === m) break;
    m = now;
  }
  const r = await fn();
  const rows = () => app.db.prepare('SELECT user_id, action FROM activity_log WHERE id > ? ORDER BY id').all(m);
  for (let i = 0; i < 40 && (await rows()).length === 0; i++) await new Promise((res) => setTimeout(res, 50));
  await new Promise((res) => setTimeout(res, 400));
  return { r, audit: await rows() };
}
async function assertRefusedAudited(fn, ownerId, method, label) {
  const { r, audit } = await auditOf(fn);
  assertLostNoLeak(r, label);
  assert.equal(audit.length, 1, `${label}: exactly one audit row, got ${JSON.stringify(audit)} owner=${ownerId}`);
  assert.equal(audit[0].user_id, ownerId, `${label}: audit user is the token owner`);
  assert.match(audit[0].action, new RegExp(`^ACCESS_DENIED ${method} `), label);
}

test.before(async () => {
  const kp = await jose.generateKeyPair('RS256', { extractable: true });
  privateKey = kp.privateKey;
  jwksDoc = { keys: [{ ...(await jose.exportJWK(kp.publicKey)), kid: 'pin-kid', use: 'sig', alg: 'RS256' }] };

  await initDb();
  app = await startInProcessApp();
  owner = await registerUser('pinown', true);

  for (const [key, level] of [['IN', 'region'], ['IN2', 'region'], ['OUT', 'region']]) {
    const r = await j('POST', `/api/organizations/${owner.orgId}/regions`, { token: owner.token, body: { name: `pin-${key}-${TAG}`, level } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    R[key] = r.body.id;
  }
  // A, B: the drift pair. S1, S2: the regional viewer's two in-scope workspaces.
  for (const [key, regionKey] of [['A', null], ['B', null], ['S1', 'IN'], ['S2', 'IN2']]) {
    W[key] = crypto.randomUUID();
    await app.db.prepare('INSERT INTO workspaces (id, organization_id, name, region_id) VALUES (?, ?, ?, ?)')
      .run(W[key], owner.orgId, `pin-ws-${key}-${TAG}`, regionKey ? R[regionKey] : null);
    D[key] = crypto.randomUUID();
    await app.db.prepare("INSERT INTO devices (id, user_id, workspace_id, name, status, created_at) VALUES (?, ?, ?, ?, 'offline', UNIX_TIMESTAMP())")
      .run(D[key], owner.id, W[key], devName(key));
  }

  // Token owner: editor in A and in B (A joined first), nothing else.
  user = await registerUser('pinuser');
  await addMember('A', user.id, 'workspace_editor', 100);
  await addMember('B', user.id, 'workspace_editor', 200);
  const own = await app.db.prepare('SELECT workspace_id FROM workspace_members WHERE user_id = ?').all(user.id);
  assert.deepEqual(own.map((x) => x.workspace_id).sort(), [W.A, W.B].sort(), 'owner reaches exactly A and B');
  tokenA = await mint(user.token, 'A');
  assert.equal(tokenA.workspace_id, W.A);
  const sw = await j('POST', '/api/auth/switch-workspace', { token: user.token, body: { workspace_id: W.A } });
  assert.equal(sw.status, 200, JSON.stringify(sw.body));
  sessionA = sw.body.token; // a session whose current_workspace_id is A

  // Entra SP registered by a platform admin who is a member of A and B.
  admin = await registerUser('pinadmin');
  await app.db.prepare("UPDATE users SET role = 'platform_admin' WHERE id = ?").run(admin.id);
  await addMember('A', admin.id, 'workspace_admin', 100);
  await addMember('B', admin.id, 'workspace_admin', 200);
  const reg = await j('POST', '/api/admin/entra-service-principals', { token: admin.token, body: { client_id: SP_CLIENT_ID, name: `pin-sp-${TAG}`, workspace_id: W.A, scope: 'write' } });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  sp = reg.body;

  // Regional viewer scoped to IN and IN2 (S1 and S2). Viewers can't mint, so the
  // token comes from a direct editor row in S1, which is then removed: the token
  // keeps reaching S1 read-only through the regional scope.
  rv = await registerUser('pinrv');
  await app.db.prepare("INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'regional_viewer')").run(owner.orgId, rv.id);
  await setScopes(['IN', 'IN2']);
  await addMember('S1', rv.id, 'workspace_editor', 100);
  rvToken = await mint(rv.token, 'S1', 'read');
  await removeMember('S1', rv.id);
});

test.after(async () => {
  try {
    if (sp) await app.db.prepare('DELETE FROM entra_service_principals WHERE id = ?').run(sp.id);
    await app.db.prepare('UPDATE organizations SET max_token_lifetime_days = NULL WHERE id = ?').run(owner.orgId);
  } catch { /* best-effort */ }
  // members first, the org owner (and with it the org, its workspaces, devices, tokens) last
  await cleanupUsers(app.db, [...cleanup.filter((id) => id !== owner.id).reverse(), owner.id]);
  const left = await app.db.prepare(`SELECT COUNT(*) AS n FROM workspaces WHERE id IN (${Object.keys(W).map(() => '?').join(',')})`).get(...Object.values(W));
  assert.equal(left.n, 0, 'fixture workspaces cleaned up');
  globalThis.fetch = realFetch;
  await app.stop();
});

// ------------------------------------------------------------- unchanged paths

test('unchanged: a token with access works, and X-Workspace-Id / ?workspace_id pointing at B are ignored', async () => {
  const plain = await j('GET', '/api/devices', { token: tokenA.token });
  assert.equal(plain.status, 200, plain.text);
  assert.deepEqual(devicesSeen(plain.body), [D.A]);
  const viaHeader = await j('GET', '/api/devices', { token: tokenA.token, ws: W.B });
  assert.equal(viaHeader.status, 200);
  assert.deepEqual(devicesSeen(viaHeader.body), [D.A]);
  const viaQuery = await j('GET', `/api/devices?workspace_id=${W.B}`, { token: tokenA.token });
  assert.equal(viaQuery.status, 200);
  assert.deepEqual(devicesSeen(viaQuery.body), [D.A]);

  const spTok = await signSpToken();
  const spRes = await j('GET', '/api/devices', { token: spTok, ws: W.B });
  assert.equal(spRes.status, 200, spRes.text);
  assert.deepEqual(devicesSeen(spRes.body), [D.A]);

  const rvRes = await j('GET', '/api/devices', { token: rvToken.token });
  assert.equal(rvRes.status, 200, rvRes.text);
  assert.deepEqual(devicesSeen(rvRes.body), [D.S1]);
});

test('unchanged: revoked, expired (Ref 34), deactivated-owner and deleted-owner tokens', async () => {
  const revoked = await mint(user.token, 'A', 'read', 'pin revoked');
  assert.equal((await j('DELETE', `/api/tokens/${revoked.id}`, { token: user.token })).status, 200);
  const r1 = await j('GET', '/api/devices', { token: revoked.token });
  assert.equal(r1.status, 401);
  assert.deepEqual(r1.body, { error: 'Invalid or revoked API token' });

  const old = await mint(user.token, 'A', 'read', 'pin expired');
  await app.db.prepare('UPDATE api_tokens SET created_at = UNIX_TIMESTAMP() - ? WHERE id = ?').run(40 * DAY, old.id);
  await app.db.prepare('UPDATE organizations SET max_token_lifetime_days = 30 WHERE id = ?').run(owner.orgId);
  try {
    const r2 = await j('GET', '/api/devices', { token: old.token });
    assert.equal(r2.status, 401);
    assert.deepEqual(r2.body, { error: 'Invalid or expired API token' });
  } finally {
    await app.db.prepare('UPDATE organizations SET max_token_lifetime_days = NULL WHERE id = ?').run(owner.orgId);
  }

  const deact = await registerUser('pindeact');
  await addMember('A', deact.id, 'workspace_editor', 100);
  const deactTok = await mint(deact.token, 'A', 'read');
  await app.db.prepare('UPDATE users SET deactivated_at = UNIX_TIMESTAMP() WHERE id = ?').run(deact.id);
  const r3 = await j('GET', '/api/devices', { token: deactTok.token });
  assert.equal(r3.status, 401);
  assert.deepEqual(r3.body, { error: 'Token owner account is deactivated' });

  const gone = await registerUser('pingone');
  await addMember('A', gone.id, 'workspace_editor', 100);
  const goneTok = await mint(gone.token, 'A', 'read');
  await deleteUserCascade(app.db, { targetId: gone.id, actingAdminId: owner.id });
  const r4 = await j('GET', '/api/devices', { token: goneTok.token });
  assert.equal(r4.status, 401);
  assert.deepEqual(r4.body, { error: 'Invalid or revoked API token' }); // api_tokens cascade with the user
});

// ------------------------------------------------------------- drift: owner removed from A

test('owner removed from A (still in B): token refused 403 TOKEN_WORKSPACE_ACCESS_LOST, no B data, writes change nothing, each refusal audited once', async () => {
  await removeMember('A', user.id);
  try {
    const playlistName = `pin-pl-${TAG}`;
    const tok = tokenA.token;
    await assertRefusedAudited(() => j('GET', '/api/devices', { token: tok }), user.id, 'GET', 'GET devices');
    await assertRefusedAudited(() => j('GET', '/api/devices', { token: tok, ws: W.B }), user.id, 'GET', 'GET devices, header B');
    await assertRefusedAudited(() => j('GET', `/api/devices?workspace_id=${W.B}`, { token: tok }), user.id, 'GET', 'GET devices, ?workspace_id=B');
    await assertRefusedAudited(() => j('GET', '/api/activity', { token: tok }), user.id, 'GET', 'GET activity (READ-audited route)');
    await assertRefusedAudited(() => j('GET', '/api/reports/export?format=csv', { token: tok }), user.id, 'GET', 'GET export');
    await assertRefusedAudited(() => j('POST', '/api/playlists', { token: tok, body: { name: playlistName } }), user.id, 'POST', 'POST playlist');
    await assertRefusedAudited(() => j('PUT', `/api/devices/${D.A}`, { token: tok, body: { name: 'pin-hijack' } }), user.id, 'PUT', 'PUT device A');
    await assertRefusedAudited(() => j('PUT', `/api/devices/${D.B}`, { token: tok, body: { name: 'pin-hijack' } }), user.id, 'PUT', 'PUT device B');

    const pl = await app.db.prepare('SELECT COUNT(*) AS n FROM playlists WHERE name = ? OR workspace_id IN (?, ?)').get(playlistName, W.A, W.B);
    assert.equal(pl.n, 0, 'no playlist created in A or B');
    for (const k of ['A', 'B']) {
      const d = await app.db.prepare('SELECT name FROM devices WHERE id = ?').get(D[k]);
      assert.equal(d.name, devName(k), `device ${k} unchanged`);
    }
  } finally {
    await addMember('A', user.id, 'workspace_editor', 100);
  }
});

test('unchanged: a SESSION with a stale current_workspace_id (A) still falls back to the first accessible workspace (B)', async () => {
  await removeMember('A', user.id);
  try {
    const sess = await j('GET', '/api/devices', { token: sessionA });
    assert.equal(sess.status, 200, sess.text);
    assert.deepEqual(devicesSeen(sess.body), [D.B]);
  } finally {
    await addMember('A', user.id, 'workspace_editor', 100);
  }
});

test('restoration: the SAME token works again (200, A data) and was never revoked', async () => {
  const r = await j('GET', '/api/devices', { token: tokenA.token });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(devicesSeen(r.body), [D.A]);
  const row = await app.db.prepare('SELECT revoked_at FROM api_tokens WHERE id = ?').get(tokenA.id);
  assert.equal(row.revoked_at, null);
});

// ------------------------------------------------------------- drift: regional scope

test('regional viewer: bound workspace moved out of scope -> 403, no data from the other in-scope workspace; back in scope -> 200', async () => {
  await setRegion('S1', 'OUT');
  try {
    await assertRefusedAudited(() => j('GET', '/api/devices', { token: rvToken.token }), rv.id, 'GET', 'S1 moved out of scope');
  } finally {
    await setRegion('S1', 'IN');
  }
  const back = await j('GET', '/api/devices', { token: rvToken.token });
  assert.equal(back.status, 200, back.text);
  assert.deepEqual(devicesSeen(back.body), [D.S1]);
});

test('regional viewer: scope covering the bound workspace removed -> 403, no data from the remaining in-scope workspace; scope restored -> 200', async () => {
  await setScopes(['IN2']);
  try {
    await assertRefusedAudited(() => j('GET', '/api/devices', { token: rvToken.token }), rv.id, 'GET', 'IN scope removed');
  } finally {
    await setScopes(['IN', 'IN2']);
  }
  const back = await j('GET', '/api/devices', { token: rvToken.token });
  assert.equal(back.status, 200, back.text);
  assert.deepEqual(devicesSeen(back.body), [D.S1]);
  const row = await app.db.prepare('SELECT revoked_at FROM api_tokens WHERE id = ?').get(rvToken.id);
  assert.equal(row.revoked_at, null);
});

// ------------------------------------------------------------- drift: Entra service principal

test('Entra SP: registering admin loses access to A -> 403, no B data, audited against the admin; restored -> 200 A, registration not revoked', async () => {
  await removeMember('A', admin.id);
  try {
    const spTok = await signSpToken();
    await assertRefusedAudited(() => j('GET', '/api/devices', { token: spTok }), admin.id, 'GET', 'SP GET');
    await assertRefusedAudited(() => j('POST', '/api/playlists', { token: spTok, body: { name: `pin-sp-pl-${TAG}` } }), admin.id, 'POST', 'SP POST');
    const pl = await app.db.prepare('SELECT COUNT(*) AS n FROM playlists WHERE name = ?').get(`pin-sp-pl-${TAG}`);
    assert.equal(pl.n, 0);
  } finally {
    await addMember('A', admin.id, 'workspace_admin', 100);
  }
  const r = await j('GET', '/api/devices', { token: await signSpToken() });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(devicesSeen(r.body), [D.A]);
  const row = await app.db.prepare('SELECT revoked_at FROM entra_service_principals WHERE id = ?').get(sp.id);
  assert.equal(row.revoked_at, null);
});
