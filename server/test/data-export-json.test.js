'use strict';

// Ref 21: verification for the `format=json` branch added to the 13 export
// endpoints that already emit CSV/XLSX/PDF.
//
// Same harness shape as tenancy-cross-tenant.test.js and
// dashboard-content-export.test.js: an in-memory sqlite swapped in for
// ../db/database, the REAL Express app with the real requireAuth +
// resolveTenancy chain, routers mounted exactly as server.js mounts them.
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

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

process.env.JWT_SECRET = 'test-secret-data-export-json';

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE users (
    id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT DEFAULT '',
    password_hash TEXT, auth_provider TEXT NOT NULL DEFAULT 'local', avatar_url TEXT,
    role TEXT NOT NULL DEFAULT 'user', plan_id TEXT DEFAULT 'free', email_alerts INTEGER DEFAULT 1,
    must_change_password INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE organizations (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_user_id TEXT NOT NULL
  );
  CREATE TABLE organization_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT, organization_id TEXT NOT NULL, user_id TEXT NOT NULL,
    role TEXT NOT NULL, invited_by TEXT, joined_at INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE workspaces (
    id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, name TEXT NOT NULL
  );
  CREATE TABLE workspace_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, user_id TEXT NOT NULL,
    role TEXT NOT NULL, joined_at INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE devices (
    id TEXT PRIMARY KEY, workspace_id TEXT, name TEXT DEFAULT '', playlist_id TEXT,
    status TEXT DEFAULT 'offline'
  );
  CREATE TABLE content (
    id TEXT PRIMARY KEY, user_id TEXT, workspace_id TEXT, filename TEXT, filepath TEXT DEFAULT '',
    mime_type TEXT, file_size INTEGER DEFAULT 0, duration_sec REAL, thumbnail_path TEXT,
    width INTEGER, height INTEGER, remote_url TEXT, folder TEXT, folder_id TEXT,
    created_at INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE widgets (
    id TEXT PRIMARY KEY, user_id TEXT, workspace_id TEXT, widget_type TEXT NOT NULL,
    name TEXT NOT NULL, config TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE playlists (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT, name TEXT NOT NULL,
    description TEXT, is_auto_generated INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'draft',
    published_snapshot TEXT, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE playlist_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, playlist_id TEXT NOT NULL, content_id TEXT, widget_id TEXT,
    zone_id TEXT, sort_order INTEGER NOT NULL DEFAULT 0, duration_sec INTEGER NOT NULL DEFAULT 10,
    muted INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE video_walls (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT, name TEXT NOT NULL,
    grid_cols INTEGER NOT NULL DEFAULT 2, grid_rows INTEGER NOT NULL DEFAULT 2,
    created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE video_wall_devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT, wall_id TEXT NOT NULL, device_id TEXT NOT NULL,
    grid_col INTEGER NOT NULL DEFAULT 0, grid_row INTEGER NOT NULL DEFAULT 0
  );
`);

const dbModulePath = require.resolve('../db/database');
require.cache[dbModulePath] = { id: dbModulePath, filename: dbModulePath, loaded: true, exports: { db } };

const express = require('express');
const { generateToken, requireAuth } = require('../middleware/auth');
const { resolveTenancy } = require('../lib/tenancy');

// --- Seed two tenants -----------------------------------------------------
db.prepare("INSERT INTO users (id, email, role, name) VALUES ('user-a', 'a@tenant-a.test', 'user', 'Alice A')").run();
db.prepare("INSERT INTO users (id, email, role, name) VALUES ('user-b', 'b@tenant-b.test', 'user', 'Bob B')").run();

db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES ('org-a', 'Org A', 'user-a')").run();
db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES ('org-b', 'Org B', 'user-b')").run();

db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES ('ws-a', 'org-a', 'Workspace A')").run();
db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES ('ws-b', 'org-b', 'Workspace B')").run();

db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES ('ws-a', 'user-a', 'workspace_admin', 1700000000)").run();
db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES ('ws-b', 'user-b', 'workspace_admin', 1700000001)").run();
// user-b has NO path into ws-a - the cross-tenant case.

// Canary rows: every TENANT-A-ONLY-* string must be absent from tenant B's exports.
db.prepare("INSERT INTO content (id, workspace_id, filename, mime_type, file_size, folder, created_at) VALUES ('c-a1', 'ws-a', 'TENANT-A-ONLY promo.mp4', 'video/mp4', 1024, 'Ads', 1700001000)").run();
db.prepare("INSERT INTO content (id, workspace_id, filename, mime_type, file_size, created_at) VALUES ('c-a2', 'ws-a', 'TENANT-A-ONLY safety.png', 'image/png', 512, 1700002000)").run();
db.prepare("INSERT INTO content (id, workspace_id, filename, mime_type, file_size, created_at) VALUES ('c-b1', 'ws-b', 'TENANT-B-ONLY menu.png', 'image/png', 256, 1700003000)").run();
// A platform-template row (workspace_id IS NULL) - both tenants' content/widget exports include it.
db.prepare("INSERT INTO content (id, workspace_id, filename, mime_type, file_size, created_at) VALUES ('c-tmpl', NULL, 'SHARED-TEMPLATE banner.jpg', 'image/jpeg', 128, 1700000500)").run();

db.prepare("INSERT INTO widgets (id, workspace_id, widget_type, name, config, created_at) VALUES ('w-a1', 'ws-a', 'clock', 'TENANT-A-ONLY Lobby Clock', '{}', 1700004000)").run();
db.prepare("INSERT INTO widgets (id, workspace_id, widget_type, name, config, created_at) VALUES ('w-b1', 'ws-b', 'weather', 'TENANT-B-ONLY Weather', '{}', 1700005000)").run();

db.prepare("INSERT INTO playlists (id, user_id, workspace_id, name, description, created_at) VALUES ('p-a1', 'user-a', 'ws-a', 'TENANT-A-ONLY Morning Loop', 'lobby', 1700006000)").run();
db.prepare("INSERT INTO playlists (id, user_id, workspace_id, name, description, created_at) VALUES ('p-b1', 'user-b', 'ws-b', 'TENANT-B-ONLY Evening Loop', NULL, 1700007000)").run();
db.prepare("INSERT INTO playlist_items (playlist_id, content_id) VALUES ('p-a1', 'c-a1')").run();
db.prepare("INSERT INTO playlist_items (playlist_id, content_id) VALUES ('p-a1', 'c-a2')").run();
db.prepare("INSERT INTO devices (id, workspace_id, name, playlist_id) VALUES ('d-a1', 'ws-a', 'Lobby A', 'p-a1')").run();

db.prepare("INSERT INTO video_walls (id, user_id, workspace_id, name, grid_cols, grid_rows, created_at) VALUES ('vw-a1', 'user-a', 'ws-a', 'TENANT-A-ONLY Atrium Wall', 3, 2, 1700008000)").run();
db.prepare("INSERT INTO video_walls (id, user_id, workspace_id, name, grid_cols, grid_rows, created_at) VALUES ('vw-b1', 'user-b', 'ws-b', 'TENANT-B-ONLY Foyer Wall', 2, 2, 1700009000)").run();
db.prepare("INSERT INTO video_wall_devices (wall_id, device_id, grid_col, grid_row) VALUES ('vw-a1', 'd-a1', 0, 0)").run();

const tokA = generateToken({ id: 'user-a', email: 'a@tenant-a.test', role: 'user' }, 'ws-a');
const tokB = generateToken({ id: 'user-b', email: 'b@tenant-b.test', role: 'user' }, 'ws-b');

// --- Real app, mounted exactly as server.js mounts these routers ----------
const app = express();
app.use(express.json());
app.use('/api/content', requireAuth, resolveTenancy, require('../routes/content'));
app.use('/api/widgets', requireAuth, resolveTenancy, require('../routes/widgets'));
app.use('/api/playlists', requireAuth, resolveTenancy, require('../routes/playlists'));
app.use('/api/walls', requireAuth, resolveTenancy, require('../routes/video-walls'));
app.use('/api/workspaces', requireAuth, require('../routes/workspaces'));
app.use((err, req, res, _next) => {
  res.status(500).json({ error: err.message, stack: err.stack });
});

const server = app.listen(0);
let base;
test.before(async () => {
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => {
  server.close();
  db.close();
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
  const res = await fetch(`${base}${path}${path.includes('?') ? '&' : '?'}format=json`, authed(token));
  const body = await res.json();
  return { res, body };
}
async function fetchCsv(path, token) {
  const res = await fetch(`${base}${path}${path.includes('?') ? '&' : '?'}format=csv`, authed(token));
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
  const body = await assertJsonMatchesCsv('/api/workspaces/ws-a/members/export', tokA);
  assert.match(JSON.stringify(body.rows), /a@tenant-a\.test/);
});

test('workspaces/:id/members/export: RBAC - non-member gets 403 on json, same as csv', async () => {
  const jr = await fetch(`${base}/api/workspaces/ws-a/members/export?format=json`, authed(tokB));
  assert.equal(jr.status, 403, 'json export denied cross-tenant');
  const cr = await fetch(`${base}/api/workspaces/ws-a/members/export?format=csv`, authed(tokB));
  assert.equal(cr.status, 403, 'csv export denied cross-tenant (same gate)');
});

test('unknown format still falls back to csv (json branch did not change the default)', async () => {
  const res = await fetch(`${base}/api/content/export?format=exe`, authed(tokA));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
});
