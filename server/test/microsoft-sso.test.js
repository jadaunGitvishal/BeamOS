'use strict';

// Ref 5: OIDC id_token validation, tenant restriction and MFA enforcement on the
// "Sign in with Microsoft" login (routes/auth.js POST /microsoft).
//
// Two layers, same harness as Ref 9's tests:
//   1. Unit - the REAL verifyEntraIdToken() (middleware/entraToken.js) against
//      realistic self-signed RS256 id_tokens and a local JWKS, via the `overrides`
//      seam (identical technique to test/entra-token.test.js).
//   2. Route - the REAL routes/auth.js mounted in-process (helpers/inprocess-app.js)
//      against the REAL MySQL database. The only things faked are the two outbound
//      network calls: Entra's JWKS URL for the configured tenant (globalThis.fetch
//      intercepted for that one URL - same as test/entra-token-integration.test.js)
//      and Graph's /v1.0/me (https.get intercepted for graph.microsoft.com only), so
//      the tenant-unset fallback path can be proven unchanged without a real token.
//
// What this does NOT prove: that a real Entra tenant issues id_tokens with exactly
// these claims (notably `amr`, an opt-in optional claim in v2.0 tokens) - see
// docs/sso-scim-integration.md "What is and isn't verified".

const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const crypto = require('node:crypto');
const { PassThrough } = require('node:stream');
const jose = require('jose');

const config = require('../config');
const { verifyEntraIdToken } = require('../middleware/entraToken');
const { startInProcessApp } = require('./helpers/inprocess-app');
const { randTag, cleanupUsers } = require('./helpers/disposable');

const TENANT_ID = 'aaaaaaaa-1111-2222-3333-444444444444';
const OTHER_TENANT = 'bbbbbbbb-1111-2222-3333-444444444444';
const CLIENT_ID = 'cccccccc-1111-2222-3333-444444444444'; // MICROSOFT_CLIENT_ID (the SPA login app)
const ISSUER = `https://login.microsoftonline.com/${TENANT_ID}/v2.0`;
const KID = 'sso-test-kid';

let privateKey, localJwks, jwksDoc, publicPem;

test.before(async () => {
  const kp = await jose.generateKeyPair('RS256', { extractable: true });
  privateKey = kp.privateKey;
  const jwk = { ...(await jose.exportJWK(kp.publicKey)), kid: KID, use: 'sig', alg: 'RS256' };
  jwksDoc = { keys: [jwk] };
  localJwks = jose.createLocalJWKSet(jwksDoc);
  publicPem = await jose.exportSPKI(kp.publicKey);
});

// Claim shape per Microsoft's "ID token claims reference" for a v2.0 id_token.
function idClaims(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: ISSUER,
    aud: CLIENT_ID,
    tid: TENANT_ID,
    oid: '0a0a0a0a-0000-0000-0000-000000000001',
    sub: 'pairwise-subject',
    preferred_username: 'someone@contoso.test',
    name: 'Some One',
    ver: '2.0',
    nonce: 'n',
    iat: now,
    nbf: now,
    exp: now + 3600,
    ...overrides,
  };
}

function signIdToken(overrides = {}, header = {}) {
  return new jose.SignJWT(idClaims(overrides))
    .setProtectedHeader({ alg: 'RS256', kid: KID, typ: 'JWT', ...header })
    .sign(privateKey);
}

const trust = (extra = {}) => ({
  jwks: localJwks, tenantId: TENANT_ID, issuer: ISSUER, audience: CLIENT_ID, requireMfa: false, ...extra,
});

// ===================== 1. unit: verifyEntraIdToken =====================

test('verifyEntraIdToken: a correctly-shaped id_token for the configured tenant + audience is accepted', async () => {
  const token = await signIdToken({ email: 'Some.One@Contoso.test' });
  const r = await verifyEntraIdToken(token, trust());
  assert.equal(r.oid, '0a0a0a0a-0000-0000-0000-000000000001');
  assert.equal(r.name, 'Some One');
  // email first (lowercased), then preferred_username
  assert.deepEqual(r.emails, ['some.one@contoso.test', 'someone@contoso.test']);
});

test('verifyEntraIdToken: wrong tenant (another tenant\'s issuer) is rejected', async () => {
  const token = await signIdToken({
    iss: `https://login.microsoftonline.com/${OTHER_TENANT}/v2.0`, tid: OTHER_TENANT,
  });
  await assert.rejects(() => verifyEntraIdToken(token, trust()), /iss/);
});

test('verifyEntraIdToken: right issuer string but mismatched tid is rejected (defense in depth)', async () => {
  const token = await signIdToken({ tid: OTHER_TENANT });
  await assert.rejects(() => verifyEntraIdToken(token, trust()), /configured Entra tenant/);
});

test('verifyEntraIdToken: wrong audience (id_token minted for a different app) is rejected', async () => {
  const token = await signIdToken({ aud: 'dddddddd-1111-2222-3333-444444444444' });
  await assert.rejects(() => verifyEntraIdToken(token, trust()), /aud/);
});

test('verifyEntraIdToken: an unset MICROSOFT_CLIENT_ID fails closed instead of skipping the audience check', async () => {
  const token = await signIdToken();
  const saved = config.microsoftClientId;
  config.microsoftClientId = '';
  try {
    await assert.rejects(
      () => verifyEntraIdToken(token, { ...trust(), audience: undefined }),
      /MICROSOFT_CLIENT_ID is not configured/,
    );
  } finally {
    config.microsoftClientId = saved;
  }
});

test('verifyEntraIdToken: expired token is rejected', async () => {
  const now = Math.floor(Date.now() / 1000);
  const token = await signIdToken({ iat: now - 7200, nbf: now - 7200, exp: now - 3600 });
  await assert.rejects(() => verifyEntraIdToken(token, trust()));
});

test('verifyEntraIdToken: an app-only token for the same audience is not accepted as a user sign-in', async () => {
  const token = await signIdToken({ idtyp: 'app' });
  await assert.rejects(() => verifyEntraIdToken(token, trust()), /app-only/);
});

test('verifyEntraIdToken: missing oid / missing any email-shaped claim are rejected', async () => {
  await assert.rejects(() => signIdToken({ oid: undefined }).then((t) => verifyEntraIdToken(t, trust())), /oid/);
  await assert.rejects(
    () => signIdToken({ preferred_username: undefined }).then((t) => verifyEntraIdToken(t, trust())),
    /email or preferred_username/,
  );
});

test('verifyEntraIdToken: alg:"none" and RS256->HS256 confusion are rejected', async () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  await assert.rejects(() => verifyEntraIdToken(`${b64({ alg: 'none' })}.${b64(idClaims())}.`, trust()));
  const forged = await new jose.SignJWT(idClaims())
    .setProtectedHeader({ alg: 'HS256', kid: KID })
    .sign(new TextEncoder().encode(publicPem));
  await assert.rejects(() => verifyEntraIdToken(forged, trust()));
});

test('verifyEntraIdToken: MFA required but NO amr claim -> rejected with the "configure the optional claim" error', async () => {
  const token = await signIdToken();
  await assert.rejects(
    () => verifyEntraIdToken(token, trust({ requireMfa: true })),
    (err) => err.code === 'ENTRA_MFA_REQUIRED' && /no "amr" claim/.test(err.message),
  );
});

test('verifyEntraIdToken: MFA required, amr present but password-only -> rejected', async () => {
  const token = await signIdToken({ amr: ['pwd'] });
  await assert.rejects(
    () => verifyEntraIdToken(token, trust({ requireMfa: true })),
    (err) => err.code === 'ENTRA_MFA_REQUIRED' && /complete MFA/.test(err.message),
  );
});

test('verifyEntraIdToken: MFA required and amr contains "mfa" (Authenticator push shape) -> accepted', async () => {
  const token = await signIdToken({ amr: ['pwd', 'rsa', 'ngcmfa', 'mfa'] });
  const r = await verifyEntraIdToken(token, trust({ requireMfa: true }));
  assert.equal(r.oid, '0a0a0a0a-0000-0000-0000-000000000001');
});

test('verifyEntraIdToken: MFA NOT required -> a password-only token is accepted', async () => {
  const token = await signIdToken({ amr: ['pwd'] });
  await verifyEntraIdToken(token, trust({ requireMfa: false }));
});

// ===================== 2. route: POST /api/auth/microsoft =====================

const REAL_JWKS_URL = `https://login.microsoftonline.com/${TENANT_ID}/discovery/v2.0/keys`;
const realFetch = globalThis.fetch;
let jwksFetches = 0;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url === REAL_JWKS_URL) {
    jwksFetches++;
    return new Response(JSON.stringify(jwksDoc), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(input, init);
};

// Graph /me stub for the tenant-UNSET path (routes/auth.js getMicrosoftProfile uses
// https.get, not fetch). Everything not addressed to graph.microsoft.com is untouched.
const realHttpsGet = https.get;
let graphProfile = null;
let graphCalls = 0;
https.get = function (options, cb) {
  if (options && options.hostname === 'graph.microsoft.com') {
    graphCalls++;
    const resp = new PassThrough();
    process.nextTick(() => { cb(resp); resp.end(JSON.stringify(graphProfile)); });
    return { on() { return this; } };
  }
  return realHttpsGet.apply(this, arguments);
};

const saved = {
  entraTenantId: config.entraTenantId,
  microsoftClientId: config.microsoftClientId,
  entraRequireMfa: config.entraRequireMfa,
};
function configure({ tenant = '', mfa = false } = {}) {
  config.entraTenantId = tenant;
  config.microsoftClientId = CLIENT_ID;
  config.entraRequireMfa = mfa;
}

let app;
const createdUserIds = [];
test.before(async () => { app = await startInProcessApp({ only: [] }); });
test.after(async () => {
  Object.assign(config, saved);
  globalThis.fetch = realFetch;
  https.get = realHttpsGet;
  await cleanupUsers(app.db, createdUserIds);
  await app.stop();
});

async function postMicrosoft(body) {
  const res = await fetch(`${app.base}/api/auth/microsoft`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}
const userByEmail = (email) => app.db.prepare('SELECT * FROM users WHERE email = ?').get(email);

test('route: tenant set + valid id_token -> 200, account created from VERIFIED claims (oid as provider_id), no Graph call', async () => {
  configure({ tenant: TENANT_ID });
  const email = `sso-${randTag()}@contoso.test`;
  const oid = crypto.randomUUID();
  const graphBefore = graphCalls;
  const r = await postMicrosoft({ id_token: await signIdToken({ preferred_username: email, oid, name: 'SSO Person' }) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.token);
  assert.equal(r.body.user.email, email);
  assert.equal(r.body.user.password_hash, undefined);
  assert.equal(graphCalls, graphBefore, 'no Graph round-trip on the id_token path');
  const row = await userByEmail(email);
  createdUserIds.push(row.id);
  assert.equal(row.auth_provider, 'microsoft');
  assert.equal(row.provider_id, oid);
  assert.equal(row.name, 'SSO Person');

  // the issued session is a normal working BeamOS session
  const me = await fetch(`${app.base}/api/auth/me`, { headers: { Authorization: `Bearer ${r.body.token}` } });
  assert.equal(me.status, 200);
});

test('route: tenant set + existing account keyed on the `email` claim is matched even when preferred_username differs', async () => {
  configure({ tenant: TENANT_ID });
  const tag = randTag();
  const mail = `mail-${tag}@contoso.test`;
  const first = await postMicrosoft({ id_token: await signIdToken({ preferred_username: mail }) });
  assert.equal(first.status, 200);
  const row = await userByEmail(mail);
  createdUserIds.push(row.id);
  // Same person, token now carries email (== existing account) + a different UPN.
  const second = await postMicrosoft({
    id_token: await signIdToken({ email: mail, preferred_username: `upn-${tag}@contoso.onmicrosoft.test` }),
  });
  assert.equal(second.status, 200);
  assert.equal(second.body.user.id, row.id, 'matched the existing account, no duplicate');
  assert.equal(await userByEmail(`upn-${tag}@contoso.onmicrosoft.test`), undefined);
});

test('route: tenant set + access_token only -> 400 with a clear error, nothing created', async () => {
  configure({ tenant: TENANT_ID });
  const graphBefore = graphCalls;
  const r = await postMicrosoft({ access_token: 'graph-access-token' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /requires an OpenID Connect id_token/);
  assert.equal(graphCalls, graphBefore, 'access_token was not used at all');
});

test('route: tenant set + id_token from ANOTHER tenant -> 401, no account created', async () => {
  configure({ tenant: TENANT_ID });
  const email = `wrongtenant-${randTag()}@fabrikam.test`;
  const r = await postMicrosoft({
    id_token: await signIdToken({
      iss: `https://login.microsoftonline.com/${OTHER_TENANT}/v2.0`, tid: OTHER_TENANT, preferred_username: email,
    }),
  });
  assert.equal(r.status, 401);
  assert.match(r.body.error, /Microsoft sign-in rejected/);
  assert.equal(await userByEmail(email), undefined);
});

test('route: tenant set + id_token for a different app (wrong aud) -> 401, no account created', async () => {
  configure({ tenant: TENANT_ID });
  const email = `wrongaud-${randTag()}@contoso.test`;
  const r = await postMicrosoft({
    id_token: await signIdToken({ aud: 'eeeeeeee-1111-2222-3333-444444444444', preferred_username: email }),
  });
  assert.equal(r.status, 401);
  assert.equal(await userByEmail(email), undefined);
});

test('route: ENTRA_REQUIRE_MFA + no mfa in amr -> 401 with the MFA message; with mfa -> 200', async () => {
  configure({ tenant: TENANT_ID, mfa: true });
  const email = `mfa-${randTag()}@contoso.test`;
  const denied = await postMicrosoft({ id_token: await signIdToken({ preferred_username: email, amr: ['pwd'] }) });
  assert.equal(denied.status, 401);
  assert.match(denied.body.error, /Multi-factor authentication is required/);
  assert.equal(await userByEmail(email), undefined);

  const noAmr = await postMicrosoft({ id_token: await signIdToken({ preferred_username: email }) });
  assert.equal(noAmr.status, 401);
  assert.match(noAmr.body.error, /no "amr" claim/);

  const ok = await postMicrosoft({ id_token: await signIdToken({ preferred_username: email, amr: ['pwd', 'mfa'] }) });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  createdUserIds.push(ok.body.user.id);
});

test('route: tenant UNSET -> original access_token + Graph /me flow, unchanged (no JWKS fetch, no id_token needed)', async () => {
  configure({ tenant: '' });
  const email = `legacy-${randTag()}@anytenant.test`;
  graphProfile = { id: 'graph-user-id-1', mail: email.toUpperCase(), userPrincipalName: 'x@y.test', displayName: 'Legacy Person' };
  const jwksBefore = jwksFetches;
  const graphBefore = graphCalls;
  const r = await postMicrosoft({ access_token: 'any-graph-access-token' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(graphCalls, graphBefore + 1);
  assert.equal(jwksFetches, jwksBefore, 'tenant-unset path never touches Entra JWKS');
  const row = await userByEmail(email); // lowercased, exactly as before
  createdUserIds.push(row.id);
  assert.equal(row.provider_id, 'graph-user-id-1');
  assert.equal(row.name, 'Legacy Person');
});

test('route: tenant UNSET -> an id_token alone is still refused with the ORIGINAL error (no behavior change)', async () => {
  configure({ tenant: '' });
  const r = await postMicrosoft({ id_token: await signIdToken() });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'Microsoft access token required');
});

test('route: tenant UNSET -> Graph profile without mail/UPN still yields the original 401', async () => {
  configure({ tenant: '' });
  graphProfile = { error: { code: 'InvalidAuthenticationToken' } };
  const r = await postMicrosoft({ access_token: 'bad' });
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'Could not get Microsoft profile');
});

test('GET /api/auth/config: advertises the restricted tenant to MSAL only when ENTRA_TENANT_ID is set', async () => {
  configure({ tenant: '' });
  const savedMsTenant = config.microsoftTenantId;
  try {
    config.microsoftTenantId = 'common';
    let cfg = await (await fetch(`${app.base}/api/auth/config`)).json();
    assert.equal(cfg.microsoftTenantId, 'common');
    configure({ tenant: TENANT_ID });
    cfg = await (await fetch(`${app.base}/api/auth/config`)).json();
    assert.equal(cfg.microsoftTenantId, TENANT_ID);
  } finally {
    config.microsoftTenantId = savedMsTenant;
  }
});
