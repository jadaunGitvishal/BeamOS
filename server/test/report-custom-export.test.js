'use strict';

// Ref 74 Stage 3: proves POST /api/reports/custom/export renders the SAME
// data the Stage 2 preview endpoint returns, across all 3 real download
// formats (csv/xlsx/pdf) plus json, reusing report-export.js's renderCsv/
// renderXlsx/renderPdf exactly as every other export route does. Same
// in-memory-sqlite + real-app harness as report-custom-query.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const ExcelJS = require('exceljs');

process.env.JWT_SECRET = 'test-secret-report-custom-export';

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
    id TEXT PRIMARY KEY, workspace_id TEXT, name TEXT DEFAULT '', status TEXT DEFAULT 'offline',
    blocked INTEGER NOT NULL DEFAULT 0, manufacturer TEXT, model TEXT, android_version TEXT,
    app_version TEXT, installed_at TEXT, warranty_expiry_date TEXT,
    created_at INTEGER NOT NULL DEFAULT 0, last_heartbeat INTEGER
  );
  CREATE TABLE device_usage_daily (
    device_id TEXT NOT NULL, day TEXT NOT NULL, online_seconds INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (device_id, day)
  );
  CREATE TABLE outage_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
    started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL, duration_seconds INTEGER NOT NULL,
    likely_cause TEXT
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

db.prepare("INSERT INTO users (id, email, role) VALUES ('user-a', 'a@tenant-a.test', 'user')").run();
db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES ('org-a', 'Org A', 'user-a')").run();
db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES ('ws-a', 'org-a', 'Workspace A')").run();
db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('ws-a', 'user-a', 'workspace_admin')").run();

db.prepare(`
  INSERT INTO devices (id, workspace_id, name, status, manufacturer, model, created_at)
  VALUES ('device-a', 'ws-a', 'Export Test Device', 'online', 'Acme', 'X1', 1700000000)
`).run();
db.prepare(`
  INSERT INTO play_logs (device_id, content_id, content_name, started_at, ended_at, duration_sec, completed)
  VALUES ('device-a', NULL, 'Export Test Promo', 1700000000, 1700001800, 1800, 1)
`).run();

const tokA = generateToken({ id: 'user-a', email: 'a@tenant-a.test', role: 'user' }, 'ws-a');

const app = express();
app.use(express.json());
app.use('/api/reports', requireAuth, resolveTenancy, require('../routes/reports'));
app.use((err, req, res, _next) => {
  res.status(err.statusCode || 500).json({ error: err.message });
});

const server = app.listen(0);
let base;
let previewData;
test.before(async () => {
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  base = `http://127.0.0.1:${server.address().port}`;
  previewData = await preview();
});
test.after(() => {
  server.close();
  db.close();
});

const SELECTION = { fields: ['device_name', 'pop_content_name', 'pop_duration_sec'] };

async function preview() {
  const res = await fetch(`${base}/api/reports/custom/preview`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokA}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(SELECTION),
  });
  return res.json();
}

async function exportAs(format) {
  const res = await fetch(`${base}/api/reports/custom/export`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokA}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...SELECTION, format }),
  });
  return res;
}

function pdfTextOf(buf) {
  const { extractCells } = require('../scripts/pdf-text-dump');
  const tmp = path.join(os.tmpdir(), `rce-${crypto.randomBytes(4).toString('hex')}.pdf`);
  fs.writeFileSync(tmp, buf);
  try {
    return extractCells(tmp).map((c) => c.str).join(' ');
  } finally {
    fs.unlinkSync(tmp);
  }
}

test('preview returns the expected row (sanity check for the comparisons below)', () => {
  assert.deepEqual(previewData.columns, ['Device Name', 'Content', 'Duration (sec)']);
  assert.deepEqual(previewData.rows, [['Export Test Device', 'Export Test Promo', 1800]]);
});

test('csv export matches preview data exactly', async () => {
  const res = await exportAs('csv');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition'), /custom-report\.csv/);
  const text = await res.text();
  const lines = text.replace(/^﻿/, '').split('\r\n');
  assert.equal(lines[0], 'Device Name,Content,Duration (sec)');
  assert.equal(lines[1], 'Export Test Device,Export Test Promo,1800');
});

test('xlsx export matches preview data exactly', async () => {
  const res = await exportAs('xlsx');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /spreadsheetml\.sheet/);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.slice(0, 2).toString('latin1'), 'PK');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.worksheets[0];
  const headerRow = ws.getRow(1).values.slice(1);
  const dataRow = ws.getRow(2).values.slice(1);
  assert.deepEqual(headerRow, previewData.columns);
  assert.deepEqual(dataRow, previewData.rows[0]);
});

test('pdf export matches preview data exactly', async () => {
  const res = await exportAs('pdf');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.slice(0, 5).toString('latin1'), '%PDF-');
  const text = pdfTextOf(buf);
  assert.match(text, /Export Test Device/);
  assert.match(text, /Export Test Promo/);
  assert.match(text, /1800/);
});

test('json export matches preview data exactly (same {columns, rows} shape)', async () => {
  const res = await exportAs('json');
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.deepEqual(json.columns, previewData.columns);
  assert.deepEqual(json.rows, previewData.rows);
});

test('unknown field in export selection -> 400, same validation as preview', async () => {
  const res = await fetch(`${base}/api/reports/custom/export`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokA}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: ['not_a_field'], format: 'csv' }),
  });
  assert.equal(res.status, 400);
});

test('unrecognized format falls back to csv, matching every other export route', async () => {
  const res = await fetch(`${base}/api/reports/custom/export`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokA}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...SELECTION, format: 'exe' }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
});
