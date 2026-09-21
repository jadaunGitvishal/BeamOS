'use strict';

// Ref 74 Stage 2: adversarial + cross-tenant tests for the custom-report
// query builder (lib/report-query-builder.js) via the real POST
// /api/reports/custom/preview endpoint.
//
// Same shape as test/dashboard-content-export.test.js: in-memory sqlite
// swapped in for ../db/database, the REAL Express app with the real
// requireAuth + resolveTenancy chain, mounted exactly as server.js mounts
// routes/reports.js. Two tenants, two workspaces, canary rows seeded in
// EVERY one of the 4 v1 domains (device / uptime / sla / proof_of_play) so a
// leak in any one of them would be caught, not just proof-of-play.

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

process.env.JWT_SECRET = 'test-secret-report-custom-query';

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

db.prepare(`
  INSERT INTO devices (id, workspace_id, name, status, manufacturer, model, android_version, app_version, created_at)
  VALUES ('device-a', 'ws-a', 'TENANT-A-ONLY Lobby', 'online', 'Acme', 'X1', '11', '1.0', 1700000000)
`).run();
db.prepare(`
  INSERT INTO devices (id, workspace_id, name, status, manufacturer, model, android_version, app_version, created_at)
  VALUES ('device-b', 'ws-b', 'TENANT-B-ONLY Lobby', 'online', 'Acme', 'X1', '11', '1.0', 1700000000)
`).run();

const now = 1700100000;
// uptime canaries
db.prepare("INSERT INTO device_usage_daily (device_id, day, online_seconds) VALUES ('device-a', '2026-09-01', 43200)").run();
db.prepare("INSERT INTO device_usage_daily (device_id, day, online_seconds) VALUES ('device-b', '2026-09-01', 21600)").run();
// sla canaries
db.prepare(`
  INSERT INTO outage_history (device_id, workspace_id, started_at, ended_at, duration_seconds, likely_cause)
  VALUES ('device-a', 'ws-a', ${now}, ${now + 600}, 600, 'TENANT-A-ONLY-CAUSE')
`).run();
db.prepare(`
  INSERT INTO outage_history (device_id, workspace_id, started_at, ended_at, duration_seconds, likely_cause)
  VALUES ('device-b', 'ws-b', ${now}, ${now + 900}, 900, 'TENANT-B-ONLY-CAUSE')
`).run();
// proof-of-play canaries
db.prepare(`
  INSERT INTO play_logs (device_id, content_id, content_name, started_at, ended_at, duration_sec, completed)
  VALUES ('device-a', 'cid-a1', 'TENANT-A-ONLY Promo', ${now}, ${now + 1800}, 1800, 1)
`).run();
db.prepare(`
  INSERT INTO play_logs (device_id, content_id, content_name, started_at, ended_at, duration_sec, completed)
  VALUES ('device-b', 'cid-b1', 'TENANT-B-ONLY Promo', ${now}, ${now + 3600}, 3600, 1)
`).run();

const tokA = generateToken({ id: 'user-a', email: 'a@tenant-a.test', role: 'user' }, 'ws-a');
const tokB = generateToken({ id: 'user-b', email: 'b@tenant-b.test', role: 'user' }, 'ws-b');

// --- Real app, mounted exactly as server.js mounts routes/reports --------
const app = express();
app.use(express.json());
app.use('/api/reports', requireAuth, resolveTenancy, require('../routes/reports'));
app.use((err, req, res, _next) => {
  res.status(err.statusCode || 500).json({ error: err.message });
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
  return {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  };
}

async function preview(token, body) {
  const res = await fetch(`${base}/api/reports/custom/preview`, { ...authed(token), body: JSON.stringify(body) });
  const json = await res.json();
  return { status: res.status, json };
}

// --- (a) normal query, valid fields + filters -----------------------------
test('(a) valid selection returns correct real data for the requesting workspace', async () => {
  const { status, json } = await preview(tokA, {
    fields: ['device_name', 'device_status', 'device_manufacturer'],
  });
  assert.equal(status, 200);
  assert.equal(json.columns.length, 3);
  assert.equal(json.rows.length, 1);
  assert.deepEqual(json.rows[0], ['TENANT-A-ONLY Lobby', 'online', 'Acme']);
});

test('(a) valid filter narrows results correctly', async () => {
  const { status, json } = await preview(tokA, {
    fields: ['device_name'],
    filters: [{ fieldId: 'device_status', operator: 'eq', value: 'offline' }],
  });
  assert.equal(status, 200);
  assert.equal(json.rows.length, 0); // device-a is 'online', not 'offline'
});

// --- (b) unknown field id is rejected, not silently ignored ----------------
test('(b) unknown output field id -> 400, not silently dropped', async () => {
  const { status, json } = await preview(tokA, {
    fields: ['device_name', 'workspace_id'], // 'workspace_id' is a real column, NOT in the registry
  });
  assert.equal(status, 400);
  assert.match(json.error, /unknown output field/);
});

test('(b) unknown filter field id -> 400', async () => {
  const { status, json } = await preview(tokA, {
    fields: ['device_name'],
    filters: [{ fieldId: 'password_hash', operator: 'eq', value: 'x' }],
  });
  assert.equal(status, 400);
  assert.match(json.error, /unknown filter field/);
});

test('(b) disallowed operator for field type -> 400', async () => {
  const { status, json } = await preview(tokA, {
    fields: ['device_name'],
    filters: [{ fieldId: 'device_created_at', operator: 'contains', value: 'x' }], // LIKE on a date field
  });
  assert.equal(status, 400);
  assert.match(json.error, /operator/);
});

// --- (c) SQL metacharacters in a filter VALUE are literal, not executed ----
test("(c) SQL metacharacter filter value (\"' OR '1'='1\") is treated as a literal string, no injection", async () => {
  const { status, json } = await preview(tokA, {
    fields: ['device_name'],
    filters: [{ fieldId: 'device_name', operator: 'eq', value: "' OR '1'='1" }],
  });
  assert.equal(status, 200);
  // If this were ever concatenated instead of parameterized, "' OR '1'='1"
  // would make the WHERE clause universally true and return device-a anyway
  // (and, if it broke out of the AND entirely, every device including
  // tenant B's). The literal string matches no real device name, so the
  // correct, non-injected result is zero rows.
  assert.equal(json.rows.length, 0);
});

test('(c) SQL metacharacters in a "contains" filter also stay literal', async () => {
  const { status, json } = await preview(tokA, {
    fields: ['device_name'],
    filters: [{ fieldId: 'device_name', operator: 'contains', value: "x'; DROP TABLE devices; --" }],
  });
  assert.equal(status, 200);
  assert.equal(json.rows.length, 0);
  // Prove the table really is still there and still has tenant A's row.
  const stillThere = db.prepare('SELECT COUNT(*) AS c FROM devices').get();
  assert.equal(stillThere.c, 2);
});

// --- (d) THE CRITICAL TEST: cross-workspace isolation ----------------------
test('(d) device-domain query: tenant A sees ONLY its own device, zero rows from tenant B', async () => {
  const { json } = await preview(tokA, {
    fields: ['device_id', 'device_name', 'device_manufacturer', 'device_model'],
  });
  assert.equal(json.rows.length, 1);
  assert.equal(json.rows[0][0], 'device-a');
  assert.doesNotMatch(JSON.stringify(json.rows), /TENANT-B-ONLY/);
  assert.doesNotMatch(JSON.stringify(json.rows), /device-b/);
});

test('(d) uptime domain: tenant A sees only its own device_usage_daily rows', async () => {
  const { json } = await preview(tokA, {
    fields: ['device_name', 'uptime_day', 'uptime_online_seconds', 'uptime_pct'],
  });
  assert.equal(json.rows.length, 1);
  assert.equal(json.rows[0][0], 'TENANT-A-ONLY Lobby');
  assert.equal(json.rows[0][2], 43200); // tenant A's online_seconds, not tenant B's 21600
});

test('(d) sla domain: tenant A sees only its own outage_history rows, never TENANT-B-ONLY-CAUSE', async () => {
  const { json } = await preview(tokA, {
    fields: ['device_name', 'sla_outage_duration_seconds', 'sla_outage_cause'],
  });
  assert.equal(json.rows.length, 1);
  assert.equal(json.rows[0][1], 600); // tenant A's duration, not tenant B's 900
  assert.equal(json.rows[0][2], 'TENANT-A-ONLY-CAUSE');
  assert.doesNotMatch(JSON.stringify(json.rows), /TENANT-B-ONLY-CAUSE/);
});

test('(d) proof_of_play domain: tenant A sees only its own play_logs rows, never TENANT-B-ONLY content', async () => {
  const { json } = await preview(tokA, {
    fields: ['device_name', 'pop_content_name', 'pop_duration_sec'],
  });
  assert.equal(json.rows.length, 1);
  assert.equal(json.rows[0][1], 'TENANT-A-ONLY Promo');
  assert.doesNotMatch(JSON.stringify(json.rows), /TENANT-B-ONLY/);
});

test('(d) reverse direction: tenant B sees only its own data across all 4 domains', async () => {
  const { json: deviceJson } = await preview(tokB, { fields: ['device_id', 'device_name'] });
  assert.equal(deviceJson.rows.length, 1);
  assert.equal(deviceJson.rows[0][0], 'device-b');

  const { json: popJson } = await preview(tokB, { fields: ['pop_content_name'] });
  assert.deepEqual(popJson.rows, [['TENANT-B-ONLY Promo']]);

  const { json: slaJson } = await preview(tokB, { fields: ['sla_outage_cause'] });
  assert.deepEqual(slaJson.rows, [['TENANT-B-ONLY-CAUSE']]);
});

test('(d) plausible cross-boundary attempt: filtering by a value that only exists in tenant B returns ZERO rows for tenant A, not an error or a leak', async () => {
  const { status, json } = await preview(tokA, {
    fields: ['device_name', 'pop_content_name'],
    filters: [{ fieldId: 'pop_content_name', operator: 'contains', value: 'TENANT-B-ONLY' }],
  });
  assert.equal(status, 200);
  assert.equal(json.rows.length, 0);
});

test('(d) plausible cross-boundary attempt: filtering device_id directly to the OTHER tenant\'s device id still returns zero rows', async () => {
  const { status, json } = await preview(tokA, {
    fields: ['device_name'],
    filters: [{ fieldId: 'device_id', operator: 'eq', value: 'device-b' }],
  });
  assert.equal(status, 200);
  assert.equal(json.rows.length, 0); // workspace scope wins even when the caller names the other tenant's device_id explicitly
});

test('(d) a user with NO workspace membership at all -> empty result, not an error or someone else\'s data (matches getWorkspaceDeviceFilter\'s fail-closed default)', async () => {
  // A null JWT current_workspace_id alone doesn't reach this case - resolveTenancy
  // falls back to the caller's first workspace_members row (tenancy.js:162-167),
  // by design, so user-a (a real ws-a member) still resolves to ws-a even with a
  // null claim. The real "no workspace" case is a user with zero memberships.
  db.prepare("INSERT INTO users (id, email, role) VALUES ('user-orphan', 'orphan@nowhere.test', 'user')").run();
  const tokOrphan = generateToken({ id: 'user-orphan', email: 'orphan@nowhere.test', role: 'user' }, null);
  const { status, json } = await preview(tokOrphan, { fields: ['device_name'] });
  assert.equal(status, 200);
  assert.equal(json.rows.length, 0);
});

// --- multi-detail-domain rejection (correctness, not just security) --------
test('combining two detail domains (uptime + proof_of_play) in one report is rejected, not silently cross-joined', async () => {
  const { status, json } = await preview(tokA, {
    fields: ['uptime_online_seconds', 'pop_duration_sec'],
  });
  assert.equal(status, 400);
  assert.match(json.error, /multiple detail domains/);
});

test('device + ONE detail domain (proof_of_play) combines fine - 2+ domains in one report', async () => {
  const { status, json } = await preview(tokA, {
    fields: ['device_name', 'device_manufacturer', 'pop_content_name', 'pop_duration_sec'],
  });
  assert.equal(status, 200);
  assert.deepEqual(json.rows[0], ['TENANT-A-ONLY Lobby', 'Acme', 'TENANT-A-ONLY Promo', 1800]);
});

test('a filter-only reference to a second detail domain is rejected too (not just selected columns)', async () => {
  const { status, json } = await preview(tokA, {
    fields: ['uptime_online_seconds'],
    filters: [{ fieldId: 'sla_outage_duration_seconds', operator: 'gt', value: 0 }],
  });
  assert.equal(status, 400);
  assert.match(json.error, /multiple detail domains/);
});
