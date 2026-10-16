'use strict';

// Workspace-scoping test for GET /api/dashboard/content/export (CSV/XLSX/PDF).
//
// The REAL dashboard-content router with the real requireAuth + resolveTenancy chain,
// mounted as server.js mounts it (helpers/inprocess-app.js), against the REAL MySQL test
// DB (beamos_test via npm test). Two orgs, two workspaces, one workspace_admin each,
// play_logs on a device in each workspace.
//
// The export re-uses queryContentAggregation, which scopes via
// getWorkspaceDeviceSubquery(req) - so a leak here would mean the same leak in
// GET /'s JSON. Each format is decoded and asserted to contain ONLY the caller's
// own workspace content, never the other tenant's.
//
// Fixtures are test-owned (dce- prefix, generated ids). Cleanup deletes the two users,
// whose cascade removes their orgs, workspaces, devices and (FK cascade) play_logs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const ExcelJS = require('exceljs');
const { db } = require('../db/database');
const { generateToken } = require('../middleware/auth');
const { startInProcessApp } = require('./helpers/inprocess-app');
const { randTag, cleanupUsers } = require('./helpers/disposable');

const P = `dce-${randTag()}`;
const id = (name) => `${P}-${name}`;
const ID = {
  userA: id('user-a'), userB: id('user-b'), orgA: id('org-a'), orgB: id('org-b'),
  wsA: id('ws-a'), wsB: id('ws-b'), devA: id('device-a'), devB: id('device-b'),
  cA1: id('cid-a1'), cA2: id('cid-a2'), cB1: id('cid-b1'), cB2: id('cid-b2'),
};
let app;
let base;
let tokA;
let tokB;

test.before(async () => {
  app = await startInProcessApp({ only: ['/api/dashboard/content'] });
  base = app.base;
  const run = (sql, ...p) => app.db.prepare(sql).run(...p);

  // --- Seed two tenants ---
  await run("INSERT INTO users (id, email, role, password_hash, auth_provider) VALUES (?, ?, 'user', NULL, 'local')", ID.userA, `${P}-a@tenant-a.test`);
  await run("INSERT INTO users (id, email, role, password_hash, auth_provider) VALUES (?, ?, 'user', NULL, 'local')", ID.userB, `${P}-b@tenant-b.test`);
  const org = "INSERT INTO organizations (id, name, owner_user_id, plan_id, subscription_status) VALUES (?, ?, ?, 'enterprise', 'active')";
  await run(org, ID.orgA, `${P} Org A`, ID.userA);
  await run(org, ID.orgB, `${P} Org B`, ID.userB);
  await run('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)', ID.wsA, ID.orgA, 'Workspace A');
  await run('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)', ID.wsB, ID.orgB, 'Workspace B');
  await run("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin')", ID.wsA, ID.userA);
  await run("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin')", ID.wsB, ID.userB);
  // user-b has NO path into ws-a - the cross-tenant case.
  await run('INSERT INTO devices (id, workspace_id, name) VALUES (?, ?, ?)', ID.devA, ID.wsA, 'Lobby A');
  await run('INSERT INTO devices (id, workspace_id, name) VALUES (?, ?, ?)', ID.devB, ID.wsB, 'Lobby B');

  // play_logs.content_id references content(id): one content row per id (the export
  // reports content_name from the play log and this id).
  const content = 'INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type) VALUES (?, ?, ?, ?, ?, ?)';
  for (const [cid, ws, user] of [[ID.cA1, ID.wsA, ID.userA], [ID.cA2, ID.wsA, ID.userA], [ID.cB1, ID.wsB, ID.userB], [ID.cB2, ID.wsB, ID.userB]]) {
    await run(content, cid, user, ws, `${cid}.png`, `${cid}.png`, 'image/png');
  }

  // Content names are the tenant leak canaries: TENANT-A-ONLY-* must never appear
  // in tenant B's export, and vice versa.
  const now = Math.floor(Date.now() / 1000);
  const play = (device, name, cid, dur, done) => run(
    'INSERT INTO play_logs (device_id, content_id, content_name, started_at, ended_at, duration_sec, completed) VALUES (?, ?, ?, ?, ?, ?, ?)',
    device, cid, name, now - 3600, now - 3600 + dur, dur, done,
  );
  // Durations chosen to land on exact 1-decimal hours: 360s == 0.1h.
  await play(ID.devA, 'TENANT-A-ONLY Morning Promo', ID.cA1, 1800, 1); // 2 x 1800s = 1.0h
  await play(ID.devA, 'TENANT-A-ONLY Morning Promo', ID.cA1, 1800, 1);
  await play(ID.devA, 'TENANT-A-ONLY Safety Notice', ID.cA2, 5400, 0); // 1 x 5400s = 1.5h, 0% done
  await play(ID.devB, 'TENANT-B-ONLY Cafeteria Menu', ID.cB1, 3600, 1);
  await play(ID.devB, 'TENANT-B-ONLY Evening Recap', ID.cB2, 9000, 1);

  tokA = generateToken({ id: ID.userA, email: `${P}-a@tenant-a.test`, role: 'user' }, ID.wsA);
  tokB = generateToken({ id: ID.userB, email: `${P}-b@tenant-b.test`, role: 'user' }, ID.wsB);
});

test.after(async () => {
  try {
    if (app) await cleanupUsers(app.db, [ID.userB, ID.userA]);
  } finally {
    if (app) await app.stop(); else await db.close();
  }
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
  assert.equal(line('TENANT-A-ONLY Morning Promo'), `TENANT-A-ONLY Morning Promo,2,1,100,${ID.cA1}`);
  // 1 play x 5400s = 1.5h, not completed -> 0
  assert.equal(line('TENANT-A-ONLY Safety Notice'), `TENANT-A-ONLY Safety Notice,1,1.5,0,${ID.cA2}`);
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
