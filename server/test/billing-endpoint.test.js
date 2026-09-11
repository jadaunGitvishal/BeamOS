'use strict';

// #146 BILLING — endpoint authz + route isolation. Asserts: admin can GET
// /api/billing/usage (200), non-admin 403 / anon 401, and billing is NOT
// present on the public /api/status (it lives on a SEPARATE route).
//
// In-process against the real MySQL database (see test/helpers/inprocess-app.js).
// Every row this test creates is disposable and removed in after().

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startInProcessApp } = require('./helpers/inprocess-app');
const { randTag, cleanupUsers } = require('./helpers/disposable');

let base, db, stop;
const created = { userIds: [] };

before(async () => {
  ({ base, db, stop } = await startInProcessApp({ only: ['/api/auth', '/api/status', '/api/billing'] }));
});
after(async () => {
  await cleanupUsers(db, created.userIds);
  await stop();
});

const reg = (o) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });
const auth = (tok) => (tok ? { headers: { Authorization: 'Bearer ' + tok } } : {});

test('admin can GET /api/billing/usage; returns a current-month report', async () => {
  const email = `billing-ep-admin-${randTag()}@x.local`;
  const r0 = await (await fetch(base + '/api/auth/register', reg({ email, password: 'Passw0rd123' }))).json();
  created.userIds.push(r0.user.id);
  const tok = r0.token;
  await db.prepare("UPDATE users SET role = 'platform_admin' WHERE email = ?").run(email);

  const r = await fetch(base + '/api/billing/usage', auth(tok));
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.match(b.month, /^\d{4}-\d{2}$/, 'current month by default');
  assert.equal(typeof b.billable_screens, 'number');
  assert.equal(typeof b.provisioned_screens, 'number');
  assert.equal(typeof b.cost_usd, 'number');
  assert.ok(Array.isArray(b.daily), 'daily breakdown present');
  assert.equal(b.is_final, false, 'current month is not final');

  // a specific month is accepted; a bad month is 400
  assert.equal((await fetch(base + '/api/billing/usage?month=2025-02', auth(tok))).status, 200);
  assert.equal((await fetch(base + '/api/billing/usage?month=2025-13', auth(tok))).status, 400);
});

test('non-admin gets 403, anonymous gets 401', async () => {
  const email = `billing-ep-user-${randTag()}@x.local`;
  const r0 = await (await fetch(base + '/api/auth/register', reg({ email, password: 'Passw0rd123' }))).json();
  created.userIds.push(r0.user.id);
  assert.equal((await fetch(base + '/api/billing/usage', auth(r0.token))).status, 403, 'non-admin denied');
  assert.equal((await fetch(base + '/api/billing/usage')).status, 401, 'anon denied');
});

test('billing is NOT on public /api/status (separate route; no revenue data leaks)', async () => {
  const b = await (await fetch(base + '/api/status')).json();
  assert.equal(typeof b.devices_connected, 'number', 'devices_connected stays public');
  for (const k of ['billing', 'billable_screens', 'cost_usd', 'rate_usd', 'provisioned_screens']) {
    assert.equal(k in b, false, `/api/status must not expose ${k}`);
    if (b.debug) assert.equal(k in b.debug, false, `/api/status.debug must not expose ${k}`);
  }
});
