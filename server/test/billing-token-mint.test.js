'use strict';

// #146 — owner-only billing:read token minting (server/lib/billing-token.js + the CLI it
// backs). Verifies the minted row's exact shape (scope + SHA-256 hash, nothing else),
// that the token reads billing but is refused elsewhere (scope isolation), and that
// revocation takes effect.
//
// In-process against the real MySQL database (see test/helpers/inprocess-app.js).
// Every row this test creates is disposable and removed in after().

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startInProcessApp } = require('./helpers/inprocess-app');
const { randTag, cleanupUsers } = require('./helpers/disposable');
const { mintBillingToken, revokeBillingToken, listBillingTokens } = require('../lib/billing-token');
const { hashToken } = require('../middleware/apiToken');

let base, db, stop, minted;
const created = { userIds: [] };

before(async () => {
  ({ base, db, stop } = await startInProcessApp({ only: ['/api/auth', '/api/billing', '/api/devices', '/api/admin'] }));

  // Register a user and promote to platform_admin so an OWNER + a workspace exist.
  const email = `billmint-own-${randTag()}@x.local`;
  const r0 = await (await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'Passw0rd123' }) })).json();
  created.userIds.push(r0.user.id);
  await db.prepare("UPDATE users SET role = 'platform_admin' WHERE email = ?").run(email);

  minted = await mintBillingToken(db, { name: 'Bold invoicing' }); // the function the CLI wraps
});
after(async () => {
  await cleanupUsers(db, created.userIds);
  await stop();
});

const S = (r) => r.status;
const bearer = (t) => ({ headers: { Authorization: 'Bearer ' + t } });

test('mint creates an api_tokens row: scope EXACTLY billing:read, correct SHA-256 hash', async () => {
  const row = await db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(minted.id);
  assert.ok(row, 'row exists');
  assert.equal(row.scope, 'billing:read', 'scope is exactly billing:read');
  assert.equal(row.token_hash, hashToken(minted.secret), 'stored hash matches the SHA-256 verification path');
  assert.ok(minted.secret.startsWith('st_'), 'same secret format as existing tokens');
  // does NOT carry any workspace-level scope
  for (const s of ['read', 'write', 'full', 'agency']) assert.notEqual(row.scope, s);
  assert.ok(row.user_id && row.workspace_id, 'bound to owner + a workspace (FK satisfied)');
  assert.equal(row.revoked_at, null, 'not revoked at mint');
  // listBillingTokens surfaces it
  assert.ok((await listBillingTokens(db)).some((t) => t.id === minted.id));
});

test('minted token reads billing (200) but is REFUSED elsewhere (scope isolation)', async () => {
  assert.equal(S(await fetch(base + '/api/billing/usage', bearer(minted.secret))), 200, 'reads billing');
  const body = await (await fetch(base + '/api/billing/usage', bearer(minted.secret))).json();
  assert.equal(typeof body.billable_screens, 'number');
  assert.equal(S(await fetch(base + '/api/devices', bearer(minted.secret))), 403, 'refused on a workspace router');
  assert.equal(S(await fetch(base + '/api/admin/orgs', bearer(minted.secret))), 401, 'refused on an admin router');
});

test('revocation: a revoked minted token is refused', async () => {
  assert.equal(S(await fetch(base + '/api/billing/usage', bearer(minted.secret))), 200, 'valid before revoke');
  const res = await revokeBillingToken(db, minted.id);
  assert.equal(res.ok, true);
  assert.equal(S(await fetch(base + '/api/billing/usage', bearer(minted.secret))), 401, 'refused after revoke');
});

test('mint requires a name; revoke refuses a non-billing token id', async () => {
  await assert.rejects(() => mintBillingToken(db, { name: '' }), /name is required/);
  // revoke guard: a made-up id / non-billing scope is refused, not silently applied
  assert.equal((await revokeBillingToken(db, 'no-such-id')).ok, false);
});
