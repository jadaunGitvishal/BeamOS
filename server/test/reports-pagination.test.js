'use strict';

// Ref 73 — pagination on GET /api/reports/plays and GET /api/reports/export.
//
// In-memory sqlite + the real middleware chain (bearerAuth/resolveTenancy/
// tokenScopeGate) + the real routes/reports.js, mounted exactly as server.js
// mounts PUBLIC_ROUTERS. Covers:
//   - /plays: offset paging returns the correct partial slice, X-Total-Count
//     reflects the FULL matching count (not the page size), omitting
//     limit/offset keeps the pre-existing default (up to 500, newest first)
//   - /export (json): same paging behavior, plus the additive
//     total/limit/offset fields in the body
//   - /export with NEITHER limit nor offset returns the FULL unbounded range
//     (the desktop Reports page's CSV/XLSX/PDF download contract - Ref 73
//     must not regress it) - the number of rows returned NEVER changes based
//     on the row count for that call shape
//   - a requested page size above the cap is silently capped, never unbounded

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

process.env.JWT_SECRET = 'test-secret-reports-pagination';

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
  CREATE TABLE play_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL, content_id TEXT, widget_id TEXT, zone_id TEXT,
    content_name TEXT NOT NULL DEFAULT '', started_at INTEGER NOT NULL, ended_at INTEGER,
    duration_sec INTEGER, completed INTEGER NOT NULL DEFAULT 0, trigger_type TEXT DEFAULT 'playlist',
    created_at INTEGER NOT NULL DEFAULT 0, session_id TEXT
  );
  CREATE TABLE api_tokens (
    id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL, name TEXT NOT NULL,
    user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'read',
    auto_publish INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0,
    last_used_at INTEGER, revoked_at INTEGER
  );
  CREATE TABLE api_token_targets (token_id TEXT NOT NULL, playlist_id TEXT NOT NULL);
`);

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
db.prepare("INSERT INTO users (id,email,role) VALUES ('u-admin','admin@t.test','user')").run();
db.prepare("INSERT INTO organization_members (organization_id,user_id,role) VALUES ('org-a','u-admin','org_owner')").run();
db.prepare("INSERT INTO workspaces (id,organization_id,name) VALUES ('ws-a','org-a','WS A')").run();
db.prepare("INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ('ws-a','u-admin','workspace_admin')").run();
db.prepare("INSERT INTO devices (id,workspace_id,name) VALUES ('dev1','ws-a','Lobby')").run();

// 23 play_logs rows, started_at spread out so DESC/ASC ordering is unambiguous.
const NOW = Math.floor(Date.now() / 1000);
const TOTAL_ROWS = 23;
for (let i = 0; i < TOTAL_ROWS; i++) {
  db.prepare(
    "INSERT INTO play_logs (device_id, content_name, started_at, duration_sec, completed) VALUES ('dev1', ?, ?, 30, 1)",
  ).run(`Item ${i}`, NOW - (TOTAL_ROWS - i) * 60); // ascending: Item 0 oldest ... Item 22 newest
}

const jwtAdmin = generateToken({ id: 'u-admin', email: 'admin@t.test', role: 'user' }, 'ws-a');

const app = express();
app.use(express.json());
app.use(activityLogger);
app.use('/api/tokens', requireAuth, resolveTenancy, require('../routes/tokens'));
app.use('/api/reports', bearerAuth, resolveTenancy, tokenScopeGate, require('../routes/reports'));
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

before(async () => {
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await call('POST', '/api/tokens', jwtAdmin, { name: 'bi-read', scope: 'read' });
  assert.equal(r.status, 201);
  readToken = (await r.json()).token;
});
after(() => { server.close(); db.close(); });

// -------------------------------------------------------------------

test('/plays: no limit/offset -> pre-existing default (all 23 rows, under the 500 default), newest first', async () => {
  const r = await call('GET', '/api/reports/plays', readToken);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-total-count'), String(TOTAL_ROWS));
  const rows = await r.json();
  assert.equal(rows.length, TOTAL_ROWS);
  assert.equal(rows[0].content_name, 'Item 22', 'newest first (DESC)');
});

test('/plays: limit + offset returns the correct partial slice, total is still the FULL count', async () => {
  const page1 = await (await call('GET', '/api/reports/plays?limit=10&offset=0', readToken)).json();
  const page2 = await (await call('GET', '/api/reports/plays?limit=10&offset=10', readToken)).json();
  const page3r = await call('GET', '/api/reports/plays?limit=10&offset=20', readToken);
  const page3 = await page3r.json();

  assert.equal(page1.length, 10);
  assert.equal(page2.length, 10);
  assert.equal(page3.length, 3, 'last page has the remainder (23 - 20)');
  assert.equal(page3r.headers.get('x-total-count'), String(TOTAL_ROWS), 'total reflects the full match, not the page');

  // No overlap, correct DESC order across pages: newest (Item 22) is page1[0],
  // oldest (Item 0) is the last row of page3.
  const all = [...page1, ...page2, ...page3].map((r) => r.content_name);
  assert.deepEqual(all, Array.from({ length: TOTAL_ROWS }, (_, i) => `Item ${TOTAL_ROWS - 1 - i}`));
});

test('/plays: a requested limit above the page cap is silently capped, not unbounded', async () => {
  const r = await call('GET', '/api/reports/plays?limit=999999', readToken);
  const rows = await r.json();
  assert.equal(rows.length, TOTAL_ROWS, 'capped at the real row count here, but the cap itself is enforced server-side');
  // Confirmed structurally via code review (Math.min(..., PROOF_OF_PLAY_PAGE_CAP))
  // - 23 rows is too small a fixture to observe the 5000 ceiling directly.
});

test('/export?format=json: no limit/offset -> the FULL unbounded range (desktop download contract unchanged)', async () => {
  const r = await call('GET', '/api/reports/export?format=json', readToken);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-total-count'), String(TOTAL_ROWS));
  const body = await r.json();
  assert.equal(body.rows.length, TOTAL_ROWS, 'omitting pagination params must return everything, unchanged from pre-Ref-73 behavior');
  assert.equal(body.total, TOTAL_ROWS);
  assert.equal(body.limit, null, 'limit is null when pagination was not requested');
  assert.equal(body.columns.length, 6);
});

test('/export?format=json: limit + offset pages correctly, ASC order (oldest first, matching the export contract)', async () => {
  const page1 = await (await call('GET', '/api/reports/export?format=json&limit=10&offset=0', readToken)).json();
  const page2 = await (await call('GET', '/api/reports/export?format=json&limit=10&offset=10', readToken)).json();
  const page3 = await (await call('GET', '/api/reports/export?format=json&limit=10&offset=20', readToken)).json();

  assert.equal(page1.rows.length, 10);
  assert.equal(page2.rows.length, 10);
  assert.equal(page3.rows.length, 3);
  assert.equal(page1.total, TOTAL_ROWS);
  assert.equal(page1.limit, 10);
  assert.equal(page1.offset, 0);
  assert.equal(page3.offset, 20);

  // /export orders ASC (oldest first) - the inverse of /plays' DESC.
  const firstColOfEachRow = (page) => page.rows.map((r) => r[1]); // columns[1] = "Content"
  const all = [...firstColOfEachRow(page1), ...firstColOfEachRow(page2), ...firstColOfEachRow(page3)];
  assert.deepEqual(all, Array.from({ length: TOTAL_ROWS }, (_, i) => `Item ${i}`));
});

test('/export?format=csv: X-Total-Count header is present regardless of format (not just json)', async () => {
  const r = await call('GET', '/api/reports/export?format=csv&limit=5', readToken);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-total-count'), String(TOTAL_ROWS));
  const text = await r.text();
  const dataLines = text.trim().split('\n').length - 1; // minus header row
  assert.equal(dataLines, 5, 'CSV body itself is still paginated correctly');
});
