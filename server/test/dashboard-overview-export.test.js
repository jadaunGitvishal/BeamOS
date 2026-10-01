'use strict';

// GET /api/dashboard/overview/export (CSV/XLSX/PDF): the Overview page's
// headline numbers as a Metric/Value report.
//
// Same shape as dashboard-content-export.test.js: in-memory sqlite swapped in
// for ../db/database, the REAL requireAuth + resolveTenancy chain, mounted the
// way server.js mounts dashboard-overview. lib/sla-overview's
// buildSlaOverview is stubbed (it has its own suite, sla-overview.test.js, and
// needs the full outage/usage schema) - what's tested here is that the export
// averages its per-device availability the way OverviewView does, counts only
// the caller's open tickets, gates issues to platform admins, and that each
// format decodes to the expected rows.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const ExcelJS = require('exceljs');

process.env.JWT_SECRET = 'test-secret-dashboard-overview-export';

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE users (
    id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT DEFAULT '',
    password_hash TEXT, auth_provider TEXT NOT NULL DEFAULT 'local', avatar_url TEXT,
    role TEXT NOT NULL DEFAULT 'user', plan_id TEXT DEFAULT 'free', email_alerts INTEGER DEFAULT 1,
    must_change_password INTEGER NOT NULL DEFAULT 0, deactivated_at INTEGER
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
    id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL, content_id TEXT,
    content_name TEXT NOT NULL DEFAULT '', started_at INTEGER NOT NULL, completed INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE tickets (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, status TEXT NOT NULL
  );
  CREATE TABLE player_debug_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT, error_fingerprint TEXT, created_at INTEGER NOT NULL
  );
`);

const dbModulePath = require.resolve('../db/database');
require.cache[dbModulePath] = { id: dbModulePath, filename: dbModulePath, loaded: true, exports: { db } };

// Stub: ws-a has three devices, one with no data in the period (must be
// skipped, not averaged in as 0) -> fleet uptime = (98 + 94) / 2 = 96.0.
const slaModulePath = require.resolve('../lib/sla-overview');
require.cache[slaModulePath] = {
  id: slaModulePath,
  filename: slaModulePath,
  loaded: true,
  exports: {
    buildSlaOverview: async (_db, req) => ({
      target: { uptime_target_pct: 99 },
      devices:
        req.workspaceId === 'ws-a'
          ? [{ availability_pct: 98 }, { availability_pct: '94.0' }, { availability_pct: null }]
          : [{ availability_pct: 50 }],
    }),
    buildSlaTrend: async () => [],
  },
};

const express = require('express');
const { generateToken, requireAuth } = require('../middleware/auth');
const { resolveTenancy } = require('../lib/tenancy');

db.prepare("INSERT INTO users (id, email, role) VALUES ('user-a', 'a@tenant-a.test', 'user')").run();
db.prepare("INSERT INTO users (id, email, role) VALUES ('user-b', 'b@tenant-b.test', 'user')").run();
db.prepare("INSERT INTO users (id, email, role) VALUES ('admin', 'admin@platform.test', 'superadmin')").run();
db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES ('org-a', 'Org A', 'user-a')").run();
db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES ('org-b', 'Org B', 'user-b')").run();
db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES ('ws-a', 'org-a', 'Workspace A')").run();
db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES ('ws-b', 'org-b', 'Workspace B')").run();
db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('ws-a', 'user-a', 'workspace_viewer')").run();
db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('ws-b', 'user-b', 'workspace_viewer')").run();

for (const [id, status] of [['d-a1', 'online'], ['d-a2', 'online'], ['d-a3', 'offline']]) {
  db.prepare("INSERT INTO devices (id, workspace_id, status) VALUES (?, 'ws-a', ?)").run(id, status);
}
db.prepare("INSERT INTO devices (id, workspace_id, status) VALUES ('d-b1', 'ws-b', 'online')").run();

const now = Math.floor(Date.now() / 1000);
// ws-a: 4 plays, 3 completed -> 75.0%
for (const done of [1, 1, 1, 0]) {
  db.prepare("INSERT INTO play_logs (device_id, started_at, completed) VALUES ('d-a1', ?, ?)").run(now - 3600, done);
}
db.prepare("INSERT INTO play_logs (device_id, started_at, completed) VALUES ('d-b1', ?, 0)").run(now - 3600);

// ws-a: 2 open-ish (open + in_progress), 1 resolved; ws-b: 5 open (must not count for A)
for (const [id, ws, status] of [
  ['t1', 'ws-a', 'open'], ['t2', 'ws-a', 'in_progress'], ['t3', 'ws-a', 'resolved'],
  ['t4', 'ws-b', 'open'], ['t5', 'ws-b', 'open'], ['t6', 'ws-b', 'open'], ['t7', 'ws-b', 'open'], ['t8', 'ws-b', 'open'],
]) {
  db.prepare('INSERT INTO tickets (id, workspace_id, status) VALUES (?, ?, ?)').run(id, ws, status);
}

// 3 distinct fingerprints in the period (one repeated), one old one outside it.
for (const [fp, at] of [['fp1', now - 60], ['fp1', now - 120], ['fp2', now - 60], ['fp3', now - 60], ['fp-old', now - 90 * 86400]]) {
  db.prepare('INSERT INTO player_debug_logs (device_id, error_fingerprint, created_at) VALUES (?, ?, ?)').run('x', fp, at);
}

const tokA = generateToken({ id: 'user-a', email: 'a@tenant-a.test', role: 'user' }, 'ws-a');
const tokAdmin = generateToken({ id: 'admin', email: 'admin@platform.test', role: 'superadmin' }, 'ws-a');

const app = express();
app.use(express.json());
app.use('/api/dashboard/overview', requireAuth, resolveTenancy, require('../routes/dashboard-overview'));
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

const start = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
function get(token, format) {
  return fetch(`${base}/api/dashboard/overview/export?format=${format}&start=${start}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

function csvMap(text) {
  const lines = text.replace(/^﻿/, '').split('\r\n');
  assert.equal(lines[0], 'Metric,Value');
  return Object.fromEntries(lines.slice(1).map((l) => {
    const i = l.indexOf(',');
    return [l.slice(0, i), l.slice(i + 1)];
  }));
}

test('csv: workspace numbers, SLA average skips no-data devices, own tickets only', async () => {
  const res = await get(tokA, 'csv');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="overview-\d{4}-\d{2}-\d{2}\.csv"/);
  const m = csvMap(await res.text());
  assert.equal(m['Total devices'], '3');
  assert.equal(m['Online'], '2');
  assert.equal(m['Offline'], '1');
  assert.equal(m['Total plays'], '4');
  assert.equal(m['Completed plays'], '3');
  assert.equal(m['Play completion'], '75.0%');
  assert.equal(m['Fleet uptime (SLA)'], '96.0%');
  assert.equal(m['Uptime target'], '99.0%');
  assert.equal(m['Devices with uptime data'], '2');
  assert.equal(m['Open tickets'], '2');
  assert.equal(m['Open issues'], 'platform admin only');
});

test('csv: platform admin gets the distinct-fingerprint issue count for the period', async () => {
  const res = await get(tokAdmin, 'csv');
  assert.equal(res.status, 200);
  assert.equal(csvMap(await res.text())['Open issues'], '3');
});

test('unknown format falls back to csv', async () => {
  const res = await get(tokA, 'docx');
  assert.match(res.headers.get('content-type'), /text\/csv/);
});

test('xlsx: real workbook with the Metric/Value rows', async () => {
  const res = await get(tokA, 'xlsx');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /spreadsheetml\.sheet/);
  assert.match(res.headers.get('content-disposition'), /overview-\d{4}-\d{2}-\d{2}\.xlsx/);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.slice(0, 2).toString('latin1'), 'PK');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const rows = [];
  wb.getWorksheet('Overview').eachRow((row) => rows.push(row.values.slice(1)));
  assert.deepEqual(rows[0], ['Metric', 'Value']);
  const byKey = Object.fromEntries(rows.slice(1));
  assert.equal(byKey['Total devices'], 3);
  assert.equal(byKey['Fleet uptime (SLA)'], '96.0%');
  assert.equal(byKey['Open tickets'], 2);
});

test('pdf: valid document containing the metrics', async () => {
  const res = await get(tokA, 'pdf');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.match(res.headers.get('content-disposition'), /overview-\d{4}-\d{2}-\d{2}\.pdf/);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.slice(0, 5).toString('latin1'), '%PDF-');
  const { extractCells } = require('../scripts/pdf-text-dump');
  const tmp = path.join(os.tmpdir(), `doe-${crypto.randomBytes(4).toString('hex')}.pdf`);
  fs.writeFileSync(tmp, buf);
  let text;
  try {
    text = extractCells(tmp).map((c) => c.str).join(' ');
  } finally {
    fs.unlinkSync(tmp);
  }
  assert.match(text, /Overview/);
  assert.match(text, /Fleet uptime \(SLA\)/);
  assert.match(text, /96\.0%/);
  assert.match(text, /platform admin only/);
});
