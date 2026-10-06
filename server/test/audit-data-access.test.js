'use strict';

// Ref 20: audit logging of data exports and a fixed set of sensitive reads,
// end to end over real HTTP against the REAL MySQL database (in-process app,
// helpers/inprocess-app.js - same harness as sso-only.test.js).
//
// EXPORT entries come from activityLogger's single 'close' listener (no export
// route is modified); READ entries come from auditRead on exactly 6 routes.
// Every assertion reads activity_log rows written since a per-test id marker,
// filtered to this file's own disposable users.
//
// Harness note: helpers/inprocess-app.js mounts /api/status BEFORE activityLogger,
// whereas server.js mounts it after. This file therefore excludes /api/status
// from `only` and mounts it after the logger itself, mirroring server.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawnSync } = require('node:child_process');

const { initDb } = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const { hashToken, generateToken, displayPrefix } = require('../middleware/apiToken');
const { startInProcessApp } = require('./helpers/inprocess-app');
const { randTag, cleanupUsers } = require('./helpers/disposable');

const PASSWORD = 'audit-data-access-pass-1';
// A distinctive filter VALUE that must never reach activity_log.details.
const SECRET = `zz-filter-value-${randTag()}`;
const TEST_ROUTE = '/api/test-audit/big-export';

let app;
const cleanup = [];
let owner, outsider, admin, apiToken;
let rangeStart; // first activity_log id this file can have produced

// ---- HTTP ----
async function req(method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${app.base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buf.toString('utf8')); } catch { /* binary / csv */ }
  return { status: res.status, headers: res.headers, buf, json };
}

async function registerUser(prefix) {
  const email = `${prefix}-${randTag()}@auditdata.local`;
  const r = await req('POST', '/api/auth/register', { body: { email, password: PASSWORD, name: prefix, createOrg: true } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  cleanup.push(r.json.user.id);
  const ws = await app.db.prepare('SELECT organization_id FROM workspaces WHERE id = ?').get(r.json.current_workspace_id);
  return { id: r.json.user.id, token: r.json.token, workspaceId: r.json.current_workspace_id, orgId: ws.organization_id };
}

// ---- activity_log inspection ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const maxId = async () => Number((await app.db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM activity_log').get()).m);

async function rowsSince(marker) {
  const ids = [owner.id, outsider.id, admin.id];
  return app.db
    .prepare(`SELECT id, user_id, device_id, workspace_id, action, details, ip_address FROM activity_log
              WHERE id > ? AND user_id IN (?, ?, ?) ORDER BY id`)
    .all(marker, ...ids);
}

// Audit writes are fire-and-forget after the response, so poll until at least
// `expected` rows have landed, then wait a little longer so any EXTRA row (the
// thing several tests assert is absent) has time to appear too.
async function settle(marker, expected) {
  const deadline = Date.now() + 8000;
  let rows = await rowsSince(marker);
  while (rows.length < expected && Date.now() < deadline) {
    await sleep(50);
    rows = await rowsSince(marker);
  }
  await sleep(400);
  return rowsSince(marker);
}

function parseDetails(details) {
  const m = /^file=(.*), format=(.*), filters=\[(.*)\], outcome=(completed|aborted)$/.exec(details || '');
  assert.ok(m, `details not in the EXPORT format: ${details}`);
  return { file: m[1], format: m[2], filters: m[3] ? m[3].split(',') : [], outcome: m[4] };
}

function assertSingleExport(rows, { action, userId, workspaceId, file, format, filters, outcome = 'completed' }) {
  assert.equal(rows.length, 1, `expected exactly one audit row, got: ${JSON.stringify(rows)}`);
  const [row] = rows;
  assert.equal(row.action, action);
  assert.equal(row.user_id, userId);
  assert.equal(row.workspace_id, workspaceId);
  assert.equal(row.device_id, null);
  assert.ok(row.ip_address, 'ip_address recorded');
  const d = parseDetails(row.details);
  if (file instanceof RegExp) assert.match(d.file, file); else assert.equal(d.file, file);
  assert.equal(d.format, format);
  assert.deepEqual(d.filters, filters);
  assert.equal(d.outcome, outcome);
  assert.ok(!row.details.includes(SECRET), 'filter VALUE must never be logged');
  return row;
}

// ---- setup ----
test.before(async () => {
  await initDb();
  app = await startInProcessApp({
    only: ['/api/activity', '/api/workspaces', '/api/organizations', '/api/admin', '/api/reports', '/api/content', '/api/devices'],
  });
  // Mounted AFTER the harness's activityLogger, exactly as server.js does.
  app.app.use('/api/status', require('../routes/status'));
  // Test-only large attachment (never added to the real app): streams until the
  // client goes away, so the download can be interrupted reliably.
  app.app.get(TEST_ROUTE, requireAuth, (rq, rs) => {
    rs.setHeader('Content-Type', 'application/octet-stream');
    rs.setHeader('Content-Disposition', 'attachment; filename="big-test.bin"');
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    const timer = setInterval(() => rs.write(chunk), 2);
    rs.on('close', () => clearInterval(timer));
  });

  owner = await registerUser('auditowner');
  outsider = await registerUser('auditoutsider');
  admin = await registerUser('auditadmin');
  await app.db.prepare("UPDATE users SET role = 'platform_admin' WHERE id = ?").run(admin.id);

  const raw = generateToken();
  await app.db
    .prepare("INSERT INTO api_tokens (id, token_hash, prefix, name, user_id, workspace_id, scope) VALUES (?, ?, ?, ?, ?, ?, 'read')")
    .run(`tok-${randTag()}`, hashToken(raw), displayPrefix(raw), 'audit-test', owner.id, owner.workspaceId);
  apiToken = raw;

  rangeStart = (await maxId()) + 1;
});

test.after(async () => {
  if (admin) await app.db.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(admin.id).catch(() => {});
  await cleanupUsers(app.db, cleanup.reverse());
  await app.stop();
});

// ===================== EXPORT =====================

test('CSV export (audit log itself, with a filter) -> one EXPORT entry, filter key only', async () => {
  const marker = await maxId();
  const r = await req('GET', `/api/activity/export?format=csv&device_id=${SECRET}`, { token: owner.token });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /attachment/);
  const rows = await settle(marker, 1);
  assertSingleExport(rows, {
    action: 'EXPORT /api/activity/export', userId: owner.id, workspaceId: owner.workspaceId,
    file: /^activity-.*\.csv$/, format: 'csv', filters: ['device_id', 'format'],
  });
});

test('XLSX export with a filter -> one EXPORT entry', async () => {
  const marker = await maxId();
  const r = await req('GET', `/api/content/export?format=xlsx&folder=${SECRET}`, { token: owner.token });
  assert.equal(r.status, 200);
  const rows = await settle(marker, 1);
  assertSingleExport(rows, {
    action: 'EXPORT /api/content/export', userId: owner.id, workspaceId: owner.workspaceId,
    file: /\.xlsx$/, format: 'xlsx', filters: ['folder', 'format'],
  });
});

test('PDF export via an API token -> one EXPORT entry recorded against the token owner', async () => {
  const marker = await maxId();
  const r = await req('GET', `/api/reports/export?format=pdf&device_id=${SECRET}&start=2026-01-01`, { token: apiToken });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/pdf');
  const rows = await settle(marker, 1);
  assertSingleExport(rows, {
    action: 'EXPORT /api/reports/export', userId: owner.id, workspaceId: owner.workspaceId,
    file: 'proof-of-play.pdf', format: 'pdf', filters: ['device_id', 'format', 'start'],
  });
});

test('members export -> route pattern in action, device_id null (not the :id workspace id)', async () => {
  const marker = await maxId();
  const r = await req('GET', `/api/workspaces/${owner.workspaceId}/members/export?format=csv`, { token: owner.token });
  assert.equal(r.status, 200);
  const rows = await settle(marker, 1);
  const row = assertSingleExport(rows, {
    action: 'EXPORT /api/workspaces/:id/members/export', userId: owner.id, workspaceId: owner.workspaceId,
    file: /\.csv$/, format: 'csv', filters: ['format'],
  });
  assert.equal(row.device_id, null);
  assert.ok(!row.action.includes(owner.workspaceId), 'concrete URL id must not appear in action');
});

test('POST export (custom report) is covered centrally; body is not logged', async () => {
  const marker = await maxId();
  const r = await req('POST', '/api/reports/custom/export', {
    token: owner.token,
    body: { fields: ['device_name', 'pop_content_name'], format: 'csv', note: SECRET },
  });
  assert.equal(r.status, 200, r.buf.toString('utf8').slice(0, 200));
  const rows = await settle(marker, 1);
  assertSingleExport(rows, {
    action: 'EXPORT /api/reports/custom/export', userId: owner.id, workspaceId: owner.workspaceId,
    file: 'custom-report.csv', format: 'csv', filters: [],
  });
});

test('JSON attachment via res.json (GET /api/status/export) -> one EXPORT entry', async () => {
  const marker = await maxId();
  const r = await req('GET', '/api/status/export', { token: owner.token });
  assert.equal(r.status, 200);
  const rows = await settle(marker, 1);
  assertSingleExport(rows, {
    action: 'EXPORT /api/status/export', userId: owner.id, workspaceId: owner.workspaceId,
    file: /\.json$/, format: 'json', filters: [],
  });
});

const hasMysqldump = spawnSync('mysqldump', ['--version'], { stdio: 'ignore' }).status === 0;
test('GET /api/status/backup (streamed mysqldump) -> one EXPORT entry, completed', {
  skip: hasMysqldump ? false : 'mysqldump is not on PATH - backup cannot run here',
}, async () => {
  const marker = await maxId();
  const r = await req('GET', '/api/status/backup', { token: admin.token });
  assert.equal(r.status, 200);
  assert.ok(r.buf.length > 0, 'dump body streamed');
  const rows = await settle(marker, 1);
  assertSingleExport(rows, {
    action: 'EXPORT /api/status/backup', userId: admin.id, workspaceId: null,
    file: /^beamos-backup-.*\.sql$/, format: 'sql', filters: [], outcome: 'completed',
  });
});

test('interrupted download -> EXPORT entry with outcome=aborted', async () => {
  const marker = await maxId();
  const port = new URL(app.base).port;
  await new Promise((resolve, reject) => {
    const cr = http.get({ host: '127.0.0.1', port, path: `${TEST_ROUTE}?q=${SECRET}`, headers: { Authorization: `Bearer ${owner.token}` } }, (res) => {
      assert.equal(res.statusCode, 200);
      res.once('data', () => {
        cr.destroy(); // client socket gone mid-stream
        resolve();
      });
    });
    cr.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
  });
  const rows = await settle(marker, 1);
  assertSingleExport(rows, {
    action: `EXPORT ${TEST_ROUTE}`, userId: owner.id, workspaceId: null,
    file: 'big-test.bin', format: 'bin', filters: ['q'], outcome: 'aborted',
  });
});

test('refused export (403) -> ACCESS_DENIED only, no EXPORT', async () => {
  const marker = await maxId();
  const r = await req('GET', `/api/workspaces/${owner.workspaceId}/members/export?format=csv`, { token: outsider.token });
  assert.equal(r.status, 403);
  const rows = await settle(marker, 1);
  assert.deepEqual(rows.map((x) => x.action), ['ACCESS_DENIED GET /api/workspaces/:id/members/export']);
  assert.equal(rows[0].user_id, outsider.id);
});

// ===================== READ =====================

const READS = [
  { name: 'GET /api/activity', path: () => '/api/activity', action: 'READ /api/activity/', who: () => owner },
  { name: 'GET /api/activity/verify-integrity', path: () => `/api/activity/verify-integrity?start_id=${rangeStart}&end_id=${rangeStart}`, action: 'READ /api/activity/verify-integrity', who: () => admin },
  { name: 'GET /api/auth/users', path: () => '/api/auth/users', action: 'READ /api/auth/users', who: () => admin },
  { name: 'GET /api/admin/users/:id/workspaces', path: () => `/api/admin/users/${owner.id}/workspaces`, action: 'READ /api/admin/users/:id/workspaces', who: () => admin },
  { name: 'GET /api/organizations/:id/members', path: () => `/api/organizations/${owner.orgId}/members`, action: 'READ /api/organizations/:id/members', who: () => owner },
  { name: 'GET /api/workspaces/:id/members', path: () => `/api/workspaces/${owner.workspaceId}/members`, action: 'READ /api/workspaces/:id/members', who: () => owner },
];

for (const rd of READS) {
  test(`sensitive read ${rd.name} -> exactly one READ entry, no details`, async () => {
    const marker = await maxId();
    const user = rd.who();
    const r = await req('GET', rd.path(), { token: user.token });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const rows = await settle(marker, 1);
    assert.equal(rows.length, 1, JSON.stringify(rows));
    assert.equal(rows[0].action, rd.action);
    assert.equal(rows[0].user_id, user.id);
    assert.equal(rows[0].details, null, 'no response data in details');
    assert.equal(rows[0].device_id, null);
  });
}

test('refused sensitive read (non-admin verify-integrity) -> ACCESS_DENIED only, no READ', async () => {
  const marker = await maxId();
  const r = await req('GET', '/api/activity/verify-integrity', { token: owner.token });
  assert.equal(r.status, 403);
  const rows = await settle(marker, 1);
  assert.deepEqual(rows.map((x) => x.action), ['ACCESS_DENIED GET /api/activity/verify-integrity']);
});

test('ordinary GETs (device list, content list) -> no audit entry', async () => {
  const marker = await maxId();
  const r = await req('GET', '/api/devices', { token: owner.token });
  assert.equal(r.status, 200);
  const r2 = await req('GET', "/api/content", { token: owner.token });
  assert.equal(r2.status, 200);
  await sleep(300);
  const rows = await settle(marker, 0);
  assert.deepEqual(rows, []);
});

// ===================== integrity =====================

test("verify-integrity over this file's own rows -> chain valid", async () => {
  const end = await maxId();
  assert.ok(end >= rangeStart, 'this file wrote audit rows');
  const r = await req('GET', `/api/activity/verify-integrity?start_id=${rangeStart}&end_id=${end}`, { token: admin.token });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true, JSON.stringify(r.json.failures));
});
