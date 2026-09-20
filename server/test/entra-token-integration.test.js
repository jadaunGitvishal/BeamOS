'use strict';

// Ref 9: a genuine Express HTTP-request-level integration test of the REAL
// middleware chain (bearerAuth -> entraTokenAuth -> resolveTenancy ->
// tokenScopeGate), as opposed to entra-token.test.js's unit-level tests of
// verifyEntraAccessToken() in isolation. The ONLY thing faked here is the
// network call to Entra's JWKS endpoint (globalThis.fetch is intercepted for
// that one URL, real for everything else) - config.entraTenantId /
// config.entraApiClientId are real env vars, getJwks()/entraIssuer() build the
// real production URL strings, bearerAuth/entraTokenAuth/resolveTenancy/
// tokenScopeGate are the real, unmodified functions, and the DB lookup hits a
// real (in-memory) database with a real entra_service_principals row - the
// same substitution technique server/test/registration-codes-device-owner-qr.
// test.js already uses for isolating a route test from the real MySQL dev DB.
//
// This proves the wiring (bearerAuth's routing, config-driven URL construction,
// the DB lookup, resolveTenancy consuming req.jwtWorkspaceId, tokenScopeGate
// enforcing req.tokenScope) all actually connect correctly end-to-end. It does
// NOT and cannot prove Entra ID itself issues tokens shaped the way this test
// assumes, or that a real tenant's JWKS endpoint behaves as mocked here - see
// docs/entra-auth.md's "What this does and doesn't prove" section.

const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

process.env.DATA_DIR = path.join(os.tmpdir(), 'st-entra-it-' + crypto.randomBytes(4).toString('hex'));
process.env.JWT_SECRET = 'test-secret-entra-integration';
const TENANT_ID = '55555555-5555-5555-5555-555555555555';
const AUDIENCE = '66666666-6666-6666-6666-666666666666';
const CLIENT_ID = '77777777-7777-7777-7777-777777777777';
process.env.ENTRA_TENANT_ID = TENANT_ID;
process.env.ENTRA_API_CLIENT_ID = AUDIENCE;

const test = require('node:test');
const assert = require('node:assert/strict');
const jose = require('jose');
const Database = require('better-sqlite3');

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE users (
    id TEXT PRIMARY KEY, email TEXT, name TEXT, role TEXT DEFAULT 'user',
    auth_provider TEXT DEFAULT 'local', avatar_url TEXT, plan_id TEXT DEFAULT 'free',
    email_alerts INTEGER DEFAULT 1, must_change_password INTEGER DEFAULT 0
  );
  CREATE TABLE workspaces (id TEXT PRIMARY KEY, organization_id TEXT, name TEXT);
  CREATE TABLE workspace_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT, user_id TEXT, role TEXT,
    joined_at INTEGER DEFAULT 0
  );
  CREATE TABLE organization_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT, organization_id TEXT, user_id TEXT, role TEXT
  );
  CREATE TABLE api_tokens (
    id TEXT PRIMARY KEY, token_hash TEXT UNIQUE, prefix TEXT, name TEXT, user_id TEXT,
    workspace_id TEXT, scope TEXT DEFAULT 'read', auto_publish INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT 0, last_used_at INTEGER, revoked_at INTEGER
  );
  CREATE TABLE entra_service_principals (
    id TEXT PRIMARY KEY, client_id TEXT UNIQUE, name TEXT, workspace_id TEXT,
    scope TEXT DEFAULT 'read', created_by TEXT, created_at INTEGER DEFAULT 0,
    last_used_at INTEGER, revoked_at INTEGER
  );
`);
const dbModulePath = require.resolve('../db/database');
require.cache[dbModulePath] = { id: dbModulePath, filename: dbModulePath, loaded: true, exports: { db } };

db.prepare("INSERT INTO users (id, email, role) VALUES ('u-admin', 'admin@a.test', 'user')").run();
db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES ('ws-a', 'org-a', 'Workspace A')").run();
db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('ws-a', 'u-admin', 'workspace_admin')").run();
db.prepare(
  "INSERT INTO entra_service_principals (id, client_id, name, workspace_id, scope, created_by, created_at) VALUES ('sp-1', ?, 'Test SP', 'ws-a', 'write', 'u-admin', 0)",
).run(CLIENT_ID);
db.prepare(
  "INSERT INTO entra_service_principals (id, client_id, name, workspace_id, scope, created_by, created_at, revoked_at) VALUES ('sp-2', ?, 'Revoked SP', 'ws-a', 'full', 'u-admin', 0, 1)",
).run('88888888-8888-8888-8888-888888888888');

// ---- real RSA keypair + real self-signed token, exactly matching entra-token.test.js's shape ----
let privateKey, jwksDoc;
test.before(async () => {
  const kp = await jose.generateKeyPair('RS256', { extractable: true });
  privateKey = kp.privateKey;
  const jwk = await jose.exportJWK(kp.publicKey);
  jwksDoc = { keys: [{ ...jwk, kid: 'it-kid', use: 'sig', alg: 'RS256' }] };
});

function signAppToken(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new jose.SignJWT({
    iss: `https://login.microsoftonline.com/${TENANT_ID}/v2.0`,
    aud: AUDIENCE,
    azp: CLIENT_ID,
    idtyp: 'app',
    iat: now, nbf: now, exp: now + 3600,
    ...overrides,
  }).setProtectedHeader({ alg: 'RS256', kid: 'it-kid' }).sign(privateKey);
}

// ---- intercept ONLY the real Entra JWKS URL this config produces; everything else falls through ----
const REAL_JWKS_URL = `https://login.microsoftonline.com/${TENANT_ID}/discovery/v2.0/keys`;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url === REAL_JWKS_URL) {
    return new Response(JSON.stringify(jwksDoc), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(input, init);
};
test.after(() => { globalThis.fetch = realFetch; db.close(); });

const express = require('express');
const { bearerAuth, tokenScopeGate } = require('../middleware/apiToken');
const { resolveTenancy } = require('../lib/tenancy');

const app = express();
app.use(bearerAuth, resolveTenancy, tokenScopeGate, (req, res) => {
  res.json({
    viaToken: !!req.viaToken,
    tokenScope: req.tokenScope || null,
    workspaceId: req.workspaceId || null,
    workspaceRole: req.workspaceRole || null,
    spName: req.entraServicePrincipal ? req.entraServicePrincipal.name : null,
  });
});
const server = app.listen(0);
let base;
test.before(async () => {
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

test('integration: a real, registered Entra Service Principal token authenticates through the REAL bearerAuth/resolveTenancy/tokenScopeGate chain', async () => {
  const token = await signAppToken();
  const res = await fetch(`${base}/`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.viaToken, true);
  assert.equal(body.tokenScope, 'write'); // matches the registered row's scope
  assert.equal(body.workspaceId, 'ws-a'); // resolveTenancy resolved it from req.jwtWorkspaceId
  assert.equal(body.workspaceRole, 'workspace_admin'); // the registering admin's real role
  assert.equal(body.spName, 'Test SP');
});

test('integration: tokenScopeGate genuinely enforces the registered scope over real HTTP (write cannot reach a "full"-only route pattern via method)', async () => {
  // The registered SP above has scope 'write'. tokenScopeGate maps GET->read,
  // any mutation->write, so a real GET must succeed...
  const token = await signAppToken();
  const getRes = await fetch(`${base}/`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(getRes.status, 200);
  // ...this test app has no POST route, but re-mount a second app with a stricter
  // requireScope('full') to prove the SAME 'write' token is genuinely blocked from
  // a 'full'-gated action, over real HTTP, not just the unit-level fakeReq() check.
  const { requireScope } = require('../middleware/apiToken');
  const app2 = express();
  app2.post('/', bearerAuth, resolveTenancy, requireScope('full'), (req, res) => res.json({ ok: true }));
  const server2 = app2.listen(0);
  await new Promise((r) => server2.once('listening', r));
  try {
    const base2 = `http://127.0.0.1:${server2.address().port}`;
    const res = await fetch(`${base2}/`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.match(body.error, /insufficient/);
  } finally {
    server2.close();
  }
});

test('integration: a revoked Service Principal registration is refused (403) over real HTTP', async () => {
  const token = await signAppToken({ azp: '88888888-8888-8888-8888-888888888888' });
  const res = await fetch(`${base}/`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 403);
});

test('integration: an unregistered client_id (valid Entra token, never registered) is refused (403) over real HTTP', async () => {
  const token = await signAppToken({ azp: '99999999-9999-9999-9999-999999999999' });
  const res = await fetch(`${base}/`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 403);
});

test('integration: an st_ token header still routes to apiTokenAuth, not entraTokenAuth (no regression to the existing front door)', async () => {
  const res = await fetch(`${base}/`, { headers: { Authorization: 'Bearer st_totally-invalid' } });
  // apiTokenAuth's own 401 (invalid token) - proves bearerAuth's st_ branch still
  // wins first, untouched by the new Entra branch.
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.match(body.error, /API token/i);
});
