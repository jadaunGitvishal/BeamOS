'use strict';

// Ref 73 — read-only ticket surface for the public API-token door
// (routes/tickets-readonly.js, mounted at /api/tickets in PUBLIC_ROUTERS).
//
// The real middleware chain (requireAuth/bearerAuth/resolveTenancy/tokenScopeGate)
// + the real route files, mounted exactly as server.js mounts them from
// config/api-surface.js (helpers/inprocess-app.js), against the REAL MySQL test DB
// (beamos_test via npm test). Covers:
//   - a read-scope token CAN list/get-single/sla-summary via /api/tickets
//   - the SAME data as the JWT-facing /api/workspaces/:id/tickets routes
//     (same shape, same rows) - proves lib/ticket-query.js isn't drifting
//   - a read-scope token gets 401 on /api/workspaces (still fully JWT-only -
//     ticket creation/update never became token-reachable)
//   - /api/tickets has no write route at all (POST/PATCH -> 404, not 403 -
//     there is nothing there to scope-gate)
//   - workspace binding: a token only ever sees its OWN bound workspace's
//     tickets via /api/tickets, matching apiToken.js's binding guarantee
//
// Fixtures are test-owned (tr- prefix, generated ids) and removed afterwards (the
// tokens and tickets go with their users' orgs).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const { generateToken } = require('../middleware/auth');
const { startInProcessApp } = require('./helpers/inprocess-app');
const { randTag, cleanupUsers } = require('./helpers/disposable');

const P = `tr-${randTag()}`;
const id = (name) => `${P}-${name}`;
const ID = {
  admin: id('admin'), other: id('other'), orgA: id('org-a'), orgB: id('org-b'),
  wsA: id('ws-a'), wsB: id('ws-b'), tkA1: id('tk-a1'), tkA2: id('tk-a2'), tkB1: id('tk-b1'),
};
let app;
let jwtAdmin;
let readToken;
let writeToken;

const call = (method, path, token, body) =>
  fetch(app.base + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

before(async () => {
  // /api/tokens - JWT-only, tenancy:true (mint the read-scope token under test).
  // /api/workspaces - JWT-only, no tenancy (proves tickets stay unreachable by token there).
  // /api/tickets - PUBLIC (token door): bearerAuth + resolveTenancy + tokenScopeGate.
  app = await startInProcessApp({ only: ['/api/tokens', '/api/workspaces', '/api/tickets'] });
  const run = (sql, ...p) => app.db.prepare(sql).run(...p);

  const user = "INSERT INTO users (id, email, name, password_hash, auth_provider, role) VALUES (?, ?, ?, NULL, 'local', 'user')";
  await run(user, ID.admin, `${ID.admin}@t.test`, ID.admin);
  await run(user, ID.other, `${ID.other}@t.test`, ID.other);
  const org = "INSERT INTO organizations (id, name, owner_user_id, plan_id, subscription_status) VALUES (?, ?, ?, 'enterprise', 'active')";
  await run(org, ID.orgA, `${P} Org A`, ID.admin);
  await run(org, ID.orgB, `${P} Org B`, ID.other);
  await run("INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'org_owner')", ID.orgA, ID.admin);
  await run("INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'org_owner')", ID.orgB, ID.other);
  await run('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)', ID.wsA, ID.orgA, `${P} WS A`);
  await run('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)', ID.wsB, ID.orgB, `${P} WS B`);
  await run("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin')", ID.wsA, ID.admin);
  await run("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin')", ID.wsB, ID.other);

  // tickets: two in ws-a (one high/breached-by-age, one low), one in ws-b (must
  // never be visible through the ws-a-bound token).
  const H = 3600;
  const NOW = Math.floor(Date.now() / 1000);
  const tk = 'INSERT INTO tickets (id, workspace_id, title, priority, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)';
  await run(tk, ID.tkA1, ID.wsA, 'A high ticket', 'high', 'open', NOW - 6 * H, NOW - 6 * H); // 6h old, 4h target -> breached
  await run(tk, ID.tkA2, ID.wsA, 'A low ticket', 'low', 'open', NOW, NOW);
  await run(tk, ID.tkB1, ID.wsB, 'B ticket', 'medium', 'open', NOW, NOW);

  jwtAdmin = generateToken({ id: ID.admin, email: `${ID.admin}@t.test`, role: 'user' }, ID.wsA);
  const r = await call('POST', '/api/tokens', jwtAdmin, { name: 'bi-read', scope: 'read' });
  assert.equal(r.status, 201, 'token creation must succeed');
  readToken = (await r.json()).token;
  const w = await call('POST', '/api/tokens', jwtAdmin, { name: 'bi-write', scope: 'write' });
  assert.equal(w.status, 201);
  writeToken = (await w.json()).token;
});

after(async () => {
  try {
    if (app) await cleanupUsers(app.db, [ID.other, ID.admin]);
  } finally {
    if (app) await app.stop(); else await db.close();
  }
});

// -------------------------------------------------------------------

test('GET /api/tickets: read-scope token lists only its bound workspace\'s tickets', async () => {
  const r = await call('GET', '/api/tickets', readToken);
  assert.equal(r.status, 200);
  const rows = await r.json();
  const titles = rows.map((t) => t.title).sort();
  assert.deepEqual(titles, ['A high ticket', 'A low ticket'], 'ws-b ticket must never appear');
});

test('GET /api/tickets: shape matches the JWT-facing /api/workspaces/:id/tickets route byte-for-byte', async () => {
  const viaToken = await (await call('GET', '/api/tickets', readToken)).json();
  const viaJwt = await (await call('GET', `/api/workspaces/${ID.wsA}/tickets`, jwtAdmin)).json();
  const norm = (rows) => rows.map((t) => ({ ...t })).sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(norm(viaToken), norm(viaJwt), 'same query, same shape, no drift between the two surfaces');
});

test('GET /api/tickets/sla-summary: read-scope token gets the rollup for its bound workspace', async () => {
  const r = await call('GET', '/api/tickets/sla-summary', readToken);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.workspace_id, ID.wsA);
  assert.equal(body.counts.breached, 1, 'tk-a1 (6h old, high/4h target) is breached');
  assert.equal(body.total_open, 2);
});

test('GET /api/tickets/:ticketId: read-scope token can get a single ticket in its workspace, 404 for another workspace\'s', async () => {
  const own = await call('GET', `/api/tickets/${ID.tkA1}`, readToken);
  assert.equal(own.status, 200);
  assert.equal((await own.json()).title, 'A high ticket');

  const foreign = await call('GET', `/api/tickets/${ID.tkB1}`, readToken);
  assert.equal(foreign.status, 404, 'a ticket in another workspace must not be reachable, not even by ID');
});

test('write boundary: a read-scope token is rejected on any mutation attempt against /api/tickets', async () => {
  // tokenScopeGate runs BEFORE the router and rejects any non-GET/HEAD method
  // for a 'read' token with 403 - it never even reaches the router to discover
  // there is no matching route there at all (tickets-readonly.js defines only
  // GET handlers).
  assert.equal((await call('POST', '/api/tickets', readToken, { title: 'nope' })).status, 403);
  assert.equal((await call('PATCH', `/api/tickets/${ID.tkA1}`, readToken, { status: 'closed' })).status, 403);
});

test('write boundary: even a write-scope token gets 404 on /api/tickets - the route genuinely does not exist', async () => {
  // Passes tokenScopeGate (write satisfies write) and still 404s: proves the
  // read-only-ness is structural (no handler defined), not just scope-gated.
  assert.equal((await call('POST', '/api/tickets', writeToken, { title: 'nope' })).status, 404);
  assert.equal((await call('PATCH', `/api/tickets/${ID.tkA1}`, writeToken, { status: 'closed' })).status, 404);
});

test('write boundary (no regression): a read-scope token still gets 401 on /api/workspaces (fully JWT-only)', async () => {
  assert.equal((await call('GET', `/api/workspaces/${ID.wsA}/tickets`, readToken)).status, 401);
  assert.equal((await call('POST', `/api/workspaces/${ID.wsA}/tickets`, readToken, { title: 'nope' })).status, 401);
  assert.equal((await call('PATCH', `/api/workspaces/${ID.wsA}/tickets/${ID.tkA1}`, readToken, { status: 'closed' })).status, 401);
});

test('a JWT session is unaffected: still reaches both /api/tickets and /api/workspaces', async () => {
  assert.equal((await call('GET', '/api/tickets', jwtAdmin)).status, 200);
  assert.equal((await call('GET', `/api/workspaces/${ID.wsA}/tickets`, jwtAdmin)).status, 200);
});
