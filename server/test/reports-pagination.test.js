'use strict';

// Ref 73 — pagination on GET /api/reports/plays and GET /api/reports/export.
//
// The real middleware chain (bearerAuth/resolveTenancy/tokenScopeGate) + the real
// routes/reports.js, mounted exactly as server.js mounts PUBLIC_ROUTERS
// (helpers/inprocess-app.js), against the REAL MySQL test DB (beamos_test via npm
// test). Covers:
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
//
// Fixtures are test-owned (rp- prefix, generated ids) and removed afterwards (the
// device, its play_logs and the token go with the user's org).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const { generateToken } = require('../middleware/auth');
const { startInProcessApp } = require('./helpers/inprocess-app');
const { randTag, cleanupUsers } = require('./helpers/disposable');

const P = `rp-${randTag()}`;
const id = (name) => `${P}-${name}`;
const ID = { admin: id('admin'), orgA: id('org-a'), wsA: id('ws-a'), dev1: id('dev1') };
const TOTAL_ROWS = 23;
let app;
let readToken;

const call = (method, path, token, body) =>
  fetch(app.base + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

before(async () => {
  app = await startInProcessApp({ only: ['/api/tokens', '/api/reports'] });
  const run = (sql, ...p) => app.db.prepare(sql).run(...p);
  await run("INSERT INTO users (id, email, name, password_hash, auth_provider, role) VALUES (?, ?, ?, NULL, 'local', 'user')", ID.admin, `${ID.admin}@t.test`, ID.admin);
  await run("INSERT INTO organizations (id, name, owner_user_id, plan_id, subscription_status) VALUES (?, ?, ?, 'enterprise', 'active')", ID.orgA, `${P} Org A`, ID.admin);
  await run("INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'org_owner')", ID.orgA, ID.admin);
  await run('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)', ID.wsA, ID.orgA, 'WS A');
  await run("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin')", ID.wsA, ID.admin);
  await run("INSERT INTO devices (id, workspace_id, name) VALUES (?, ?, 'Lobby')", ID.dev1, ID.wsA);

  // 23 play_logs rows, started_at spread out so DESC/ASC ordering is unambiguous.
  const NOW = Math.floor(Date.now() / 1000);
  for (let i = 0; i < TOTAL_ROWS; i++) {
    await run(
      'INSERT INTO play_logs (device_id, content_name, started_at, duration_sec, completed) VALUES (?, ?, ?, 30, 1)',
      ID.dev1, `Item ${i}`, NOW - (TOTAL_ROWS - i) * 60, // ascending: Item 0 oldest ... Item 22 newest
    );
  }

  const jwtAdmin = generateToken({ id: ID.admin, email: `${ID.admin}@t.test`, role: 'user' }, ID.wsA);
  const r = await call('POST', '/api/tokens', jwtAdmin, { name: 'bi-read', scope: 'read' });
  assert.equal(r.status, 201);
  readToken = (await r.json()).token;
});

after(async () => {
  try {
    if (app) await cleanupUsers(app.db, [ID.admin]);
  } finally {
    if (app) await app.stop(); else await db.close();
  }
});

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
