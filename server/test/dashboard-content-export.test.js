'use strict';

// Workspace-scoping test for GET /api/dashboard/content/export (CSV/XLSX/PDF).
//
// Same shape as tenancy-cross-tenant.test.js: in-memory sqlite swapped in for
// ../db/database, the REAL Express app with the real requireAuth + resolveTenancy
// chain, mounted exactly as server.js mounts dashboard-content. Two orgs, two
// workspaces, one workspace_admin each, play_logs on a device in each workspace.
//
// The export re-uses queryContentAggregation, which scopes via
// getWorkspaceDeviceSubquery(req) - so a leak here would mean the same leak in
// GET /'s JSON. Each format is decoded and asserted to contain ONLY the caller's
// own workspace content, never the other tenant's.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const ExcelJS = require('exceljs');

process.env.JWT_SECRET = 'test-secret-dashboard-content-export';

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
    id INTEGER PRIMARY KEY AUTOINCREMENT, organization_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL
  );
  CREATE TABLE workspaces (
    id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, name TEXT NOT NULL
  );
  CREATE TABLE workspace_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, user_id TEXT NOT NULL,
    role TEXT NOT NULL, joined_at INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE devices (
    id TEXT PRIMARY KEY, workspace_id TEXT, name TEXT DEFAULT '', status TEXT DEFAULT 'offline'
  );
  CREATE TABLE play_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL, content_id TEXT, widget_id TEXT,
    zone_id TEXT, content_name TEXT NOT NULL DEFAULT '', started_at INTEGER NOT NULL, ended_at INTEGER,
    duration_sec INTEGER, completed INTEGER NOT NULL DEFAULT 0, trigger_type TEXT DEFAULT 'playlist',
    created_at INTEGER NOT NULL DEFAULT 0, session_id TEXT
  );
`);

const dbModulePath = require.resolve('../db/database');
require.cache[dbModulePath] = { id: dbModulePath, filename: dbModulePath, loaded: true, exports: { db } };

const express = require('express');
const { generateToken, requireAuth } = require('../middleware/auth');
const { resolveTenancy } = require('../lib/tenancy');

// --- Seed two tenants -------------------------------------------------------
db.prepare("INSERT INTO users (id, email, role) VALUES ('user-a', 'a@tenant-a.test', 'user')").run();
db.prepare("INSERT INTO users (id, email, role) VALUES ('user-b', 'b@tenant-b.test', 'user')").run();

db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES ('org-a', 'Org A', 'user-a')").run();
db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES ('org-b', 'Org B', 'user-b')").run();

db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES ('ws-a', 'org-a', 'Workspace A')").run();
db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES ('ws-b', 'org-b', 'Workspace B')").run();

db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('ws-a', 'user-a', 'workspace_admin')").run();
db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('ws-b', 'user-b', 'workspace_admin')").run();
// user-b has NO path into ws-a - the cross-tenant case.

db.prepare("INSERT INTO devices (id, workspace_id, name) VALUES ('device-a', 'ws-a', 'Lobby A')").run();
db.prepare("INSERT INTO devices (id, workspace_id, name) VALUES ('device-b', 'ws-b', 'Lobby B')").run();

// Content names are the tenant leak canaries: TENANT-A-ONLY-* must never appear
// in tenant B's export, and vice versa.
const now = Math.floor(Date.now() / 1000);
const play = (device, name, cid, dur, done) =>
  db.prepare(
    "INSERT INTO play_logs (device_id, content_id, content_name, started_at, ended_at, duration_sec, completed) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(device, cid, name, now - 3600, now - 3600 + dur, dur, done);

// Durations chosen to land on exact 1-decimal hours: 360s == 0.1h.
play('device-a', 'TENANT-A-ONLY Morning Promo', 'cid-a1', 1800, 1); // 2 x 1800s = 1.0h
play('device-a', 'TENANT-A-ONLY Morning Promo', 'cid-a1', 1800, 1);
play('device-a', 'TENANT-A-ONLY Safety Notice', 'cid-a2', 5400, 0); // 1 x 5400s = 1.5h, 0% done
play('device-b', 'TENANT-B-ONLY Cafeteria Menu', 'cid-b1', 3600, 1);
play('device-b', 'TENANT-B-ONLY Evening Recap', 'cid-b2', 9000, 1);

const tokA = generateToken({ id: 'user-a', email: 'a@tenant-a.test', role: 'user' }, 'ws-a');
const tokB = generateToken({ id: 'user-b', email: 'b@tenant-b.test', role: 'user' }, 'ws-b');

// --- Real app, mounted exactly as server.js mounts this router --------------
const app = express();
app.use(express.json());
app.use('/api/dashboard/content', requireAuth, resolveTenancy, require('../routes/dashboard-content'));
app.use((err, req, res, _next) => {
  res.status(500).json({ error: err.message });
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

async function csvText(token, format = 'csv') {
  const res = await fetch(`${base}/api/dashboard/content/export?format=${format}`, authed(token));
  assert.equal(res.status, 200);
  return { res, text: await res.text() };
}

function pdfTextOf(buf) {
  const { extractCells } = require('../scripts/pdf-text-dump');
  const tmp = path.join(os.tmpdir(), `dce-${crypto.randomBytes(4).toString('hex')}.pdf`);
  fs.writeFileSync(tmp, buf);
  try {
    return extractCells(tmp).map((c) => c.str).join(' ');
  } finally {
    fs.unlinkSync(tmp);
  }
}

async function xlsxText(buf) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const out = [];
  wb.getWorksheet('Content').eachRow((row) => {
    row.eachCell((cell) => out.push(String(cell.value)));
  });
  return out.join(' ');
}

// --- CSV ------------------------------------------------------------------
test('csv: tenant A sees only its own content, never tenant B', async () => {
  const { res, text } = await csvText(tokA);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="content-\d{4}-\d{2}-\d{2}\.csv"/);
  assert.match(text, /Content Name,Plays,Total Hours,Completion %,Content ID/);
  assert.match(text, /TENANT-A-ONLY Morning Promo/);
  assert.match(text, /TENANT-A-ONLY Safety Notice/);
  assert.doesNotMatch(text, /TENANT-B-ONLY/);
});

test('csv: tenant B sees only its own content, never tenant A', async () => {
  const { text } = await csvText(tokB);
  assert.match(text, /TENANT-B-ONLY Cafeteria Menu/);
  assert.match(text, /TENANT-B-ONLY Evening Recap/);
  assert.doesNotMatch(text, /TENANT-A-ONLY/);
});

test('csv: aggregation matches the on-screen numbers (plays / total hours / completion %)', async () => {
  const { text } = await csvText(tokA);
  const line = (prefix) => text.split('\r\n').find((l) => l.startsWith(prefix));
  // 2 plays x 1800s = 3600s = 1.0h, both completed -> 100
  assert.equal(line('TENANT-A-ONLY Morning Promo'), 'TENANT-A-ONLY Morning Promo,2,1,100,cid-a1');
  // 1 play x 5400s = 1.5h, not completed -> 0
  assert.equal(line('TENANT-A-ONLY Safety Notice'), 'TENANT-A-ONLY Safety Notice,1,1.5,0,cid-a2');
});

// --- XLSX ----------------------------------------------------------------
test('xlsx: correct content-type, and no cross-tenant leakage', async () => {
  const res = await fetch(`${base}/api/dashboard/content/export?format=xlsx`, authed(tokA));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /spreadsheetml\.sheet/);
  assert.match(res.headers.get('content-disposition'), /content-\d{4}-\d{2}-\d{2}\.xlsx/);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.slice(0, 2).toString('latin1'), 'PK'); // real xlsx (zip) magic
  const text = await xlsxText(buf);
  assert.match(text, /TENANT-A-ONLY Morning Promo/);
  assert.doesNotMatch(text, /TENANT-B-ONLY/);
});

// --- PDF ---------------------------------------------------------------
test('pdf: valid document, decodes to tenant A content only', async () => {
  const res = await fetch(`${base}/api/dashboard/content/export?format=pdf`, authed(tokA));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.match(res.headers.get('content-disposition'), /content-\d{4}-\d{2}-\d{2}\.pdf/);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.slice(0, 5).toString('latin1'), '%PDF-');
  const text = pdfTextOf(buf);
  assert.match(text, /Content Name/);
  assert.match(text, /TENANT-A-ONLY Morning Promo/);
  assert.doesNotMatch(text, /TENANT-B-ONLY/);
});

test('pdf: tenant B decode is disjoint from tenant A', async () => {
  const res = await fetch(`${base}/api/dashboard/content/export?format=pdf`, authed(tokB));
  const buf = Buffer.from(await res.arrayBuffer());
  const text = pdfTextOf(buf);
  assert.match(text, /TENANT-B-ONLY Cafeteria Menu/);
  assert.doesNotMatch(text, /TENANT-A-ONLY/);
});

// --- format fallback ---------------------------------------------------
test('unknown format falls back to csv (matches dashboard-devices behaviour)', async () => {
  const res = await fetch(`${base}/api/dashboard/content/export?format=exe`, authed(tokA));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
});

// --- control: GET / JSON is scoped the same way -----------------------
test('control: GET / JSON is also workspace-scoped (proves the shared query, not just the export)', async () => {
  const res = await fetch(`${base}/api/dashboard/content`, authed(tokB));
  assert.equal(res.status, 200);
  const body = await res.json();
  const names = body.content.map((c) => c.content_name).join(' ');
  assert.match(names, /TENANT-B-ONLY/);
  assert.doesNotMatch(names, /TENANT-A-ONLY/);
});
