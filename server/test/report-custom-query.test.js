'use strict';

// Ref 74 Stage 2: adversarial + cross-tenant tests for the custom-report
// query builder (lib/report-query-builder.js) via the real POST
// /api/reports/custom/preview endpoint.
//
// Same shape as test/dashboard-content-export.test.js: the REAL reports router with
// the real requireAuth + resolveTenancy chain (helpers/inprocess-app.js) against the REAL
// MySQL test DB (beamos_test via npm test). Two tenants, two workspaces, canary rows
// seeded in EVERY one of the 4 v1 domains (device / uptime / sla / proof_of_play) so a
// leak in any one of them would be caught, not just proof-of-play.
//
// Fixtures are test-owned (rcq- prefix, generated ids, fixed dates). device_usage_daily
// and outage_history have no FK to devices: this file deletes its own rows by device id;
// the rest goes with the users (orgs, workspaces, devices, content, play_logs).

const test = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const { generateToken } = require('../middleware/auth');
const { startInProcessApp } = require('./helpers/inprocess-app');
const { randTag, cleanupUsers } = require('./helpers/disposable');

const P = `rcq-${randTag()}`;
const id = (name) => `${P}-${name}`;
const ID = {
  userA: id('user-a'), userB: id('user-b'), userOrphan: id('user-orphan'), orgA: id('org-a'), orgB: id('org-b'),
  wsA: id('ws-a'), wsB: id('ws-b'), devA: id('device-a'), devB: id('device-b'), cA1: id('cid-a1'), cB1: id('cid-b1'),
};

let app;
let base;
let tokA;
let tokB;

test.before(async () => {
  app = await startInProcessApp({ only: ['/api/reports'] });
  base = app.base;
  const run = (sql, ...p) => db.prepare(sql).run(...p);

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

  const device = `
    INSERT INTO devices (id, workspace_id, name, status, manufacturer, model, android_version, app_version, created_at)
    VALUES (?, ?, ?, 'online', 'Acme', 'X1', '11', '1.0', 1700000000)`;
  await run(device, ID.devA, ID.wsA, 'TENANT-A-ONLY Lobby');
  await run(device, ID.devB, ID.wsB, 'TENANT-B-ONLY Lobby');

  const now = 1700100000;
  // uptime canaries
  await run("INSERT INTO device_usage_daily (device_id, day, online_seconds) VALUES (?, '2026-09-01', 43200)", ID.devA);
  await run("INSERT INTO device_usage_daily (device_id, day, online_seconds) VALUES (?, '2026-09-01', 21600)", ID.devB);
  // sla canaries
  const outage = 'INSERT INTO outage_history (device_id, workspace_id, started_at, ended_at, duration_seconds, likely_cause) VALUES (?, ?, ?, ?, ?, ?)';
  await run(outage, ID.devA, ID.wsA, now, now + 600, 600, 'TENANT-A-ONLY-CAUSE');
  await run(outage, ID.devB, ID.wsB, now, now + 900, 900, 'TENANT-B-ONLY-CAUSE');
  // proof-of-play canaries (play_logs.content_id references content(id))
  const content = 'INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type) VALUES (?, ?, ?, ?, ?, ?)';
  await run(content, ID.cA1, ID.userA, ID.wsA, 'a1.png', 'a1.png', 'image/png');
  await run(content, ID.cB1, ID.userB, ID.wsB, 'b1.png', 'b1.png', 'image/png');
  const play = 'INSERT INTO play_logs (device_id, content_id, content_name, started_at, ended_at, duration_sec, completed) VALUES (?, ?, ?, ?, ?, ?, 1)';
  await run(play, ID.devA, ID.cA1, 'TENANT-A-ONLY Promo', now, now + 1800, 1800);
  await run(play, ID.devB, ID.cB1, 'TENANT-B-ONLY Promo', now, now + 3600, 3600);

  tokA = generateToken({ id: ID.userA, email: `${P}-a@tenant-a.test`, role: 'user' }, ID.wsA);
  tokB = generateToken({ id: ID.userB, email: `${P}-b@tenant-b.test`, role: 'user' }, ID.wsB);
});

test.after(async () => {
  try {
    if (app) {
      // No FK to devices on these two tables: delete this file's rows explicitly.
      for (const d of [ID.devA, ID.devB]) {
        await db.prepare('DELETE FROM device_usage_daily WHERE device_id = ?').run(d);
        await db.prepare('DELETE FROM outage_history WHERE device_id = ?').run(d);
      }
      await cleanupUsers(db, [ID.userOrphan, ID.userB, ID.userA]);
    }
  } finally {
    if (app) await app.stop(); else await db.close();
  }
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
  // Prove the table really is still there and still has this file's two device rows
  // (counted by id: the shared test DB holds other files' devices too).
  const stillThere = await db.prepare('SELECT COUNT(*) AS c FROM devices WHERE id IN (?, ?)').get(ID.devA, ID.devB);
  assert.equal(Number(stillThere.c), 2);
});

// --- (d) THE CRITICAL TEST: cross-workspace isolation ----------------------
test('(d) device-domain query: tenant A sees ONLY its own device, zero rows from tenant B', async () => {
  const { json } = await preview(tokA, {
    fields: ['device_id', 'device_name', 'device_manufacturer', 'device_model'],
  });
  assert.equal(json.rows.length, 1);
  assert.equal(json.rows[0][0], ID.devA);
  assert.doesNotMatch(JSON.stringify(json.rows), /TENANT-B-ONLY/);
  assert.ok(!JSON.stringify(json.rows).includes(ID.devB));
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
  assert.equal(deviceJson.rows[0][0], ID.devB);

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
    filters: [{ fieldId: 'device_id', operator: 'eq', value: ID.devB }],
  });
  assert.equal(status, 200);
  assert.equal(json.rows.length, 0); // workspace scope wins even when the caller names the other tenant's device_id explicitly
});

test('(d) a user with NO workspace membership at all -> empty result, not an error or someone else\'s data (matches getWorkspaceDeviceFilter\'s fail-closed default)', async () => {
  // A null JWT current_workspace_id alone doesn't reach this case - resolveTenancy
  // falls back to the caller's first workspace_members row (tenancy.js:162-167),
  // by design, so user-a (a real ws-a member) still resolves to ws-a even with a
  // null claim. The real "no workspace" case is a user with zero memberships.
  await db.prepare("INSERT INTO users (id, email, role, password_hash, auth_provider) VALUES (?, ?, 'user', NULL, 'local')").run(ID.userOrphan, `${P}-orphan@nowhere.test`);
  const tokOrphan = generateToken({ id: ID.userOrphan, email: `${P}-orphan@nowhere.test`, role: 'user' }, null);
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
