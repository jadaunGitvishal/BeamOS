'use strict';

// Ref 73 — read-only ticket surface for the public API-token door
// (routes/tickets-readonly.js, mounted at /api/tickets in PUBLIC_ROUTERS).
//
// In-memory sqlite + the real middleware chain (requireAuth/bearerAuth/
// resolveTenancy/tokenScopeGate) + the real route files, mounted exactly as
// server.js mounts them from config/api-surface.js. Covers:
//   - a read-scope token CAN list/get-single/sla-summary via /api/tickets
//   - the SAME data as the JWT-facing /api/workspaces/:id/tickets routes
//     (same shape, same rows) - proves lib/ticket-query.js isn't drifting
//   - a read-scope token gets 401 on /api/workspaces (still fully JWT-only -
//     ticket creation/update never became token-reachable)
//   - /api/tickets has no write route at all (POST/PATCH -> 404, not 403 -
//     there is nothing there to scope-gate)
//   - workspace binding: a token only ever sees its OWN bound workspace's
//     tickets via /api/tickets, matching apiToken.js's binding guarantee

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

process.env.JWT_SECRET = 'test-secret-tickets-readonly';

const db = new Database(':memory:');
db.function('UNIX_TIMESTAMP', () => Math.floor(Date.now() / 1000));
db.exec(`
  CREATE TABLE users (
    id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT DEFAULT '',
    password_hash TEXT, auth_provider TEXT NOT NULL DEFAULT 'local', avatar_url TEXT,
    role TEXT NOT NULL DEFAULT 'user', plan_id TEXT DEFAULT 'free', email_alerts INTEGER DEFAULT 1,
    must_change_password INTEGER NOT NULL DEFAULT 0
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
    id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL
  );
  CREATE TABLE devices (id TEXT PRIMARY KEY, workspace_id TEXT, name TEXT);
  CREATE TABLE tickets (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, device_id TEXT,
    title TEXT NOT NULL, description TEXT, owner_category TEXT NOT NULL DEFAULT 'unassigned',
    status TEXT NOT NULL DEFAULT 'open', priority TEXT NOT NULL DEFAULT 'medium',
    ticket_category TEXT NOT NULL DEFAULT 'reactive',
    created_by TEXT, auto_source TEXT, source_outage_start INTEGER,
    created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0, resolved_at INTEGER,
    UNIQUE (device_id, source_outage_start)
  );
  CREATE TABLE outage_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
    started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL DEFAULT 0, duration_seconds INTEGER NOT NULL DEFAULT 0,
    likely_cause TEXT
  );
  CREATE TABLE activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, device_id TEXT, action TEXT,
    details TEXT, ip_address TEXT, workspace_id TEXT, organization_id TEXT,
    acting_user_id TEXT, was_acting_as INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT 0, prev_hash TEXT, entry_hash TEXT
  );
  CREATE TABLE activity_log_chain (
    id INTEGER PRIMARY KEY, last_hash TEXT NOT NULL, entry_count INTEGER NOT NULL DEFAULT 0, updated_at INTEGER DEFAULT 0
  );
  CREATE TABLE api_tokens (
    id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL, name TEXT NOT NULL,
    user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'read',
    auto_publish INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0,
    last_used_at INTEGER, revoked_at INTEGER
  );
  CREATE TABLE api_token_targets (
    token_id TEXT NOT NULL, playlist_id TEXT NOT NULL
  );
`);
db.prepare("INSERT INTO activity_log_chain (id, last_hash, entry_count) VALUES (1, ?, 0)").run('0'.repeat(64));

const _rawExec = db.exec.bind(db);
db.transaction = (fn) => async (...args) => {
  _rawExec('BEGIN');
  try {
    const r = await fn(db, ...args);
    _rawExec('COMMIT');
    return r;
  } catch (e) {
    try { _rawExec('ROLLBACK'); } catch { /* already rolled back */ }
    throw e;
  }
};

const dbModulePath = require.resolve('../db/database');
require.cache[dbModulePath] = { id: dbModulePath, filename: dbModulePath, loaded: true, exports: { db } };

const express = require('express');
const { generateToken, requireAuth } = require('../middleware/auth');
const { bearerAuth, tokenScopeGate } = require('../middleware/apiToken');
const { resolveTenancy } = require('../lib/tenancy');
const { activityLogger } = require('../services/activity');

// --- fixtures ------------------------------------------------------------
db.prepare("INSERT INTO organizations (id,name,owner_user_id) VALUES ('org-a','Org A','u-admin')").run();
db.prepare("INSERT INTO organizations (id,name,owner_user_id) VALUES ('org-b','Org B','u-other')").run();
db.prepare("INSERT INTO users (id,email,role) VALUES ('u-admin','admin@t.test','user')").run();
db.prepare("INSERT INTO users (id,email,role) VALUES ('u-other','other@t.test','user')").run();
db.prepare("INSERT INTO organization_members (organization_id,user_id,role) VALUES ('org-a','u-admin','org_owner')").run();
db.prepare("INSERT INTO organization_members (organization_id,user_id,role) VALUES ('org-b','u-other','org_owner')").run();
db.prepare("INSERT INTO workspaces (id,organization_id,name) VALUES ('ws-a','org-a','WS A')").run();
db.prepare("INSERT INTO workspaces (id,organization_id,name) VALUES ('ws-b','org-b','WS B')").run();
db.prepare("INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ('ws-a','u-admin','workspace_admin')").run();
db.prepare("INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ('ws-b','u-other','workspace_admin')").run();

// tickets: two in ws-a (one high/breached-by-age, one low), one in ws-b (must
// never be visible through the ws-a-bound token).
const H = 3600;
const NOW = Math.floor(Date.now() / 1000);
db.prepare(
  "INSERT INTO tickets (id,workspace_id,title,priority,status,created_at,updated_at) VALUES ('tk-a1','ws-a','A high ticket','high','open',?,?)",
).run(NOW - 6 * H, NOW - 6 * H); // 6h old, 4h target -> breached
db.prepare(
  "INSERT INTO tickets (id,workspace_id,title,priority,status,created_at,updated_at) VALUES ('tk-a2','ws-a','A low ticket','low','open',?,?)",
).run(NOW, NOW);
db.prepare(
  "INSERT INTO tickets (id,workspace_id,title,priority,status,created_at,updated_at) VALUES ('tk-b1','ws-b','B ticket','medium','open',?,?)",
).run(NOW, NOW);

const jwtAdmin = generateToken({ id: 'u-admin', email: 'admin@t.test', role: 'user' }, 'ws-a');

const app = express();
app.use(express.json());
app.use(activityLogger);
// /api/tokens - JWT-only, tenancy:true (mint the read-scope token under test).
app.use('/api/tokens', requireAuth, resolveTenancy, require('../routes/tokens'));
// /api/workspaces - JWT-only, no tenancy (proves tickets stay unreachable by token there).
app.use('/api/workspaces', requireAuth, require('../routes/workspaces'));
// /api/tickets - PUBLIC (token door): bearerAuth + resolveTenancy + tokenScopeGate, exactly
// as server.js mounts every PUBLIC_ROUTERS entry.
app.use('/api/tickets', bearerAuth, resolveTenancy, tokenScopeGate, require('../routes/tickets-readonly'));
app.use((err, req, res, _next) => { res.status(500).json({ error: err.message, stack: err.stack }); });

const server = app.listen(0);
let base;
let readToken;

const call = (method, path, token, body) =>
  fetch(base + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

let writeToken;
before(async () => {
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await call('POST', '/api/tokens', jwtAdmin, { name: 'bi-read', scope: 'read' });
  assert.equal(r.status, 201, 'token creation must succeed');
  readToken = (await r.json()).token;
  const w = await call('POST', '/api/tokens', jwtAdmin, { name: 'bi-write', scope: 'write' });
  assert.equal(w.status, 201);
  writeToken = (await w.json()).token;
});
after(() => { server.close(); db.close(); });

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
  const viaJwt = await (await call('GET', '/api/workspaces/ws-a/tickets', jwtAdmin)).json();
  const norm = (rows) => rows.map((t) => ({ ...t })).sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(norm(viaToken), norm(viaJwt), 'same query, same shape, no drift between the two surfaces');
});

test('GET /api/tickets/sla-summary: read-scope token gets the rollup for its bound workspace', async () => {
  const r = await call('GET', '/api/tickets/sla-summary', readToken);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.workspace_id, 'ws-a');
  assert.equal(body.counts.breached, 1, 'tk-a1 (6h old, high/4h target) is breached');
  assert.equal(body.total_open, 2);
});

test('GET /api/tickets/:ticketId: read-scope token can get a single ticket in its workspace, 404 for another workspace\'s', async () => {
  const own = await call('GET', '/api/tickets/tk-a1', readToken);
  assert.equal(own.status, 200);
  assert.equal((await own.json()).title, 'A high ticket');

  const foreign = await call('GET', '/api/tickets/tk-b1', readToken);
  assert.equal(foreign.status, 404, 'a ticket in another workspace must not be reachable, not even by ID');
});

test('write boundary: a read-scope token is rejected on any mutation attempt against /api/tickets', async () => {
  // tokenScopeGate runs BEFORE the router and rejects any non-GET/HEAD method
  // for a 'read' token with 403 - it never even reaches the router to discover
  // there is no matching route there at all (tickets-readonly.js defines only
  // GET handlers).
  assert.equal((await call('POST', '/api/tickets', readToken, { title: 'nope' })).status, 403);
  assert.equal((await call('PATCH', '/api/tickets/tk-a1', readToken, { status: 'closed' })).status, 403);
});

test('write boundary: even a write-scope token gets 404 on /api/tickets - the route genuinely does not exist', async () => {
  // Passes tokenScopeGate (write satisfies write) and still 404s: proves the
  // read-only-ness is structural (no handler defined), not just scope-gated.
  assert.equal((await call('POST', '/api/tickets', writeToken, { title: 'nope' })).status, 404);
  assert.equal((await call('PATCH', '/api/tickets/tk-a1', writeToken, { status: 'closed' })).status, 404);
});

test('write boundary (no regression): a read-scope token still gets 401 on /api/workspaces (fully JWT-only)', async () => {
  assert.equal((await call('GET', '/api/workspaces/ws-a/tickets', readToken)).status, 401);
  assert.equal((await call('POST', '/api/workspaces/ws-a/tickets', readToken, { title: 'nope' })).status, 401);
  assert.equal((await call('PATCH', '/api/workspaces/ws-a/tickets/tk-a1', readToken, { status: 'closed' })).status, 401);
});

test('a JWT session is unaffected: still reaches both /api/tickets and /api/workspaces', async () => {
  assert.equal((await call('GET', '/api/tickets', jwtAdmin)).status, 200);
  assert.equal((await call('GET', '/api/workspaces/ws-a/tickets', jwtAdmin)).status, 200);
});
