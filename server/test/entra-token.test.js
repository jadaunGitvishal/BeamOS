'use strict';

// Ref 9: unit tests for the Entra ID Service Principal JWT validation logic
// (middleware/entraToken.js), run against a realistic self-signed RS256 token
// matching Entra's exact claim shape - NOT against a real Entra tenant (see
// docs/entra-auth.md's "What this does and doesn't prove" section for the
// honest split between what these tests verify and what still needs a real
// tenant).
//
// Every positive/negative case below calls the REAL, unmodified
// verifyEntraAccessToken() from middleware/entraToken.js - the only thing
// swapped out is WHERE the trust anchors (JWKS/issuer/audience) come from
// (a local, in-memory JWKS instead of a live HTTPS fetch to
// login.microsoftonline.com), via the `overrides` parameter that function
// exists to support. The signature/issuer/audience/algorithm/idtyp checks
// exercised here are the exact production code path.

const test = require('node:test');
const assert = require('node:assert/strict');
const jose = require('jose');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-entra-token';

const { verifyEntraAccessToken, looksLikeEntraToken } = require('../middleware/entraToken');
const { tokenScopeGate, requireScope, agencyGate, requireBillingRead } = require('../middleware/apiToken');

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const AUDIENCE = '22222222-2222-2222-2222-222222222222';   // our app registration's own client ID
const CLIENT_ID = '33333333-3333-3333-3333-333333333333';  // the calling Service Principal's azp
const ISSUER = `https://login.microsoftonline.com/${TENANT_ID}/v2.0`;
const KID = 'test-signing-key';

let privateKey, localJwks, publicPem;

test.before(async () => {
  const kp = await jose.generateKeyPair('RS256', { extractable: true });
  privateKey = kp.privateKey;
  const jwk = await jose.exportJWK(kp.publicKey);
  localJwks = jose.createLocalJWKSet({ keys: [{ ...jwk, kid: KID, use: 'sig', alg: 'RS256' }] });
  publicPem = await jose.exportSPKI(kp.publicKey);
});

function baseClaims(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: ISSUER,
    aud: AUDIENCE,
    azp: CLIENT_ID,
    idtyp: 'app',
    ver: '2.0',
    tid: TENANT_ID,
    iat: now,
    nbf: now,
    exp: now + 3600,
    ...overrides,
  };
}

async function signValid(claimOverrides = {}, headerOverrides = {}) {
  return new jose.SignJWT(baseClaims(claimOverrides))
    .setProtectedHeader({ alg: 'RS256', kid: KID, typ: 'JWT', ...headerOverrides })
    .sign(privateKey);
}

const trust = () => ({ jwks: localJwks, issuer: ISSUER, audience: AUDIENCE });

// ===================== positive case =====================

test('verifyEntraAccessToken: a realistic, correctly-shaped Entra app-only token is accepted, azp extracted', async () => {
  const token = await signValid();
  const { clientId, payload } = await verifyEntraAccessToken(token, trust());
  assert.equal(clientId, CLIENT_ID);
  assert.equal(payload.idtyp, 'app');
  assert.equal(payload.iss, ISSUER);
});

test('verifyEntraAccessToken: falls back to appid when azp is absent (v1.0-token shape)', async () => {
  const token = await new jose.SignJWT({ ...baseClaims(), azp: undefined, appid: CLIENT_ID })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .sign(privateKey);
  const { clientId } = await verifyEntraAccessToken(token, trust());
  assert.equal(clientId, CLIENT_ID);
});

// ===================== negative cases =====================

test('verifyEntraAccessToken: wrong issuer is rejected', async () => {
  const token = await signValid({ iss: 'https://login.microsoftonline.com/99999999-9999-9999-9999-999999999999/v2.0' });
  await assert.rejects(() => verifyEntraAccessToken(token, trust()));
});

test('verifyEntraAccessToken: wrong audience is rejected (confused-deputy guard)', async () => {
  const token = await signValid({ aud: '44444444-4444-4444-4444-444444444444' });
  await assert.rejects(() => verifyEntraAccessToken(token, trust()));
});

test('verifyEntraAccessToken: expired token is rejected', async () => {
  const now = Math.floor(Date.now() / 1000);
  const token = await signValid({ iat: now - 7200, nbf: now - 7200, exp: now - 3600 });
  await assert.rejects(() => verifyEntraAccessToken(token, trust()));
});

test('verifyEntraAccessToken: idtyp="user" (delegated token) is rejected even with a matching azp', async () => {
  const token = await signValid({ idtyp: 'user' });
  await assert.rejects(
    () => verifyEntraAccessToken(token, trust()),
    /not an app-only/,
  );
});

test('verifyEntraAccessToken: missing idtyp entirely is rejected (fails closed, not "unknown, allow")', async () => {
  const token = await signValid({ idtyp: undefined });
  await assert.rejects(
    () => verifyEntraAccessToken(token, trust()),
    /not an app-only/,
  );
});

test('verifyEntraAccessToken: missing azp/appid is rejected', async () => {
  const token = await signValid({ azp: undefined });
  await assert.rejects(
    () => verifyEntraAccessToken(token, trust()),
    /no azp\/appid/,
  );
});

// ===================== the algorithm-confusion class of attack =====================
// These are the exact vulnerability the security review asked to see proven, not
// just cited from jose's docs. Real bytes, real (mis)signed tokens, real rejection.

test('verifyEntraAccessToken: alg:"none" (unsecured JWT) is rejected', async () => {
  const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const forged = `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(baseClaims())}.`;
  await assert.rejects(() => verifyEntraAccessToken(forged, trust()));
});

test('verifyEntraAccessToken: RS256->HS256 algorithm-confusion attack is rejected (public key used as an HMAC secret)', async () => {
  // The classic attack: an attacker who knows the RSA PUBLIC key (it's public by
  // definition) signs a forged token with alg:HS256, using that public key's PEM
  // bytes AS the HMAC secret - hoping a naive verifier fetches "the key" for the
  // kid and blindly uses it for whatever alg the attacker's header claims.
  const forgedPayload = baseClaims({ azp: 'attacker-controlled-client-id' });
  const hsSecret = new TextEncoder().encode(publicPem);
  const forged = await new jose.SignJWT(forgedPayload)
    .setProtectedHeader({ alg: 'HS256', kid: KID })
    .sign(hsSecret);
  await assert.rejects(() => verifyEntraAccessToken(forged, trust()));
});

test('verifyEntraAccessToken: HS256 confusion is rejected even WITHOUT an explicit algorithms allowlist (key-type binding alone stops it)', async () => {
  // Defense in depth, isolated: entraToken.js always passes algorithms:['RS256'],
  // but this proves the protection doesn't depend SOLELY on remembering that -
  // jose's local/remote JWKS resolver only ever vends the RSA key for this kid,
  // so an HS256 header can never resolve to a usable verification key at all.
  const hsSecret = new TextEncoder().encode(publicPem);
  const forged = await new jose.SignJWT(baseClaims())
    .setProtectedHeader({ alg: 'HS256', kid: KID })
    .sign(hsSecret);
  await assert.rejects(() => jose.jwtVerify(forged, localJwks, { issuer: ISSUER, audience: AUDIENCE }));
});

test('verifyEntraAccessToken: unknown kid (no matching key in the JWKS) is rejected', async () => {
  const token = await new jose.SignJWT(baseClaims())
    .setProtectedHeader({ alg: 'RS256', kid: 'a-kid-not-in-our-jwks' })
    .sign(privateKey);
  await assert.rejects(() => verifyEntraAccessToken(token, trust()));
});

// ===================== looksLikeEntraToken: routing discriminator =====================

test('looksLikeEntraToken: true for a token whose iss is an Entra authority host', async () => {
  const token = await signValid();
  assert.equal(looksLikeEntraToken(token), true);
});

test('looksLikeEntraToken: false for our own session JWT shape (HS256, no iss claim at all)', () => {
  const jwt = require('jsonwebtoken');
  const ours = jwt.sign({ id: 'u1', email: 'a@b.com', role: 'user' }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
  assert.equal(looksLikeEntraToken(ours), false);
});

test('looksLikeEntraToken: false for garbage / non-JWT input', () => {
  assert.equal(looksLikeEntraToken('not-a-jwt-at-all'), false);
  assert.equal(looksLikeEntraToken(''), false);
  assert.equal(looksLikeEntraToken('st_abc123'), false);
});

test('looksLikeEntraToken: false for a well-formed JWT with an unrelated issuer', async () => {
  const token = await new jose.SignJWT({ iss: 'https://accounts.google.com', sub: 'x' })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .sign(privateKey);
  assert.equal(looksLikeEntraToken(token), false);
});

// ===================== scope-enforcement reuse: identical to an st_ token =====================
// These call the SAME tokenScopeGate/requireScope/agencyGate/requireBillingRead
// functions api_tokens uses (middleware/apiToken.js) - not reimplementations. They
// only ever read req.viaToken/req.tokenScope, which is exactly the shape
// entraTokenAuth() sets, so this proves a validated Service Principal gets IDENTICAL
// scope enforcement to an equivalent st_ token, by construction, not by
// coincidence-prone duplicated logic.

function fakeReq(scope, method = 'GET') {
  return { viaToken: true, tokenScope: scope, method };
}
function fakeRes() {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

test('scope reuse: a "read"-scope Entra request may GET but not POST (same as a read st_ token)', () => {
  let nextCalled = false;
  tokenScopeGate(fakeReq('read', 'GET'), fakeRes(), () => { nextCalled = true; });
  assert.equal(nextCalled, true);

  nextCalled = false;
  const res = fakeRes();
  tokenScopeGate(fakeReq('read', 'POST'), res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});

test('scope reuse: a "write"-scope Entra request may POST but requireScope("full") still blocks it', () => {
  let nextCalled = false;
  tokenScopeGate(fakeReq('write', 'POST'), fakeRes(), () => { nextCalled = true; });
  assert.equal(nextCalled, true);

  nextCalled = false;
  const res = fakeRes();
  requireScope('full')(fakeReq('write', 'POST'), res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});

test('scope reuse: a "full"-scope Entra request passes requireScope("full")', () => {
  let nextCalled = false;
  requireScope('full')(fakeReq('full', 'POST'), fakeRes(), () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test('scope reuse: an "agency"-scope Entra request is rejected by the read/write/full ladder (off-ladder, same as an agency st_ token)', () => {
  const res = fakeRes();
  let nextCalled = false;
  tokenScopeGate(fakeReq('agency', 'GET'), res, () => { nextCalled = true; });
  // 'agency' has no SCOPE_RANK entry, so scopeAllows() is always false against it.
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});

test('scope reuse: only an "agency"-scope Entra request passes agencyGate', () => {
  let nextCalled = false;
  agencyGate(fakeReq('agency'), fakeRes(), () => { nextCalled = true; });
  assert.equal(nextCalled, true);

  nextCalled = false;
  const res = fakeRes();
  agencyGate(fakeReq('full'), res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});

test('scope reuse: only a "billing:read"-scope Entra request passes requireBillingRead (as a token, no admin session)', () => {
  let nextCalled = false;
  requireBillingRead(fakeReq('billing:read'), fakeRes(), () => { nextCalled = true; });
  assert.equal(nextCalled, true);

  nextCalled = false;
  const res = fakeRes();
  requireBillingRead(fakeReq('full'), res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});
