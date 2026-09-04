'use strict';

// Fix verification: POST /api/stripe/checkout and /portal previously only
// required requireAuth (any authenticated org member), never the org_owner
// restriction lib/permissions.js's own comment documented as intended
// ("org_owner also has billing.write ... not exposed in 2.1"). Both routes
// now chain resolveTenancy + a canAdminOrg-gated requireBillingOwner.
//
// In-memory sqlite + the real stripe router, mounted exactly as server.js
// mounts it (requireAuth only at the app level - the router does its own
// resolveTenancy/requireBillingOwner internally, same shape as
// routes/workspaces.js gating tickets). The 'stripe' package itself is
// stubbed via require.cache (same technique used for '../db/database' in
// tickets.test.js/regions.test.js) so a real Stripe secret key/network call
// is never needed - this tests OUR authorization gate, not Stripe's API.

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

process.env.JWT_SECRET = 'test-secret-stripe';
process.env.STRIPE_SECRET_KEY = 'sk_test_fake_for_rbac_verification';

const db = new Database(':memory:');
db.function('UNIX_TIMESTAMP', () => Math.floor(Date.now() / 1000));
db.exec(`
  CREATE TABLE users (
    id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT DEFAULT '',
    auth_provider TEXT NOT NULL DEFAULT 'local', avatar_url TEXT,
    role TEXT NOT NULL DEFAULT 'user', plan_id TEXT DEFAULT 'free', email_alerts INTEGER DEFAULT 1,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    stripe_customer_id TEXT, stripe_subscription_id TEXT
  );
  CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_user_id TEXT NOT NULL);
  CREATE TABLE organization_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT, organization_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL
  );
  CREATE TABLE workspaces (
    id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, name TEXT NOT NULL,
    slug TEXT, region_id TEXT, updated_at INTEGER DEFAULT 0
  );
  CREATE TABLE workspace_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL,
    joined_at INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE plans (
    id TEXT PRIMARY KEY, display_name TEXT NOT NULL,
    stripe_price_monthly TEXT, stripe_price_yearly TEXT
  );
`);

const dbModulePath = require.resolve('../db/database');
require.cache[dbModulePath] = { id: dbModulePath, filename: dbModulePath, loaded: true, exports: { db } };

// Stub the 'stripe' SDK itself - constructor returns a fake client whose
// methods return just enough shape for the route handlers to succeed.
const stripeModulePath = require.resolve('stripe');
function fakeStripeFactory() {
  return {
    customers: {
      create: async ({ metadata }) => ({ id: 'cus_fake_' + metadata.user_id }),
    },
    checkout: {
      sessions: { create: async () => ({ url: 'https://fake.stripe.test/checkout/cs_fake', id: 'cs_fake' }) },
    },
    billingPortal: {
      sessions: { create: async () => ({ url: 'https://fake.stripe.test/portal/bps_fake' }) },
    },
  };
}
require.cache[stripeModulePath] = { id: stripeModulePath, filename: stripeModulePath, loaded: true, exports: fakeStripeFactory };

const express = require('express');
const { generateToken, requireAuth } = require('../middleware/auth');

// --- fixtures --------------------------------------------------------
// org-a: owner u-orgowner (org_owner, no direct workspace_members row - acts
// in via the org path, exactly how a real org_owner reaches a workspace they
// didn't personally join). ws-a carries the workspace-tier roles under test.
db.prepare("INSERT INTO users (id,email,role) VALUES ('u-plat','plat@t.test','platform_admin')").run();
// stripe_customer_id is set here deliberately, to demonstrate the separate
// pre-existing bug documented on the /portal test below: requireAuth never
// selects this column, so it's undefined on req.user regardless of what's
// actually in this row.
db.prepare("INSERT INTO users (id,email,role,stripe_customer_id) VALUES ('u-orgowner','orgowner@t.test','user','cus_preexisting')").run();
db.prepare("INSERT INTO users (id,email,role) VALUES ('u-wsadmin','wsadmin@t.test','user')").run();
db.prepare("INSERT INTO users (id,email,role) VALUES ('u-editor','editor@t.test','user')").run();
db.prepare("INSERT INTO users (id,email,role) VALUES ('u-viewer','viewer@t.test','user')").run();
db.prepare("INSERT INTO users (id,email,role) VALUES ('u-other','other@t.test','user')").run(); // ws-b admin, different org
db.prepare("INSERT INTO users (id,email,role) VALUES ('u-nobody','nobody@t.test','user')").run(); // no org, no workspace at all

db.prepare("INSERT INTO organizations (id,name,owner_user_id) VALUES ('org-a','Org A','u-orgowner')").run();
db.prepare("INSERT INTO organizations (id,name,owner_user_id) VALUES ('org-b','Org B','u-other')").run();
db.prepare("INSERT INTO organization_members (organization_id,user_id,role) VALUES ('org-a','u-orgowner','org_owner')").run();
db.prepare("INSERT INTO organization_members (organization_id,user_id,role) VALUES ('org-b','u-other','org_owner')").run();

db.prepare("INSERT INTO workspaces (id,organization_id,name) VALUES ('ws-a','org-a','WS A')").run();
db.prepare("INSERT INTO workspaces (id,organization_id,name) VALUES ('ws-b','org-b','WS B')").run();
db.prepare("INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ('ws-a','u-wsadmin','workspace_admin')").run();
db.prepare("INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ('ws-a','u-editor','workspace_editor')").run();
db.prepare("INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ('ws-a','u-viewer','workspace_viewer')").run();
db.prepare("INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ('ws-b','u-other','workspace_admin')").run();

db.prepare("INSERT INTO plans (id,display_name,stripe_price_monthly,stripe_price_yearly) VALUES ('pro','Pro','price_pro_monthly','price_pro_yearly')").run();

// Tokens carry a real current_workspace_id, mirroring what a real login/
// workspace-switch actually mints (unlike some older RBAC test files here
// that pass null) - org_owner's JWT points at ws-a even though they have no
// workspace_members row there, exactly like acting-as in the live app.
const tok = (id, wsId) => generateToken(db.prepare('SELECT id,email,role FROM users WHERE id = ?').get(id), wsId || null);
const T = {
  plat: tok('u-plat', null),
  orgOwner: tok('u-orgowner', 'ws-a'),
  wsAdmin: tok('u-wsadmin', 'ws-a'),
  editor: tok('u-editor', 'ws-a'),
  viewer: tok('u-viewer', 'ws-a'),
  other: tok('u-other', 'ws-b'),
  nobody: tok('u-nobody', null),
};

const app = express();
app.use(express.json());
app.use('/api/stripe', requireAuth, require('../routes/stripe'));
app.use((err, req, res, _next) => { res.status(500).json({ error: err.message, stack: err.stack }); });
const server = app.listen(0);
let base;
test.before(async () => {
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); db.close(); });

const call = (path, token, body) =>
  fetch(base + '/api/stripe' + path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });

// -------------------------------------------------------------------

test('RBAC matrix: /checkout - full role sweep', async () => {
  const body = { plan_id: 'pro', interval: 'monthly' };

  // Positive cases.
  const owner = await call('/checkout', T.orgOwner, body);
  assert.equal(owner.status, 200, 'org_owner should succeed');
  assert.ok((await owner.json()).url, 'org_owner gets a real checkout URL back');

  const plat = await call('/checkout', T.plat, body);
  assert.equal(plat.status, 200, 'platform_admin override should succeed');
  assert.ok((await plat.json()).url);

  // u-other is org-b's own real org_owner, resolving via ws-b - this endpoint
  // has no target-org/workspace id in its request body (it always acts on
  // the CALLER's own current-workspace-derived org), so unlike
  // regions.test.js's URL-param cross-org checks, there's no "org-b's owner
  // reaches into org-a" case to construct here. This is instead the positive
  // proof that multi-tenant isolation holds the other direction: a second,
  // completely separate org's real owner still succeeds for their OWN org.
  const otherOwner = await call('/checkout', T.other, body);
  assert.equal(otherOwner.status, 200, "org-b's own org_owner should succeed for their own org");
  assert.ok((await otherOwner.json()).url);

  // Negative cases: real roles in ws-a, none of them org_owner/org_admin/platform anywhere.
  for (const [label, token] of [
    ['workspace_admin', T.wsAdmin],
    ['workspace_editor', T.editor],
    ['workspace_viewer', T.viewer],
    ['non-member (no org, no workspace at all)', T.nobody],
  ]) {
    const res = await call('/checkout', token, body);
    assert.equal(res.status, 403, `${label} should be denied`);
    assert.equal((await res.json()).error, 'Organization owner access required');
  }
});

test('RBAC matrix: /portal - full role sweep', async () => {
  // NOTE on the two non-403 statuses below: requireAuth's own SELECT
  // (server/middleware/auth.js) never fetches stripe_customer_id, so
  // req.user.stripe_customer_id is undefined for EVERY caller regardless of
  // role - a real, pre-existing, separate bug (portal 400s "No billing
  // account found" for literally everyone, including a genuine org_owner
  // with real billing history). That's unrelated to this RBAC fix and
  // predates it; asserted here as 400-not-403 specifically because that
  // distinction is what proves THIS gate passed them through correctly -
  // they reached the pre-existing handler bug, they weren't denied by RBAC.
  const owner = await call('/portal', T.orgOwner, {});
  assert.equal(owner.status, 400, 'org_owner clears the RBAC gate, then hits the pre-existing no-customer-id bug (not a 403)');

  const plat = await call('/portal', T.plat, {});
  assert.equal(plat.status, 400, 'platform_admin override clears RBAC too, same pre-existing 400');

  const otherOwner = await call('/portal', T.other, {});
  assert.equal(otherOwner.status, 400, "org-b's own org_owner also clears RBAC, then hits the same pre-existing bug");

  for (const [label, token] of [
    ['workspace_admin', T.wsAdmin],
    ['workspace_editor', T.editor],
    ['workspace_viewer', T.viewer],
    ['non-member (no org, no workspace at all)', T.nobody],
  ]) {
    const res = await call('/portal', token, {});
    assert.equal(res.status, 403, `${label} should be denied`);
    assert.equal((await res.json()).error, 'Organization owner access required');
  }
});

test('real org_owner flow is not broken: checkout genuinely succeeds end to end', async () => {
  // Simulates the actual frontend call (billing.js window._checkout) for the
  // one role that should be able to do this at all. Uses the real
  // requireAuth (not a stub), so this reflects exactly what a live org_owner
  // session gets back.
  const checkout = await call('/checkout', T.orgOwner, { plan_id: 'pro', interval: 'yearly' });
  assert.equal(checkout.status, 200);
  const checkoutBody = await checkout.json();
  assert.equal(checkoutBody.type, 'checkout');
  assert.ok(checkoutBody.url.startsWith('https://fake.stripe.test/checkout/'), 'a real, usable Stripe Checkout URL comes back');
});
