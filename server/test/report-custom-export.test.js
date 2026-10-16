'use strict';

// Ref 74 Stage 3: proves POST /api/reports/custom/export renders the SAME
// data the Stage 2 preview endpoint returns, across all 3 real download
// formats (csv/xlsx/pdf) plus json, reusing report-export.js's renderCsv/
// renderXlsx/renderPdf exactly as every other export route does. Same harness as
// report-custom-query.test.js: the real reports router behind requireAuth + resolveTenancy
// (helpers/inprocess-app.js) against the REAL MySQL test DB (beamos_test via npm test).
// Fixtures are test-owned (rce- prefix, generated ids, fixed timestamps); deleting the user
// cascades the org, workspace, device and (FK cascade) play_logs.

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
const { cleanupUsers } = require('./helpers/disposable');

const P = `rce-${crypto.randomBytes(4).toString('hex')}`;
const id = (name) => `${P}-${name}`;
const ID = { userA: id('user-a'), orgA: id('org-a'), wsA: id('ws-a'), devA: id('device-a') };

let app;
let base;
let tokA;
let previewData;

test.before(async () => {
  app = await startInProcessApp({ only: ['/api/reports'] });
  base = app.base;
  const run = (sql, ...p) => db.prepare(sql).run(...p);
  await run("INSERT INTO users (id, email, role, password_hash, auth_provider) VALUES (?, ?, 'user', NULL, 'local')", ID.userA, `${P}-a@tenant-a.test`);
  await run("INSERT INTO organizations (id, name, owner_user_id, plan_id, subscription_status) VALUES (?, ?, ?, 'enterprise', 'active')", ID.orgA, `${P} Org A`, ID.userA);
  await run('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)', ID.wsA, ID.orgA, 'Workspace A');
  await run("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin')", ID.wsA, ID.userA);
  await run(`
    INSERT INTO devices (id, workspace_id, name, status, manufacturer, model, created_at)
    VALUES (?, ?, 'Export Test Device', 'online', 'Acme', 'X1', 1700000000)
  `, ID.devA, ID.wsA);
  await run(`
    INSERT INTO play_logs (device_id, content_id, content_name, started_at, ended_at, duration_sec, completed)
    VALUES (?, NULL, 'Export Test Promo', 1700000000, 1700001800, 1800, 1)
  `, ID.devA);
  tokA = generateToken({ id: ID.userA, email: `${P}-a@tenant-a.test`, role: 'user' }, ID.wsA);
  previewData = await preview();
});

test.after(async () => {
  try {
    if (app) await cleanupUsers(db, [ID.userA]);
  } finally {
    if (app) await app.stop(); else await db.close();
  }
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
