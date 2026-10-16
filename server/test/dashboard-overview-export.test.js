'use strict';

// GET /api/dashboard/overview/export (CSV/XLSX/PDF): the Overview page's
// headline numbers as a Metric/Value report.
//
// The REAL requireAuth + resolveTenancy chain and dashboard-overview router
// (helpers/inprocess-app.js) against the REAL MySQL test DB (beamos_test via npm test).
// lib/sla-overview's buildSlaOverview is stubbed (it has its own suite,
// sla-overview.test.js, and needs the full outage/usage data) - what's tested here is
// that the export averages its per-device availability the way OverviewView does, counts
// only the caller's open tickets, gates issues to platform admins, and that each format
// decodes to the expected rows.
//
// Fixtures are test-owned (doe- prefix, generated ids). The issue count is GLOBAL (every
// player_debug_logs row in the period, any device): the exact count below holds because
// no other test file writes player_debug_logs (today only this one does) and the runner
// recreates beamos_test per run. player_debug_logs has no FK, so this file deletes its
// own rows by id; the rest goes with the users (orgs, workspaces, devices, play_logs,
// tickets cascade).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const ExcelJS = require('exceljs');

const P = `doe-${crypto.randomBytes(4).toString('hex')}`;
const id = (name) => `${P}-${name}`;
const ID = {
  userA: id('user-a'), userB: id('user-b'), admin: id('admin'), orgA: id('org-a'), orgB: id('org-b'),
  wsA: id('ws-a'), wsB: id('ws-b'),
};

// Stub: ws-a has three devices, one with no data in the period (must be
// skipped, not averaged in as 0) -> fleet uptime = (98 + 94) / 2 = 96.0.
// Installed before the router (which requires it) loads.
const slaModulePath = require.resolve('../lib/sla-overview');
require.cache[slaModulePath] = {
  id: slaModulePath,
  filename: slaModulePath,
  loaded: true,
  exports: {
    buildSlaOverview: async (_db, req) => ({
      target: { uptime_target_pct: 99 },
      devices:
        req.workspaceId === ID.wsA
          ? [{ availability_pct: 98 }, { availability_pct: '94.0' }, { availability_pct: null }]
          : [{ availability_pct: 50 }],
    }),
    buildSlaTrend: async () => [],
  },
};

const { db } = require('../db/database');
const { generateToken } = require('../middleware/auth');
const { startInProcessApp } = require('./helpers/inprocess-app');
const { cleanupUsers } = require('./helpers/disposable');

let app;
let base;
let tokA;
let tokAdmin;
const debugLogIds = [];

test.before(async () => {
  app = await startInProcessApp({ only: ['/api/dashboard/overview'] });
  base = app.base;
  const run = (sql, ...p) => app.db.prepare(sql).run(...p);
  const user = "INSERT INTO users (id, email, role, password_hash, auth_provider) VALUES (?, ?, ?, NULL, 'local')";
  await run(user, ID.userA, `${P}-a@tenant-a.test`, 'user');
  await run(user, ID.userB, `${P}-b@tenant-b.test`, 'user');
  await run(user, ID.admin, `${P}-admin@platform.test`, 'superadmin');
  const org = "INSERT INTO organizations (id, name, owner_user_id, plan_id, subscription_status) VALUES (?, ?, ?, 'enterprise', 'active')";
  await run(org, ID.orgA, `${P} Org A`, ID.userA);
  await run(org, ID.orgB, `${P} Org B`, ID.userB);
  await run('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)', ID.wsA, ID.orgA, 'Workspace A');
  await run('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)', ID.wsB, ID.orgB, 'Workspace B');
  await run("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_viewer')", ID.wsA, ID.userA);
  await run("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_viewer')", ID.wsB, ID.userB);

  for (const [dev, status] of [['d-a1', 'online'], ['d-a2', 'online'], ['d-a3', 'offline']]) {
    await run('INSERT INTO devices (id, workspace_id, status) VALUES (?, ?, ?)', id(dev), ID.wsA, status);
  }
  await run("INSERT INTO devices (id, workspace_id, status) VALUES (?, ?, 'online')", id('d-b1'), ID.wsB);

  const now = Math.floor(Date.now() / 1000);
  // ws-a: 4 plays, 3 completed -> 75.0%
  for (const done of [1, 1, 1, 0]) {
    await run('INSERT INTO play_logs (device_id, started_at, completed) VALUES (?, ?, ?)', id('d-a1'), now - 3600, done);
  }
  await run('INSERT INTO play_logs (device_id, started_at, completed) VALUES (?, ?, 0)', id('d-b1'), now - 3600);

  // ws-a: 2 open-ish (open + in_progress), 1 resolved; ws-b: 5 open (must not count for A)
  for (const [t, ws, status] of [
    ['t1', ID.wsA, 'open'], ['t2', ID.wsA, 'in_progress'], ['t3', ID.wsA, 'resolved'],
    ['t4', ID.wsB, 'open'], ['t5', ID.wsB, 'open'], ['t6', ID.wsB, 'open'], ['t7', ID.wsB, 'open'], ['t8', ID.wsB, 'open'],
  ]) {
    await run('INSERT INTO tickets (id, workspace_id, title, status) VALUES (?, ?, ?, ?)', id(t), ws, `${P} ${t}`, status);
  }

  // 3 distinct fingerprints in the period (one repeated), one old one outside it.
  for (const [fp, at] of [['fp1', now - 60], ['fp1', now - 120], ['fp2', now - 60], ['fp3', now - 60], ['fp-old', now - 90 * 86400]]) {
    const r = await run('INSERT INTO player_debug_logs (device_id, error_fingerprint, created_at) VALUES (?, ?, ?)', 'x', id(fp), at);
    debugLogIds.push(r.lastInsertRowid);
  }

  tokA = generateToken({ id: ID.userA, email: `${P}-a@tenant-a.test`, role: 'user' }, ID.wsA);
  tokAdmin = generateToken({ id: ID.admin, email: `${P}-admin@platform.test`, role: 'superadmin' }, ID.wsA);
});

test.after(async () => {
  try {
    if (app) {
      for (const rowId of debugLogIds) await app.db.prepare('DELETE FROM player_debug_logs WHERE id = ?').run(rowId);
      await cleanupUsers(app.db, [ID.admin, ID.userB, ID.userA]);
    }
  } finally {
    if (app) await app.stop(); else await db.close();
  }
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
