'use strict';

// Ref 21: verification for the `format=json` branch added to the 13 export
// endpoints that already emit CSV/XLSX/PDF.
//
// The REAL routers in-process (helpers/inprocess-app.js), mounted exactly as
// server.js mounts them - /api/content, /api/widgets, /api/playlists and /api/walls
// through the public front door (bearerAuth + resolveTenancy + tokenScopeGate; a JWT
// session passes it like a dashboard does), /api/workspaces behind requireAuth -
// against the REAL MySQL test DB (beamos_test via npm test).
//
// This exercises a representative 5 of the 13 endpoints (not all 13 - the
// branch is the identical three lines in every file, inserted ahead of the
// pre-existing xlsx/pdf/csv branches and fed the SAME `headers` / `dataRows`):
//
//   /api/content/export            (workspace-scoped list, report-export lib)
//   /api/widgets/export            (workspace-scoped list + shared templates)
//   /api/playlists/export          (workspace-scoped aggregation query)
//   /api/walls/export              (workspace-scoped aggregation query)
//   /api/workspaces/:id/members/export  (URL-param RBAC: canAccessWorkspace)
//
// For each: (1) format=json returns application/json as
// { columns: [...], rows: [[...]] }; (2) that payload is row-for-row identical
// to what format=csv returns for the very same request (proving JSON reuses
// the exact headers/dataRows the other formats do - no separate query, no
// separate scoping); (3) the SAME workspace-scoping / RBAC that gates the
// other three formats gates JSON too (tenant B never sees tenant A's canary
// rows; a non-member gets 403 on the members export).
//
// Fixtures are test-owned (dj- prefix, generated ids) and removed afterwards; the
// one workspace-less row (the shared template content) is deleted by id.

const test = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const { generateToken } = require('../middleware/auth');
const { startInProcessApp } = require('./helpers/inprocess-app');
const { randTag, cleanupUsers, cleanupRows } = require('./helpers/disposable');

const P = `dj-${randTag()}`;
const id = (name) => `${P}-${name}`;
const ID = {
  userA: id('user-a'), userB: id('user-b'), orgA: id('org-a'), orgB: id('org-b'), wsA: id('ws-a'), wsB: id('ws-b'),
  cA1: id('c-a1'), cA2: id('c-a2'), cB1: id('c-b1'), cTmpl: id('c-tmpl'), wA1: id('w-a1'), wB1: id('w-b1'),
  pA1: id('p-a1'), pB1: id('p-b1'), dA1: id('d-a1'), vwA1: id('vw-a1'), vwB1: id('vw-b1'),
};
const EMAIL_A = `${P}-a@tenant-a.test`;
const EMAIL_B = `${P}-b@tenant-b.test`;
let app;
let tokA;
let tokB;

test.before(async () => {
  app = await startInProcessApp({ only: ['/api/content', '/api/widgets', '/api/playlists', '/api/walls', '/api/workspaces'] });
  const run = (sql, ...p) => app.db.prepare(sql).run(...p);

  // --- Seed two tenants ---
  const user = "INSERT INTO users (id, email, role, name, password_hash, auth_provider) VALUES (?, ?, 'user', ?, NULL, 'local')";
  await run(user, ID.userA, EMAIL_A, 'Alice A');
  await run(user, ID.userB, EMAIL_B, 'Bob B');

  const org = "INSERT INTO organizations (id, name, owner_user_id, plan_id, subscription_status) VALUES (?, ?, ?, 'enterprise', 'active')";
  await run(org, ID.orgA, `${P} Org A`, ID.userA);
  await run(org, ID.orgB, `${P} Org B`, ID.userB);

  await run('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)', ID.wsA, ID.orgA, 'Workspace A');
  await run('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)', ID.wsB, ID.orgB, 'Workspace B');

  await run("INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, 'workspace_admin', 1700000000)", ID.wsA, ID.userA);
  await run("INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, 'workspace_admin', 1700000001)", ID.wsB, ID.userB);
  // user-b has NO path into ws-a - the cross-tenant case.

  // Canary rows: every TENANT-A-ONLY-* string must be absent from tenant B's exports.
  await run("INSERT INTO content (id, workspace_id, filename, mime_type, file_size, folder, created_at) VALUES (?, ?, 'TENANT-A-ONLY promo.mp4', 'video/mp4', 1024, 'Ads', 1700001000)", ID.cA1, ID.wsA);
  await run("INSERT INTO content (id, workspace_id, filename, mime_type, file_size, created_at) VALUES (?, ?, 'TENANT-A-ONLY safety.png', 'image/png', 512, 1700002000)", ID.cA2, ID.wsA);
  await run("INSERT INTO content (id, workspace_id, filename, mime_type, file_size, created_at) VALUES (?, ?, 'TENANT-B-ONLY menu.png', 'image/png', 256, 1700003000)", ID.cB1, ID.wsB);
  // A platform-template row (workspace_id IS NULL) - both tenants' content/widget exports include it.
  await run("INSERT INTO content (id, workspace_id, filename, mime_type, file_size, created_at) VALUES (?, NULL, 'SHARED-TEMPLATE banner.jpg', 'image/jpeg', 128, 1700000500)", ID.cTmpl);

  await run("INSERT INTO widgets (id, workspace_id, widget_type, name, config, created_at) VALUES (?, ?, 'clock', 'TENANT-A-ONLY Lobby Clock', '{}', 1700004000)", ID.wA1, ID.wsA);
  await run("INSERT INTO widgets (id, workspace_id, widget_type, name, config, created_at) VALUES (?, ?, 'weather', 'TENANT-B-ONLY Weather', '{}', 1700005000)", ID.wB1, ID.wsB);

  await run("INSERT INTO playlists (id, user_id, workspace_id, name, description, created_at) VALUES (?, ?, ?, 'TENANT-A-ONLY Morning Loop', 'lobby', 1700006000)", ID.pA1, ID.userA, ID.wsA);
  await run("INSERT INTO playlists (id, user_id, workspace_id, name, description, created_at) VALUES (?, ?, ?, 'TENANT-B-ONLY Evening Loop', NULL, 1700007000)", ID.pB1, ID.userB, ID.wsB);
  await run('INSERT INTO playlist_items (playlist_id, content_id) VALUES (?, ?)', ID.pA1, ID.cA1);
  await run('INSERT INTO playlist_items (playlist_id, content_id) VALUES (?, ?)', ID.pA1, ID.cA2);
  await run("INSERT INTO devices (id, workspace_id, name, playlist_id) VALUES (?, ?, 'Lobby A', ?)", ID.dA1, ID.wsA, ID.pA1);

  await run("INSERT INTO video_walls (id, user_id, workspace_id, name, grid_cols, grid_rows, created_at) VALUES (?, ?, ?, 'TENANT-A-ONLY Atrium Wall', 3, 2, 1700008000)", ID.vwA1, ID.userA, ID.wsA);
  await run("INSERT INTO video_walls (id, user_id, workspace_id, name, grid_cols, grid_rows, created_at) VALUES (?, ?, ?, 'TENANT-B-ONLY Foyer Wall', 2, 2, 1700009000)", ID.vwB1, ID.userB, ID.wsB);
  await run('INSERT INTO video_wall_devices (wall_id, device_id, grid_col, grid_row) VALUES (?, ?, 0, 0)', ID.vwA1, ID.dA1);

  tokA = generateToken({ id: ID.userA, email: EMAIL_A, role: 'user' }, ID.wsA);
  tokB = generateToken({ id: ID.userB, email: EMAIL_B, role: 'user' }, ID.wsB);
});

test.after(async () => {
  try {
    if (app) {
      await cleanupRows(app.db, 'content', [ID.cTmpl]);
      await cleanupUsers(app.db, [ID.userB, ID.userA]);
    }
  } finally {
    if (app) await app.stop(); else await db.close();
  }
});

function authed(token) {
  return { headers: { Authorization: `Bearer ${token}` } };
}

// Minimal RFC-4180 CSV parser (handles quoted fields, "" escapes, CRLF).
// Strips a leading UTF-8 BOM if present.
function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\r') {
      // swallow; \n handles the row break
    } else if (ch === '\n') {
      row.push(field); field = ''; rows.push(row); row = [];
    } else field += ch;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

// Normalise a JSON cell the way CSV serialisation would render it.
function asText(v) {
  return v === null || v === undefined ? '' : String(v);
}

async function fetchJson(path, token) {
  const res = await fetch(`${app.base}${path}${path.includes('?') ? '&' : '?'}format=json`, authed(token));
  const body = await res.json();
  return { res, body };
}
async function fetchCsv(path, token) {
  const res = await fetch(`${app.base}${path}${path.includes('?') ? '&' : '?'}format=csv`, authed(token));
  return { res, text: await res.text() };
}

// For a given endpoint: JSON payload shape is right, and it matches CSV exactly.
async function assertJsonMatchesCsv(path, token) {
  const { res: jr, body } = await fetchJson(path, token);
  assert.equal(jr.status, 200, `${path} json status`);
  assert.match(jr.headers.get('content-type'), /application\/json/, `${path} json content-type`);
  assert.ok(Array.isArray(body.columns), `${path} .columns is an array`);
  assert.ok(Array.isArray(body.rows), `${path} .rows is an array`);
  body.rows.forEach((r) => assert.ok(Array.isArray(r), `${path} each row is an array`));

  const { res: cr, text } = await fetchCsv(path, token);
  assert.equal(cr.status, 200, `${path} csv status`);
  const csv = parseCsv(text);
  const csvHeader = csv[0];
  const csvRows = csv.slice(1);

  assert.deepEqual(body.columns, csvHeader, `${path}: JSON columns == CSV header row`);
  assert.equal(body.rows.length, csvRows.length, `${path}: JSON row count == CSV row count`);
  body.rows.forEach((jsonRow, i) => {
    assert.deepEqual(jsonRow.map(asText), csvRows[i], `${path}: JSON row ${i} == CSV row ${i}`);
  });
  return body;
}

// ---------------------------------------------------------------------------

test('content/export: json shape + matches csv, tenant A', async () => {
  const body = await assertJsonMatchesCsv('/api/content/export', tokA);
  const flat = JSON.stringify(body.rows);
  assert.match(flat, /TENANT-A-ONLY promo\.mp4/);
  assert.match(flat, /TENANT-A-ONLY safety\.png/);
  assert.match(flat, /SHARED-TEMPLATE banner\.jpg/); // platform template is shared
  assert.doesNotMatch(flat, /TENANT-B-ONLY/);
});

test('content/export: tenant B json is workspace-scoped (no tenant A rows)', async () => {
  const { body } = await fetchJson('/api/content/export', tokB);
  const flat = JSON.stringify(body.rows);
  assert.match(flat, /TENANT-B-ONLY menu\.png/);
  assert.match(flat, /SHARED-TEMPLATE banner\.jpg/);
  assert.doesNotMatch(flat, /TENANT-A-ONLY/);
});

test('widgets/export: json shape + matches csv, tenant A', async () => {
  const body = await assertJsonMatchesCsv('/api/widgets/export', tokA);
  assert.match(JSON.stringify(body.rows), /TENANT-A-ONLY Lobby Clock/);
  assert.doesNotMatch(JSON.stringify(body.rows), /TENANT-B-ONLY/);
});

test('widgets/export: tenant B json is workspace-scoped', async () => {
  const { body } = await fetchJson('/api/widgets/export', tokB);
  assert.match(JSON.stringify(body.rows), /TENANT-B-ONLY Weather/);
  assert.doesNotMatch(JSON.stringify(body.rows), /TENANT-A-ONLY/);
});

test('playlists/export: json shape + matches csv (incl. numeric aggregate cells), tenant A', async () => {
  const body = await assertJsonMatchesCsv('/api/playlists/export', tokA);
  const row = body.rows.find((r) => r[0] === 'TENANT-A-ONLY Morning Loop');
  assert.ok(row, 'tenant A playlist present');
  assert.equal(row[2], 2, 'item count is the real number 2 in JSON (not a string)');
  assert.equal(row[3], 1, 'display count is the real number 1 in JSON');
});

test('playlists/export: tenant B json is workspace-scoped', async () => {
  const { body } = await fetchJson('/api/playlists/export', tokB);
  assert.match(JSON.stringify(body.rows), /TENANT-B-ONLY Evening Loop/);
  assert.doesNotMatch(JSON.stringify(body.rows), /TENANT-A-ONLY/);
});

test('walls/export: json shape + matches csv, tenant A', async () => {
  const body = await assertJsonMatchesCsv('/api/walls/export', tokA);
  const row = body.rows.find((r) => r[0] === 'TENANT-A-ONLY Atrium Wall');
  assert.ok(row, 'tenant A wall present');
  assert.equal(row[1], 1, 'device count is the real number 1 in JSON');
  assert.equal(row[2], '3x2', 'grid dimensions string');
});

test('walls/export: tenant B json is workspace-scoped', async () => {
  const { body } = await fetchJson('/api/walls/export', tokB);
  assert.match(JSON.stringify(body.rows), /TENANT-B-ONLY Foyer Wall/);
  assert.doesNotMatch(JSON.stringify(body.rows), /TENANT-A-ONLY/);
});

test('workspaces/:id/members/export: json shape + matches csv for a member', async () => {
  const body = await assertJsonMatchesCsv(`/api/workspaces/${ID.wsA}/members/export`, tokA);
  assert.match(JSON.stringify(body.rows), /a@tenant-a\.test/);
});

test('workspaces/:id/members/export: RBAC - non-member gets 403 on json, same as csv', async () => {
  const jr = await fetch(`${app.base}/api/workspaces/${ID.wsA}/members/export?format=json`, authed(tokB));
  assert.equal(jr.status, 403, 'json export denied cross-tenant');
  const cr = await fetch(`${app.base}/api/workspaces/${ID.wsA}/members/export?format=csv`, authed(tokB));
  assert.equal(cr.status, 403, 'csv export denied cross-tenant (same gate)');
});

test('unknown format still falls back to csv (json branch did not change the default)', async () => {
  const res = await fetch(`${app.base}/api/content/export?format=exe`, authed(tokA));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
});
