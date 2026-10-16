'use strict';

// Fix verification: POST /api/stripe/checkout and /portal previously only
// required requireAuth (any authenticated org member), never the org_owner
// restriction lib/permissions.js's own comment documented as intended
// ("org_owner also has billing.write ... not exposed in 2.1"). Both routes
// now chain resolveTenancy + a canAdminOrg-gated requireBillingOwner.
//
// The REAL MySQL test DB (beamos_test via npm test) + the real stripe router, mounted
// exactly as server.js mounts it (app.use('/api/stripe', router) - each route does its
// own requireAuth + resolveTenancy + requireBillingOwner). The 'stripe' package itself is
// stubbed via require.cache so a real Stripe secret key/network call is never needed -
// this tests OUR authorization gate, not Stripe's API.
//
// Fixtures are test-owned (sba- prefix, generated ids), including the plan: the schema's
// seeded 'pro' plan has no Stripe price ids, so this file adds its own plan with prices
// (deleted by id afterwards). Deleting the users cascades their orgs and workspaces.

const test = require('node:test');
const assert = require('node:assert/strict');

// A fake key so routes/stripe builds its (stubbed) client; read by config at load.
process.env.STRIPE_SECRET_KEY = 'sk_test_fake_for_rbac_verification';

// Stub the 'stripe' SDK itself - constructor returns a fake client whose
// methods return just enough shape for the route handlers to succeed.
// Installed (with the fake key above) before routes/stripe loads.
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

const { db } = require('../db/database');
const { generateToken } = require('../middleware/auth');
const { startInProcessApp } = require('./helpers/inprocess-app');
const { randTag, cleanupUsers } = require('./helpers/disposable');

const P = `sba-${randTag()}`;
const id = (name) => `${P}-${name}`;
const U = {
  plat: id('u-plat'), orgOwner: id('u-orgowner'), wsAdmin: id('u-wsadmin'), editor: id('u-editor'),
  viewer: id('u-viewer'), other: id('u-other'), nobody: id('u-nobody'),
};
const ID = { orgA: id('org-a'), orgB: id('org-b'), wsA: id('ws-a'), wsB: id('ws-b'), plan: id('pro') };

let app;
let base;
const T = {};

test.before(async () => {
  app = await startInProcessApp({ only: [] });
  app.app.use('/api/stripe', require('../routes/stripe'));
  base = app.base;
  const run = (sql, ...p) => db.prepare(sql).run(...p);

  // --- fixtures --------------------------------------------------------
  // org-a: owner u-orgowner (org_owner, no direct workspace_members row - acts
  // in via the org path, exactly how a real org_owner reaches a workspace they
  // didn't personally join). ws-a carries the workspace-tier roles under test.
  const user = "INSERT INTO users (id, email, role, password_hash, auth_provider, stripe_customer_id) VALUES (?, ?, ?, NULL, 'local', ?)";
  await run(user, U.plat, `${P}-plat@t.test`, 'platform_admin', null);
  // stripe_customer_id is set here deliberately, to demonstrate the separate
  // pre-existing bug documented on the /portal test below: requireAuth never
  // selects this column, so it's undefined on req.user regardless of what's
  // actually in this row.
  await run(user, U.orgOwner, `${P}-orgowner@t.test`, 'user', 'cus_preexisting');
  await run(user, U.wsAdmin, `${P}-wsadmin@t.test`, 'user', null);
  await run(user, U.editor, `${P}-editor@t.test`, 'user', null);
  await run(user, U.viewer, `${P}-viewer@t.test`, 'user', null);
  await run(user, U.other, `${P}-other@t.test`, 'user', null); // ws-b admin, different org
  await run(user, U.nobody, `${P}-nobody@t.test`, 'user', null); // no org, no workspace at all

  const org = "INSERT INTO organizations (id, name, owner_user_id, plan_id, subscription_status) VALUES (?, ?, ?, 'enterprise', 'active')";
  await run(org, ID.orgA, `${P} Org A`, U.orgOwner);
  await run(org, ID.orgB, `${P} Org B`, U.other);
  await run("INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'org_owner')", ID.orgA, U.orgOwner);
  await run("INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'org_owner')", ID.orgB, U.other);

  await run('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)', ID.wsA, ID.orgA, 'WS A');
  await run('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)', ID.wsB, ID.orgB, 'WS B');
  const wm = 'INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)';
  await run(wm, ID.wsA, U.wsAdmin, 'workspace_admin');
  await run(wm, ID.wsA, U.editor, 'workspace_editor');
  await run(wm, ID.wsA, U.viewer, 'workspace_viewer');
  await run(wm, ID.wsB, U.other, 'workspace_admin');

  await run("INSERT INTO plans (id, name, display_name, stripe_price_monthly, stripe_price_yearly) VALUES (?, ?, 'Pro', 'price_pro_monthly', 'price_pro_yearly')", ID.plan, ID.plan);

  // Tokens carry a real current_workspace_id, mirroring what a real login/
  // workspace-switch actually mints (unlike some older RBAC test files here
  // that pass null) - org_owner's JWT points at ws-a even though they have no
  // workspace_members row there, exactly like acting-as in the live app.
  const tok = async (uid, wsId) => generateToken(await db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(uid), wsId || null);
  T.plat = await tok(U.plat, null);
  T.orgOwner = await tok(U.orgOwner, ID.wsA);
  T.wsAdmin = await tok(U.wsAdmin, ID.wsA);
  T.editor = await tok(U.editor, ID.wsA);
  T.viewer = await tok(U.viewer, ID.wsA);
  T.other = await tok(U.other, ID.wsB);
  T.nobody = await tok(U.nobody, null);
});

test.after(async () => {
  try {
    if (app) {
      await db.prepare('DELETE FROM plans WHERE id = ?').run(ID.plan);
      // Members before owners: an org owner is deletable once its other members are gone.
      await cleanupUsers(db, [U.nobody, U.viewer, U.editor, U.wsAdmin, U.plat, U.other, U.orgOwner]);
    }
  } finally {
    if (app) await app.stop(); else await db.close();
  }
});

const call = (path, token, body) =>
  fetch(base + '/api/stripe' + path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });

// -------------------------------------------------------------------

test('RBAC matrix: /checkout - full role sweep', async () => {
  const body = { plan_id: ID.plan, interval: 'monthly' };

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
  const checkout = await call('/checkout', T.orgOwner, { plan_id: ID.plan, interval: 'yearly' });
  assert.equal(checkout.status, 200);
  const checkoutBody = await checkout.json();
  assert.equal(checkoutBody.type, 'checkout');
  assert.ok(checkoutBody.url.startsWith('https://fake.stripe.test/checkout/'), 'a real, usable Stripe Checkout URL comes back');
});
