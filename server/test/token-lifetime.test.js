'use strict';

// Ref 34: admin-defined maximum lifetime of programmatic access
// (organizations.max_token_lifetime_days, lib/token-lifetime.js), end to end over
// real HTTP against the REAL MySQL database (helpers/inprocess-app.js) after the
// real initDb(), for both credential types it covers:
//   - st_ API tokens    (apiTokenAuth, middleware/apiToken.js; org via workspace)
//   - scim_ SCIM tokens (scimAuth, middleware/scimAuth.js; org via organization_id)
// The centrepiece for each is the RETROACTIVE case: a token minted while no cap
// existed is refused the moment a cap it already exceeds is set - no backfill,
// no per-token action. Token age is simulated by back-dating created_at.

const test = require('node:test');
const assert = require('node:assert/strict');

const { initDb } = require('../db/database');
const { startInProcessApp } = require('./helpers/inprocess-app');
const { randTag, cleanupUsers } = require('./helpers/disposable');

const DAY = 86400;
const ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';

let app, owner, platformAdmin;
const cleanup = [];

async function j(method, path, { token, body, contentType = 'application/json' } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = contentType;
  const res = await fetch(`${app.base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

async function registerUser(prefix) {
  const email = `${prefix}-${randTag()}@lifetime.local`;
  const r = await j('POST', '/api/auth/register', { body: { email, password: 'lifetime-test-pass-1', name: prefix, createOrg: true } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  cleanup.push(r.body.user.id);
  const ws = await app.db.prepare('SELECT organization_id FROM workspaces WHERE id = ?').get(r.body.current_workspace_id);
  return { id: r.body.user.id, email, token: r.body.token, workspaceId: r.body.current_workspace_id, orgId: ws.organization_id };
}

const setCap = (orgId, days) => app.db.prepare('UPDATE organizations SET max_token_lifetime_days = ? WHERE id = ?').run(days, orgId);
const backdate = (table, id, days) => app.db.prepare(`UPDATE ${table} SET created_at = UNIX_TIMESTAMP() - ? WHERE id = ?`).run(days * DAY, id);

async function mintApiToken(user, name = 'lifetime test') {
  const r = await j('POST', '/api/tokens', { token: user.token, body: { name, scope: 'read' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}
async function mintScimToken(orgId) {
  const r = await j('POST', '/api/admin/scim-tokens', { token: platformAdmin.token, body: { name: 'lifetime scim', organization_id: orgId } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}
// A token-routed PUBLIC endpoint (bearerAuth -> apiTokenAuth) and the SCIM front door.
const useApiToken = (secret) => j('GET', '/api/devices', { token: secret });
const useScimToken = (secret) => j('GET', '/scim/v2/Users?count=1', { token: secret });

test.before(async () => {
  await initDb();
  app = await startInProcessApp({ only: ['/api/admin', '/api/devices', '/api/tokens', '/api/organizations'] });
  app.app.use('/scim/v2', require('../routes/scim'));
  owner = await registerUser('lifeowner');
  platformAdmin = await registerUser('lifeplat');
  await app.db.prepare("UPDATE users SET role = 'platform_admin' WHERE id = ?").run(platformAdmin.id);
});

test.after(async () => {
  await cleanupUsers(app.db, cleanup.reverse());
  await app.stop();
});

test.afterEach(async () => { await setCap(owner.orgId, null); });

// ---------------------------------------------------------------- api_tokens

test('api token: minted with NO cap, then a cap it already exceeds is set -> refused immediately (retroactive)', async () => {
  const tok = await mintApiToken(owner);
  await backdate('api_tokens', tok.id, 40);
  assert.equal((await useApiToken(tok.token)).status, 200, 'works while the org is uncapped');

  await setCap(owner.orgId, 30); // no per-token change at all - only the org policy moves
  const r = await useApiToken(tok.token);
  assert.equal(r.status, 401);
  assert.deepEqual(r.body, { error: 'Invalid or expired API token' }); // same 401 { error } shape as revoked

  const list = await j('GET', '/api/tokens', { token: owner.token });
  const row = list.body.find((t) => t.id === tok.id);
  assert.equal(row.expires_at, row.created_at + 30 * DAY);
  assert.equal(row.expired, true);
});

test('api token: younger than the cap still works, and the list shows when it will expire', async () => {
  await setCap(owner.orgId, 30);
  const tok = await mintApiToken(owner);
  assert.equal(tok.expires_at, (await app.db.prepare('SELECT created_at FROM api_tokens WHERE id = ?').get(tok.id)).created_at + 30 * DAY);
  await backdate('api_tokens', tok.id, 29);
  assert.equal((await useApiToken(tok.token)).status, 200);
  const row = (await j('GET', '/api/tokens', { token: owner.token })).body.find((t) => t.id === tok.id);
  assert.equal(row.expired, false);
  assert.equal(row.expires_at, row.created_at + 30 * DAY);
});

test('api token: cap NULL (default) behaves exactly as before - a years-old token works, expires_at null', async () => {
  const org = await app.db.prepare('SELECT max_token_lifetime_days FROM organizations WHERE id = ?').get(owner.orgId);
  assert.equal(org.max_token_lifetime_days, null, 'a freshly registered org is uncapped by default');
  const tok = await mintApiToken(owner);
  assert.equal(tok.expires_at, null);
  await backdate('api_tokens', tok.id, 5 * 365);
  assert.equal((await useApiToken(tok.token)).status, 200);
  const row = (await j('GET', '/api/tokens', { token: owner.token })).body.find((t) => t.id === tok.id);
  assert.equal(row.expires_at, null);
  assert.equal(row.expired, false);
});

test('api token: revocation still wins and keeps its own message regardless of the cap', async () => {
  const tok = await mintApiToken(owner);
  await j('DELETE', `/api/tokens/${tok.id}`, { token: owner.token });
  const r = await useApiToken(tok.token);
  assert.equal(r.status, 401);
  assert.deepEqual(r.body, { error: 'Invalid or revoked API token' });
});

// ---------------------------------------------------------------- scim_tokens

test('scim token: minted with NO cap, then a cap it already exceeds is set -> refused immediately (retroactive)', async () => {
  const tok = await mintScimToken(owner.orgId);
  assert.equal(tok.expires_at, null);
  await backdate('scim_tokens', tok.id, 100);
  const ok = await useScimToken(tok.token);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));

  await setCap(owner.orgId, 90);
  const r = await useScimToken(tok.token);
  assert.equal(r.status, 401);
  assert.deepEqual(r.body.schemas, [ERROR_SCHEMA]); // same SCIM error shape as a revoked token
  assert.equal(r.body.status, '401');
  assert.equal(r.body.detail, 'Invalid or expired SCIM bearer token');

  const row = (await j('GET', '/api/admin/scim-tokens', { token: platformAdmin.token })).body.find((t) => t.id === tok.id);
  assert.equal(row.expires_at, row.created_at + 90 * DAY);
  assert.equal(row.expired, true);
  assert.equal('max_token_lifetime_days' in row, false);
});

test('scim token: younger than the cap still works', async () => {
  await setCap(owner.orgId, 90);
  const tok = await mintScimToken(owner.orgId);
  assert.equal(tok.expires_at, tok.created_at + 90 * DAY);
  await backdate('scim_tokens', tok.id, 89);
  const r = await useScimToken(tok.token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(Array.isArray(r.body.Resources));
});

test('scim token: cap NULL (default) behaves exactly as before - a years-old token works', async () => {
  const tok = await mintScimToken(owner.orgId);
  await backdate('scim_tokens', tok.id, 5 * 365);
  assert.equal((await useScimToken(tok.token)).status, 200);
  const row = (await j('GET', '/api/admin/scim-tokens', { token: platformAdmin.token })).body.find((t) => t.id === tok.id);
  assert.equal(row.expires_at, null);
  assert.equal(row.expired, false);
});

test("scim token: the cap is per-organization - another org's cap doesn't touch it", async () => {
  const tok = await mintScimToken(owner.orgId);
  await backdate('scim_tokens', tok.id, 100);
  await setCap(platformAdmin.orgId, 1);
  try {
    assert.equal((await useScimToken(tok.token)).status, 200);
  } finally { await setCap(platformAdmin.orgId, null); }
});
