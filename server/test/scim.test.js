'use strict';

// Ref 8: SCIM 2.0 inbound provisioning (routes/scim.js + middleware/scimAuth.js),
// end to end over real HTTP against the REAL MySQL database (in-process app,
// helpers/inprocess-app.js), after the real initDb() so scim_tokens and the new
// users columns exist exactly as a booted server would have them.
//
// Request bodies are the shapes Microsoft documents Entra actually sending
// (learn.microsoft.com/entra/identity/app-provisioning/use-scim-to-provision-users-and-groups
// and .../application-provisioning-config-problem-scim-compatibility), including the
// DEFAULT (non-RFC) PATCH shape `"op":"Replace", "value":"False"` (a string).
//
// The centrepiece is the full-loop test: SCIM creates the user -> the user signs in
// through Ref 5's tenant-validated Microsoft SSO -> Entra PATCHes active "False" ->
// that session's very next request is 401 and SSO login is refused. Only Entra's
// JWKS HTTPS fetch is faked (same technique as test/microsoft-sso.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const jose = require('jose');

const config = require('../config');
const { db, initDb } = require('../db/database');
const { startInProcessApp } = require('./helpers/inprocess-app');
const { randTag, cleanupUsers } = require('./helpers/disposable');

const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';
const PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';

// ---- Entra SSO fakes (only the JWKS fetch) ----
const TENANT_ID = 'f1f1f1f1-1111-2222-3333-444444444444';
const CLIENT_ID = 'f2f2f2f2-1111-2222-3333-444444444444';
const JWKS_URL = `https://login.microsoftonline.com/${TENANT_ID}/discovery/v2.0/keys`;
let privateKey, jwksDoc;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url === JWKS_URL) return new Response(JSON.stringify(jwksDoc), { status: 200, headers: { 'content-type': 'application/json' } });
  return realFetch(input, init);
};
function idToken(claims) {
  const now = Math.floor(Date.now() / 1000);
  return new jose.SignJWT({
    iss: `https://login.microsoftonline.com/${TENANT_ID}/v2.0`, aud: CLIENT_ID, tid: TENANT_ID,
    oid: crypto.randomUUID(), ver: '2.0', iat: now, nbf: now, exp: now + 3600, ...claims,
  }).setProtectedHeader({ alg: 'RS256', kid: 'scim-it-kid' }).sign(privateKey);
}

const savedConfig = { ssoTenantId: config.ssoTenantId, microsoftClientId: config.microsoftClientId, entraRequireMfa: config.entraRequireMfa };

let app, admin, adminOrgId, scimToken, scimTokenId, otherOrg;
const cleanup = [];

async function j(method, path, { token, body, contentType = 'application/json' } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = contentType;
  const res = await fetch(`${app.base}${path}`, { method, headers, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}
const scim = (method, path, body, opts = {}) =>
  j(method, `/scim/v2${path}`, { token: opts.token === undefined ? scimToken : opts.token, body, contentType: opts.contentType || 'application/scim+json' });

async function registerUser(prefix) {
  const email = `${prefix}-${randTag()}@scim.local`;
  const r = await j('POST', '/api/auth/register', { body: { email, password: 'scim-test-pass-1', name: prefix, createOrg: true } });
  assert.equal(r.status, 201);
  cleanup.push(r.body.user.id);
  const ws = await app.db.prepare('SELECT organization_id FROM workspaces WHERE id = ?').get(r.body.current_workspace_id);
  return { id: r.body.user.id, email, token: r.body.token, orgId: ws.organization_id };
}

// Entra's documented Create User request body ([MS-SCIM] "Create User").
function entraCreateBody(userName, extra = {}) {
  return {
    schemas: [USER_SCHEMA, 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User'],
    externalId: userName.split('@')[0],
    userName,
    active: true,
    emails: [{ primary: true, type: 'work', value: userName }],
    meta: { resourceType: 'User' },
    name: { formatted: 'givenName familyName', familyName: 'familyName', givenName: 'givenName' },
    roles: [],
    ...extra,
  };
}
const created = (r) => { if (r.body && r.body.id) cleanup.push(r.body.id); return r; };

test.before(async () => {
  const kp = await jose.generateKeyPair('RS256', { extractable: true });
  privateKey = kp.privateKey;
  jwksDoc = { keys: [{ ...(await jose.exportJWK(kp.publicKey)), kid: 'scim-it-kid', use: 'sig', alg: 'RS256' }] };

  await initDb();
  app = await startInProcessApp({ only: ['/api/admin', '/api/devices'] });
  app.app.use('/scim/v2', require('../routes/scim'));

  // A disposable platform admin to mint the SCIM token through the real admin API.
  admin = await registerUser('scimadmin');
  await app.db.prepare("UPDATE users SET role = 'platform_admin' WHERE id = ?").run(admin.id);
  adminOrgId = admin.orgId;
  const minted = await j('POST', '/api/admin/scim-tokens', { token: admin.token, body: { name: 'Entra provisioning (test)', organization_id: adminOrgId } });
  assert.equal(minted.status, 201, JSON.stringify(minted.body));
  scimToken = minted.body.token;
  scimTokenId = minted.body.id;

  otherOrg = await registerUser('scimother'); // a user in a DIFFERENT org
});

test.after(async () => {
  try {
    if (app) {
      Object.assign(config, savedConfig);
      globalThis.fetch = realFetch;
      await cleanupUsers(app.db, cleanup.reverse());
    }
  } finally {
    if (app) await app.stop(); else await db.close();
  }
});

// ===================== token management + auth =====================

test('admin API: token plaintext is returned once (scim_ prefix, base URL); listing never exposes secret or hash', async () => {
  assert.match(scimToken, /^scim_[A-Za-z0-9_-]{40,}$/);
  const list = await j('GET', '/api/admin/scim-tokens', { token: admin.token });
  assert.equal(list.status, 200);
  const row = list.body.find((t) => t.id === scimTokenId);
  assert.ok(row);
  assert.equal(row.organization_id, adminOrgId);
  assert.equal(row.token, undefined);
  assert.equal(row.token_hash, undefined);
  assert.equal(row.prefix, scimToken.slice(0, 13));
  const stored = await app.db.prepare('SELECT token_hash FROM scim_tokens WHERE id = ?').get(scimTokenId);
  assert.equal(stored.token_hash, crypto.createHash('sha256').update(scimToken).digest('hex'), 'only the SHA-256 is stored');
});

test('admin API: a non-platform-admin cannot mint a SCIM token', async () => {
  const r = await j('POST', '/api/admin/scim-tokens', { token: otherOrg.token, body: { name: 'x', organization_id: otherOrg.orgId } });
  assert.equal(r.status, 403);
});

test('auth: missing / non-scim / unknown bearer -> 401 in SCIM error shape', async () => {
  for (const token of [null, 'st_not-a-scim-token', 'scim_definitely-not-issued', otherOrg.token]) {
    const r = await scim('GET', '/ServiceProviderConfig', undefined, { token });
    assert.equal(r.status, 401, `token=${token}`);
    assert.match(r.headers.get('content-type'), /application\/scim\+json/);
    assert.deepEqual(r.body.schemas, [ERROR_SCHEMA]);
    assert.equal(r.body.status, '401');
  }
});

test('auth: a scim_ token is useless on the /api surface (separate front door)', async () => {
  const r = await j('GET', '/api/devices', { token: scimToken });
  assert.equal(r.status, 401);
});

test('auth: a REVOKED token is refused on its next request', async () => {
  const minted = await j('POST', '/api/admin/scim-tokens', { token: admin.token, body: { name: 'to revoke', organization_id: adminOrgId } });
  const t = minted.body.token;
  assert.equal((await scim('GET', '/ServiceProviderConfig', undefined, { token: t })).status, 200);
  assert.equal((await j('DELETE', `/api/admin/scim-tokens/${minted.body.id}`, { token: admin.token })).status, 200);
  const r = await scim('GET', '/ServiceProviderConfig', undefined, { token: t });
  assert.equal(r.status, 401);
  assert.match(r.body.detail, /revoked/);
});

// ===================== discovery =====================

test('GET /ServiceProviderConfig: RFC 7643 §5 shape (every REQUIRED capability present, honest values)', async () => {
  const r = await scim('GET', '/ServiceProviderConfig');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /application\/scim\+json/);
  const b = r.body;
  assert.deepEqual(b.schemas, ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig']);
  assert.deepEqual(b.patch, { supported: true });
  assert.equal(b.bulk.supported, false);
  assert.equal(typeof b.bulk.maxOperations, 'number');
  assert.equal(typeof b.bulk.maxPayloadSize, 'number');
  assert.deepEqual(b.filter, { supported: true, maxResults: 100 });
  assert.deepEqual(b.changePassword, { supported: false });
  assert.deepEqual(b.sort, { supported: false });
  assert.deepEqual(b.etag, { supported: false });
  assert.equal(b.authenticationSchemes.length, 1);
  assert.equal(b.authenticationSchemes[0].type, 'oauthbearertoken');
  assert.equal(typeof b.authenticationSchemes[0].name, 'string');
  assert.equal(typeof b.authenticationSchemes[0].description, 'string');
  assert.equal(b.meta.resourceType, 'ServiceProviderConfig');
  assert.ok(!JSON.stringify(b).includes('null'), 'no null values');
});

test('GET /ResourceTypes (+ /ResourceTypes/User): ListResponse with the User resource type (RFC 7643 §6)', async () => {
  const r = await scim('GET', '/ResourceTypes');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.schemas, [LIST_SCHEMA]);
  assert.equal(r.body.totalResults, 1);
  const rt = r.body.Resources[0];
  assert.deepEqual(rt.schemas, ['urn:ietf:params:scim:schemas:core:2.0:ResourceType']);
  assert.equal(rt.id, 'User');
  assert.equal(rt.name, 'User');
  assert.equal(rt.endpoint, '/Users');
  assert.equal(rt.schema, USER_SCHEMA);
  assert.equal(rt.meta.resourceType, 'ResourceType');
  assert.deepEqual((await scim('GET', '/ResourceTypes/User')).body, rt);
  assert.equal((await scim('GET', '/ResourceTypes/Group')).status, 404);
});

test('GET /Schemas (+ /Schemas/:urn): ListResponse with the core User schema, only stored attributes (RFC 7643 §7)', async () => {
  const r = await scim('GET', '/Schemas');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.schemas, [LIST_SCHEMA]);
  const s = r.body.Resources[0];
  assert.deepEqual(s.schemas, ['urn:ietf:params:scim:schemas:core:2.0:Schema']);
  assert.equal(s.id, USER_SCHEMA);
  const byName = Object.fromEntries(s.attributes.map((a) => [a.name, a]));
  assert.deepEqual(Object.keys(byName).sort(), ['active', 'displayName', 'emails', 'userName']);
  assert.equal(byName.userName.required, true);
  assert.equal(byName.userName.uniqueness, 'server');
  assert.equal(byName.active.type, 'boolean');
  assert.equal(byName.emails.multiValued, true);
  for (const a of s.attributes) {
    for (const k of ['name', 'type', 'multiValued', 'required', 'caseExact', 'mutability', 'returned', 'uniqueness']) {
      assert.ok(k in a, `${a.name}.${k}`);
    }
  }
  assert.equal(s.meta.resourceType, 'Schema');
  assert.equal((await scim('GET', `/Schemas/${USER_SCHEMA}`)).body.id, USER_SCHEMA);
});

test('Entra "Test Connection": filter on a random GUID -> 200 + EMPTY ListResponse', async () => {
  const r = await scim('GET', `/Users?filter=${encodeURIComponent(`userName eq "${crypto.randomUUID()}"`)}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { schemas: [LIST_SCHEMA], totalResults: 0, startIndex: 1, itemsPerPage: 0, Resources: [] });
});

// ===================== /Users CRUD =====================

test('POST /Users (Entra create body, application/scim+json): 201 + Location, SCIM-shaped, verbatim userName, least-privileged org role', async () => {
  const userName = `New.Hire-${randTag()}@Contoso.SCIM.local`;
  const r = created(await scim('POST', '/Users', entraCreateBody(userName, { displayName: 'New Hire' })));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.match(r.headers.get('content-type'), /application\/scim\+json/);
  assert.equal(r.headers.get('location'), r.body.meta.location);
  assert.deepEqual(r.body.schemas, [USER_SCHEMA]);
  assert.equal(r.body.userName, userName, 'userName round-trips with its original casing');
  assert.equal(r.body.externalId, userName.split('@')[0]);
  assert.equal(r.body.displayName, 'New Hire');
  assert.equal(r.body.active, true);
  assert.deepEqual(r.body.emails, [{ value: userName.toLowerCase(), type: 'work', primary: true }]);
  assert.equal(r.body.meta.resourceType, 'User');
  assert.match(r.body.meta.created, /^\d{4}-\d\d-\d\dT/);
  assert.ok(r.body.meta.location.endsWith(`/scim/v2/Users/${r.body.id}`));

  const row = await app.db.prepare('SELECT email, auth_provider, password_hash, role, deactivated_at FROM users WHERE id = ?').get(r.body.id);
  assert.equal(row.email, userName.toLowerCase());
  assert.equal(row.auth_provider, 'microsoft');
  assert.equal(row.password_hash, null);
  assert.equal(row.role, 'user', 'never a platform role');
  assert.equal(row.deactivated_at, null);
  const om = await app.db.prepare('SELECT role FROM organization_members WHERE organization_id = ? AND user_id = ?').get(adminOrgId, r.body.id);
  assert.equal(om.role, 'field_technician');
});

test('POST /Users twice for the same userName -> 409 uniqueness (Microsoft validator requirement)', async () => {
  const userName = `dup-${randTag()}@scim.local`;
  created(await scim('POST', '/Users', entraCreateBody(userName)));
  const r = await scim('POST', '/Users', entraCreateBody(userName.toUpperCase()));
  assert.equal(r.status, 409);
  assert.equal(r.body.scimType, 'uniqueness');
  assert.deepEqual(r.body.schemas, [ERROR_SCHEMA]);
});

test('POST /Users with active:false creates an already-deactivated account; non-email userName -> 400 invalidValue', async () => {
  const r = created(await scim('POST', '/Users', entraCreateBody(`inactive-${randTag()}@scim.local`, { active: false })));
  assert.equal(r.status, 201);
  assert.equal(r.body.active, false);
  const bad = await scim('POST', '/Users', entraCreateBody('not-an-email'));
  assert.equal(bad.status, 400);
  assert.equal(bad.body.scimType, 'invalidValue');
});

test('POST /Users ADOPTS a pre-existing account (e.g. signed in via SSO before SCIM was enabled) into the org', async () => {
  const pre = await registerUser('preexisting');
  const r = await scim('POST', '/Users', entraCreateBody(pre.email));
  assert.equal(r.status, 201);
  assert.equal(r.body.id, pre.id, 'same account, not a duplicate');
  const om = await app.db.prepare('SELECT role FROM organization_members WHERE organization_id = ? AND user_id = ?').get(adminOrgId, pre.id);
  assert.equal(om.role, 'field_technician');
  // and the adopted user's existing session keeps working
  assert.equal((await j('GET', '/api/auth/me', { token: pre.token })).status, 200);
});

test('GET /Users filters: userName (case-insensitive), externalId (Entra\'s unquoted form), and; unsupported -> 400 invalidFilter', async () => {
  const userName = `Filter.Me-${randTag()}@scim.local`;
  const c = created(await scim('POST', '/Users', entraCreateBody(userName)));
  const q = (f) => scim('GET', `/Users?filter=${encodeURIComponent(f)}`);

  let r = await q(`userName eq "${userName.toLowerCase()}"`);
  assert.equal(r.body.totalResults, 1);
  assert.equal(r.body.Resources[0].id, c.body.id);
  r = await q(`externalId eq ${userName.split('@')[0]}`);
  assert.equal(r.body.totalResults, 1);
  r = await q(`userName eq "${userName}" and active eq true`);
  assert.equal(r.body.totalResults, 1);
  r = await q(`emails[type eq "work"].value eq "${userName}"`);
  assert.equal(r.body.totalResults, 1);
  r = await q(`urn:ietf:params:scim:schemas:core:2.0:User:userName eq "${userName}"`);
  assert.equal(r.body.totalResults, 1);

  for (const f of [`userName co "x"`, `userName eq "a" or userName eq "b"`, `title eq "x"`, `userName eq`]) {
    const bad = await q(f);
    assert.equal(bad.status, 400, f);
    assert.equal(bad.body.scimType, 'invalidFilter', f);
  }
});

test('GET /Users pagination: 1-based startIndex, count, totalResults across pages, count=0', async () => {
  for (let i = 0; i < 3; i++) created(await scim('POST', '/Users', entraCreateBody(`page${i}-${randTag()}@scim.local`)));
  const all = await scim('GET', '/Users?count=100');
  const total = all.body.totalResults;
  assert.ok(total >= 4);
  const p1 = await scim('GET', '/Users?startIndex=1&count=2');
  const p2 = await scim('GET', '/Users?startIndex=3&count=2');
  assert.equal(p1.body.totalResults, total);
  assert.equal(p1.body.itemsPerPage, 2);
  assert.equal(p1.body.startIndex, 1);
  assert.equal(p2.body.startIndex, 3);
  assert.deepEqual(p1.body.Resources.map((u) => u.id), all.body.Resources.slice(0, 2).map((u) => u.id));
  assert.deepEqual(p2.body.Resources.map((u) => u.id), all.body.Resources.slice(2, 4).map((u) => u.id));
  const zero = await scim('GET', '/Users?count=0');
  assert.equal(zero.body.itemsPerPage, 0);
  assert.equal(zero.body.totalResults, total);
  assert.equal((await scim('GET', '/Users?startIndex=0&count=1')).body.startIndex, 1);
});

test('org scoping: a user in ANOTHER org is invisible to this token (404 / not listed)', async () => {
  assert.equal((await scim('GET', `/Users/${otherOrg.id}`)).status, 404);
  assert.equal((await scim('PATCH', `/Users/${otherOrg.id}`, { schemas: [PATCH_SCHEMA], Operations: [{ op: 'replace', path: 'active', value: false }] })).status, 404);
  const r = await scim('GET', `/Users?filter=${encodeURIComponent(`userName eq "${otherOrg.email}"`)}`);
  assert.equal(r.body.totalResults, 0);
  const row = await app.db.prepare('SELECT deactivated_at FROM users WHERE id = ?').get(otherOrg.id);
  assert.equal(row.deactivated_at, null);
});

test('GET /Users/:id: 200 SCIM resource; unknown id -> 404 SCIM error', async () => {
  const c = created(await scim('POST', '/Users', entraCreateBody(`get-${randTag()}@scim.local`)));
  const r = await scim('GET', `/Users/${c.body.id}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, c.body);
  const nf = await scim('GET', `/Users/${crypto.randomUUID()}`);
  assert.equal(nf.status, 404);
  assert.equal(nf.body.status, '404');
});

test('PATCH (Entra default shape, multi-op Replace incl. unstored attrs): displayName/externalId applied, others ignored', async () => {
  const c = created(await scim('POST', '/Users', entraCreateBody(`patch-${randTag()}@scim.local`)));
  const r = await scim('PATCH', `/Users/${c.body.id}`, {
    schemas: [PATCH_SCHEMA],
    Operations: [
      { op: 'Replace', path: 'displayName', value: 'Pvlo' },
      { op: 'Replace', path: 'emails[type eq "work"].value', value: 'ignored@test.microsoft.com' },
      { op: 'Replace', path: 'name.givenName', value: 'Gtfd' },
      { op: 'Replace', path: 'externalId', value: 'Eqpj' },
      { op: 'Replace', path: 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:employeeNumber', value: 'Eqpj' },
    ],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.displayName, 'Pvlo');
  assert.equal(r.body.externalId, 'Eqpj');
  assert.equal(r.body.userName, c.body.userName);
});

test('PATCH (aadOptscim062020 flag shape): path-less replace with an object of dotted keys', async () => {
  const c = created(await scim('POST', '/Users', entraCreateBody(`flag-${randTag()}@scim.local`)));
  const r = await scim('PATCH', `/Users/${c.body.id}`, {
    schemas: [PATCH_SCHEMA],
    Operations: [{ op: 'replace', value: { displayName: 'Bjfe', 'name.givenName': 'Kkom', 'name.familyName': 'Unua' } }],
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.displayName, 'Bjfe');
});

test('PATCH validation: bad op / empty Operations / non-boolean active -> 400 SCIM errors, nothing changed', async () => {
  const c = created(await scim('POST', '/Users', entraCreateBody(`pval-${randTag()}@scim.local`)));
  const p = (body) => scim('PATCH', `/Users/${c.body.id}`, body);
  assert.equal((await p({ Operations: [] })).body.scimType, 'invalidSyntax');
  assert.equal((await p({ Operations: [{ op: 'move', path: 'active', value: false }] })).body.scimType, 'invalidSyntax');
  const r = await p({ Operations: [{ op: 'replace', path: 'active', value: 'maybe' }] });
  assert.equal(r.status, 400);
  assert.equal(r.body.scimType, 'invalidValue');
  assert.equal((await p({ Operations: [{ op: 'remove', path: 'userName' }] })).body.scimType, 'mutability');
  assert.equal((await scim('GET', `/Users/${c.body.id}`)).body.active, true);
});

test('THE END-TO-END REQUIREMENT: Entra provisions -> user signs in via SSO -> Entra PATCHes active "False" -> that session dies on its next request', async () => {
  // Ref 5 tenant-restricted SSO on, so the login below is the real id_token path.
  config.ssoTenantId = TENANT_ID;
  config.microsoftClientId = CLIENT_ID;
  config.entraRequireMfa = false;

  // 1. Entra creates the user.
  const upn = `leaver-${randTag()}@contoso.scim.local`;
  const c = created(await scim('POST', '/Users', entraCreateBody(upn, { displayName: 'Soon Leaving' })));
  assert.equal(c.status, 201);

  // 2. The user signs in with Microsoft (id_token validated against the tenant).
  const login = await j('POST', '/api/auth/microsoft', { body: { id_token: await idToken({ preferred_username: upn, name: 'Soon Leaving' }) } });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  assert.equal(login.body.user.id, c.body.id, 'SSO login matched the SCIM-provisioned account');
  const session = login.body.token;
  assert.equal((await j('GET', '/api/auth/me', { token: session })).status, 200);
  assert.equal((await j('GET', '/api/devices', { token: session })).status, 200);

  // 3. The user is removed from the app in Entra: Entra's DEFAULT deprovision PATCH
  //    (non-RFC string "False", capitalised op - [MS-KNOWN] "without feature flag").
  const patch = await scim('PATCH', `/Users/${c.body.id}`, {
    schemas: [PATCH_SCHEMA],
    Operations: [{ op: 'Replace', path: 'active', value: 'False' }],
  });
  assert.equal(patch.status, 200);
  assert.equal(patch.body.active, false);
  const row = await app.db.prepare('SELECT deactivated_at FROM users WHERE id = ?').get(c.body.id);
  assert.ok(row.deactivated_at > 0, 'users.deactivated_at set');

  // 4. The SAME session (unexpired, validly signed) is refused on its very next request.
  const me = await j('GET', '/api/auth/me', { token: session });
  assert.equal(me.status, 401);
  assert.equal(me.body.error, 'account_deactivated');
  assert.equal((await j('GET', '/api/devices', { token: session })).status, 401);

  // 5. ...and a fresh SSO login with a perfectly valid id_token is refused too.
  const relogin = await j('POST', '/api/auth/microsoft', { body: { id_token: await idToken({ preferred_username: upn }) } });
  assert.equal(relogin.status, 403);
  assert.match(relogin.body.error, /deactivated/);

  // 6. Re-enabled in Entra (boolean shape, flag behaviour) -> access restored.
  const back = await scim('PATCH', `/Users/${c.body.id}`, { schemas: [PATCH_SCHEMA], Operations: [{ op: 'replace', path: 'active', value: true }] });
  assert.equal(back.body.active, true);
  assert.equal((await j('GET', '/api/auth/me', { token: session })).status, 200);
});

test('PATCH active:false (boolean, path-less object form) also revokes; GET reflects active:false', async () => {
  const c = created(await scim('POST', '/Users', entraCreateBody(`bool-${randTag()}@scim.local`)));
  const r = await scim('PATCH', `/Users/${c.body.id}`, { schemas: [PATCH_SCHEMA], Operations: [{ op: 'replace', value: { active: false } }] });
  assert.equal(r.body.active, false);
  assert.equal((await scim('GET', `/Users/${c.body.id}`)).body.active, false);
  const f = await scim('GET', `/Users?filter=${encodeURIComponent(`userName eq "${c.body.userName}" and active eq false`)}`);
  assert.equal(f.body.totalResults, 1);
});

test('PUT /Users/:id: full replace - userName + displayName updated, externalId absent -> cleared; userName clash -> 409', async () => {
  const c = created(await scim('POST', '/Users', entraCreateBody(`put-${randTag()}@scim.local`)));
  const newName = `Renamed-${randTag()}@scim.local`;
  const r = await scim('PUT', `/Users/${c.body.id}`, { schemas: [USER_SCHEMA], userName: newName, displayName: 'Renamed Person', active: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.userName, newName);
  assert.equal(r.body.displayName, 'Renamed Person');
  assert.equal(r.body.externalId, undefined);
  assert.equal(r.body.emails[0].value, newName.toLowerCase());
  const clash = await scim('PUT', `/Users/${c.body.id}`, { schemas: [USER_SCHEMA], userName: admin.email });
  assert.equal(clash.status, 409);
  assert.equal(clash.body.scimType, 'uniqueness');
});

test('DELETE /Users/:id: 204, soft (deactivated + removed from org, row kept); then 404; a re-POST re-adopts and reactivates', async () => {
  const c = created(await scim('POST', '/Users', entraCreateBody(`del-${randTag()}@scim.local`)));
  const d = await j('DELETE', `/scim/v2/Users/${c.body.id}`, { token: scimToken });
  assert.equal(d.status, 204);
  assert.equal((await scim('GET', `/Users/${c.body.id}`)).status, 404);
  assert.equal((await j('DELETE', `/scim/v2/Users/${c.body.id}`, { token: scimToken })).status, 404);
  const row = await app.db.prepare('SELECT deactivated_at FROM users WHERE id = ?').get(c.body.id);
  assert.ok(row && row.deactivated_at > 0, 'row kept, deactivated');

  const again = await scim('POST', '/Users', entraCreateBody(c.body.userName, { active: true }));
  assert.equal(again.status, 201);
  assert.equal(again.body.id, c.body.id);
  assert.equal(again.body.active, true);
});

test('protocol edges: malformed JSON -> 400 invalidSyntax; /Groups -> 501; unknown path -> 404; all SCIM-shaped', async () => {
  const bad = await scim('POST', '/Users', '{"userName": ');
  assert.equal(bad.status, 400);
  assert.equal(bad.body.scimType, 'invalidSyntax');
  const g = await scim('GET', '/Groups');
  assert.equal(g.status, 501);
  assert.deepEqual(g.body.schemas, [ERROR_SCHEMA]);
  const u = await scim('GET', '/Nope');
  assert.equal(u.status, 404);
  assert.deepEqual(u.body.schemas, [ERROR_SCHEMA]);
});
