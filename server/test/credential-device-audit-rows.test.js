'use strict';

// Phase 1B batch 4: explicit audit rows for credentials and device commands.
//   api_token_created / api_token_revoked / api_token_targets_changed (routes/tokens.js),
//   device_command_sent (routes/devices.js + ws/dashboardSocket.js dashboard:device-command),
//   device_group_command_sent (routes/device-groups.js),
//   registration_code_created / _regenerated / _revoked (routes/registration-codes.js),
//   and the existing SCIM-token / Entra-SP rows (routes/admin.js), now awaited.
//
// AWAITED rows are read IMMEDIATELY after the response (finding them proves the await);
// fire-and-forget rows (non-lockdown commands, the socket path) are waited for. The
// generic activityLogger row for the same request must still appear (both are kept by
// decision). Every row since the file started is scanned for secrets: API / SCIM token
// values, hashes and display prefixes, registration code values, command payloads and a
// client_secret sent to the SP route.
//
// The REAL routers in-process (helpers/inprocess-app.js) plus the REAL dashboard socket
// handler on a real socket.io server, against the REAL MySQL test DB. A recording fake
// stands in for the app's 'io' on the REST command routes (as device-command-route.test.js).
// Fixtures are test-owned (prefix cd-); audit rows stay (hash chain); the runner recreates
// beamos_test.
//
// Forced audit failure (socket test): lib/activity-chain's appendEntry is wrapped BEFORE
// services/activity.js loads (it destructures appendEntry), so one chosen write throws.
// helpers/fail-query.js can't reach it: the audit INSERT runs on appendEntry's own
// transaction handle, not on db.prepare.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');

// ---- forced audit failure hook (must precede every require of services/activity) ----
const chain = require('../lib/activity-chain');
const realAppend = chain.appendEntry;
let failNextAudit = null; // { action, deviceId } -> that one write throws
chain.appendEntry = async function appendEntry(dbh, fields = {}) {
  if (failNextAudit && fields.action === failNextAudit.action && fields.device_id === failNextAudit.deviceId) {
    failNextAudit = null;
    throw new Error('forced audit failure (test)');
  }
  return realAppend(dbh, fields);
};

const { Server } = require('socket.io');
const ioClient = require('socket.io-client');
const { db } = require('../db/database');
const { generateToken } = require('../middleware/auth');
const { hashToken, displayPrefix } = require('../middleware/apiToken');
const commandQueue = require('../lib/command-queue');
const setupDashboardSocket = require('../ws/dashboardSocket');
const { startInProcessApp } = require('./helpers/inprocess-app');
const { randTag, cleanupUsers } = require('./helpers/disposable');
const { maxAuditId, waitForAuditRows } = require('./helpers/wait-for-audit');

const P = `cd-${randTag()}`;
const id = (n) => `${P}-${n}`;
let app;
let since0;
const userIds = [];
const secrets = [];   // plain substrings that must never appear in an audit row
const codeValues = []; // 6-digit registration codes (matched as whole numbers)
const created = { scim: [], sp: [] };

// console.error spy for the "[audit] NOT AUDITED" line (still printed).
const realError = console.error;
const errors = [];
console.error = (...a) => { errors.push(a.join(' ')); realError(...a); };

// Recording fake of the /device namespace for the REST command routes.
const online = new Set();
const fakeIo = {
  of: () => ({
    adapter: { rooms: { get: (d) => (online.has(d) ? new Set([`sock-${d}`]) : undefined) } },
    to: () => ({ emit: () => {} }),
  }),
};

const F = {};
test.before(async () => {
  app = await startInProcessApp({ only: ['/api/tokens', '/api/devices', '/api/groups', '/api/provisioning', '/api/admin'] });
  app.app.set('io', fakeIo);
  since0 = await maxAuditId(app.db);
  const run = (sql, ...p) => app.db.prepare(sql).run(...p);
  F.owner = await mkUser('user');
  F.platform = await mkUser('platform_admin');
  F.orgId = crypto.randomUUID();
  F.wsId = crypto.randomUUID();
  await run("INSERT INTO organizations (id, name, owner_user_id, plan_id, subscription_status) VALUES (?, ?, ?, 'enterprise', 'active')", F.orgId, `${P} Org`, F.owner.id);
  await run("INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'org_owner')", F.orgId, F.owner.id);
  await run('INSERT INTO workspaces (id, organization_id, name, created_by) VALUES (?, ?, ?, ?)', F.wsId, F.orgId, `${P} WS`, F.owner.id);
  await run("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin')", F.wsId, F.owner.id);
  F.ownerToken = generateToken(F.owner, F.wsId);
  F.platformToken = generateToken(F.platform, null);
  F.pl = [];
  for (const n of ['p1', 'p2', 'p3', 'p4']) {
    await run('INSERT INTO playlists (id, user_id, workspace_id, name) VALUES (?, ?, ?, ?)', id(n), F.owner.id, F.wsId, `${P} ${n}`);
    F.pl.push(id(n));
  }
  F.devOnline = id('dev-on');
  F.devOffline = id('dev-off');
  for (const d of [F.devOnline, F.devOffline]) await run("INSERT INTO devices (id, name, status, workspace_id) VALUES (?, 'D', 'offline', ?)", d, F.wsId);
  F.groupId = id('grp');
  await run('INSERT INTO device_groups (id, user_id, workspace_id, name) VALUES (?, ?, ?, ?)', F.groupId, F.owner.id, F.wsId, `${P} group`);
  for (const d of [F.devOnline, F.devOffline]) await run('INSERT INTO device_group_members (device_id, group_id) VALUES (?, ?)', d, F.groupId);
});

test.after(async () => {
  try {
    if (app) {
      commandQueue._resetForTests();
      for (const t of created.scim) await app.db.prepare('DELETE FROM scim_tokens WHERE id = ?').run(t);
      for (const s of created.sp) await app.db.prepare('DELETE FROM entra_service_principals WHERE id = ?').run(s);
      await app.db.prepare('DELETE FROM registration_codes WHERE workspace_id = ?').run(F.wsId);
      await cleanupUsers(app.db, [...userIds].reverse());
    }
  } finally {
    console.error = realError;
    chain.appendEntry = realAppend;
    if (app) await app.stop(); else await db.close();
  }
});

// ---- helpers ----
async function mkUser(role) {
  const uid = id(randTag());
  const mail = `${uid}@x.local`;
  await app.db.prepare("INSERT INTO users (id, email, name, password_hash, auth_provider, role) VALUES (?, ?, ?, 'x', 'local', ?)").run(uid, mail, uid, role);
  userIds.push(uid);
  return { id: uid, email: mail, role };
}
async function call(method, path, token, body) {
  const r = await fetch(`${app.base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, json, text };
}
const rowsSince = (since) => app.db.prepare(
  'SELECT id, user_id, device_id, action, details, ip_address, workspace_id, organization_id FROM activity_log WHERE id > ? ORDER BY id',
).all(since);
const rowsOf = async (since, action) => (await rowsSince(since)).filter((r) => r.action === action);
async function oneRow(since, action) {
  const rows = await rowsOf(since, action);
  assert.equal(rows.length, 1, `exactly one ${action} row, read immediately after the response (got ${rows.length})`);
  return rows[0];
}
const noRow = async (since, action) => assert.deepEqual(await rowsOf(since, action), [], `no ${action} row`);
async function waitedRow(since, userId, action) {
  await waitForAuditRows(app.db, { sinceId: since, userId, actions: [action] });
  return oneRow(since, action);
}
const genericRow = (since, userId, action) => waitForAuditRows(app.db, { sinceId: since, userId, actions: [action] });
const list = (ids) => `[${[...ids].sort().join(', ')}]`;
function keepTokenSecret(secret) {
  secrets.push(secret, hashToken(secret), displayPrefix(secret));
}
// "token: <id>, targets: [..] -> [..]" -> { from, to }
const step = (details) => {
  const m = /targets: (\[[^\]]*\]) -> (\[[^\]]*\])$/.exec(details);
  assert.ok(m, `targets row format: ${details}`);
  return { from: m[1], to: m[2] };
};
// Steps must chain from `start` to `final` with no gap (row ids follow the order the audit
// writes landed, not commit order, so chain by value).
function assertChain(steps, start, final) {
  let cur = start;
  const left = [...steps];
  while (left.length) {
    const i = left.findIndex((s) => s.from === cur);
    assert.notEqual(i, -1, `a change from "${cur}" is missing: ${JSON.stringify(steps)}`);
    cur = left.splice(i, 1)[0].to;
  }
  assert.equal(cur, final, `the recorded changes end at the final value (${JSON.stringify(steps)})`);
}
async function mkAgencyToken(targets) {
  const r = await call('POST', '/api/tokens', F.ownerToken, { name: `${P} agency ${randTag()}`, scope: 'agency', target_playlist_ids: targets });
  assert.equal(r.status, 201, r.text);
  keepTokenSecret(r.json.token);
  return r.json;
}
async function currentTargets(tokenId) {
  return list((await app.db.prepare('SELECT playlist_id FROM api_token_targets WHERE token_id = ?').all(tokenId)).map((r) => r.playlist_id));
}

// ---- 19. api_token_created ----
test('api_token_created: id, name, scope, workspace (+ targets, auto_publish for agency); org + workspace ids; generic row kept', async () => {
  let since = await maxAuditId(app.db);
  const name = `${P} read token`;
  const r = await call('POST', '/api/tokens', F.ownerToken, { name, scope: 'read' });
  assert.equal(r.status, 201, r.text);
  keepTokenSecret(r.json.token);
  let row = await oneRow(since, 'api_token_created');
  assert.equal(row.user_id, F.owner.id);
  assert.equal(row.details, `token: ${r.json.id}, name: ${name}, scope: read, workspace: ${F.wsId}`);
  assert.equal(row.workspace_id, F.wsId);
  assert.equal(row.organization_id, F.orgId);
  assert.ok(row.ip_address, 'ip recorded');
  await genericRow(since, F.owner.id, 'POST /api/tokens/');

  since = await maxAuditId(app.db);
  const aname = `${P} agency`;
  const a = await call('POST', '/api/tokens', F.ownerToken, { name: aname, scope: 'agency', target_playlist_ids: [F.pl[1], F.pl[0]], auto_publish: true });
  assert.equal(a.status, 201, a.text);
  keepTokenSecret(a.json.token);
  row = await oneRow(since, 'api_token_created');
  assert.equal(row.details, `token: ${a.json.id}, name: ${aname}, scope: agency, workspace: ${F.wsId}, targets: ${list([F.pl[0], F.pl[1]])}, auto_publish: true`);
  await genericRow(since, F.owner.id, 'POST /api/tokens/');
});

// ---- 20. api_token_revoked ----
test('api_token_revoked: id, name, scope - written once; revoking an already-revoked token writes none', async () => {
  const name = `${P} to revoke`;
  const c = await call('POST', '/api/tokens', F.ownerToken, { name, scope: 'write' });
  assert.equal(c.status, 201, c.text);
  keepTokenSecret(c.json.token);

  let since = await maxAuditId(app.db);
  assert.equal((await call('DELETE', `/api/tokens/${c.json.id}`, F.ownerToken)).status, 200);
  const row = await oneRow(since, 'api_token_revoked');
  assert.equal(row.user_id, F.owner.id);
  assert.equal(row.details, `token: ${c.json.id}, name: ${name}, scope: write`);
  assert.equal(row.workspace_id, F.wsId);
  assert.equal(row.organization_id, F.orgId);
  await genericRow(since, F.owner.id, 'DELETE /api/tokens/:id');

  since = await maxAuditId(app.db);
  assert.equal((await call('DELETE', `/api/tokens/${c.json.id}`, F.ownerToken)).status, 200);
  await genericRow(since, F.owner.id, 'DELETE /api/tokens/:id');
  await noRow(since, 'api_token_revoked');
});

test('concurrent revokes of the same token: exactly ONE api_token_revoked row', async () => {
  const c = await call('POST', '/api/tokens', F.ownerToken, { name: `${P} race revoke`, scope: 'read' });
  assert.equal(c.status, 201, c.text);
  keepTokenSecret(c.json.token);
  const since = await maxAuditId(app.db);
  const results = await Promise.all(Array.from({ length: 8 }, () => call('DELETE', `/api/tokens/${c.json.id}`, F.ownerToken)));
  assert.deepEqual(results.map((r) => r.status), Array(8).fill(200));
  await waitForAuditRows(app.db, { sinceId: since, userId: F.owner.id, actions: ['DELETE /api/tokens/:id'], count: 8 });
  const rows = await rowsOf(since, 'api_token_revoked');
  assert.equal(rows.length, 1, `one revocation recorded, got ${rows.length}`);
});

// ---- 21. api_token_targets_changed ----
test('api_token_targets_changed: before -> after; unchanged targets (any order) write none', async () => {
  const t = await mkAgencyToken([F.pl[0], F.pl[1]]);
  let since = await maxAuditId(app.db);
  assert.equal((await call('PUT', `/api/tokens/${t.id}/targets`, F.ownerToken, { target_playlist_ids: [F.pl[2], F.pl[1]] })).status, 200);
  const row = await oneRow(since, 'api_token_targets_changed');
  assert.equal(row.user_id, F.owner.id);
  assert.equal(row.details, `token: ${t.id}, targets: ${list([F.pl[0], F.pl[1]])} -> ${list([F.pl[1], F.pl[2]])}`);
  assert.equal(row.workspace_id, F.wsId);
  assert.equal(row.organization_id, F.orgId);
  await genericRow(since, F.owner.id, 'PUT /api/tokens/:id/targets');

  since = await maxAuditId(app.db);
  assert.equal((await call('PUT', `/api/tokens/${t.id}/targets`, F.ownerToken, { target_playlist_ids: [F.pl[1], F.pl[2], F.pl[1]] })).status, 200);
  await genericRow(since, F.owner.id, 'PUT /api/tokens/:id/targets');
  await noRow(since, 'api_token_targets_changed');
});

test('concurrent target changes chain from the locked "before" values (no lost or doubled change)', async () => {
  const t = await mkAgencyToken([F.pl[0]]);
  const sets = [[F.pl[1]], [F.pl[2], F.pl[3]], [F.pl[0], F.pl[3]], [F.pl[1], F.pl[2]], [F.pl[3]], [F.pl[0], F.pl[1], F.pl[2]], [F.pl[2]], [F.pl[0], F.pl[2]]];
  const since = await maxAuditId(app.db);
  const results = await Promise.all(sets.map((s) => call('PUT', `/api/tokens/${t.id}/targets`, F.ownerToken, { target_playlist_ids: s })));
  assert.deepEqual(results.map((r) => r.status), Array(sets.length).fill(200), results.map((r) => r.text).join(' | '));
  const steps = (await rowsOf(since, 'api_token_targets_changed')).map((r) => step(r.details));
  assertChain(steps, list([F.pl[0]]), await currentTargets(t.id));
});

// ---- 22. device_command_sent (REST) ----
test('device_command_sent (REST): type + outcome, device_id + workspace set; lockdown awaited, others fire-and-forget; no payload', async () => {
  const marker = `PAYLOAD-${randTag()}`;
  secrets.push(marker);
  online.add(F.devOnline);

  let since = await maxAuditId(app.db);
  let r = await call('POST', `/api/devices/${F.devOnline}/command`, F.ownerToken, { type: 'enable_kiosk_lockdown', payload: { note: marker } });
  assert.equal(r.status, 200, r.text);
  let row = await oneRow(since, 'device_command_sent'); // awaited: read immediately
  assert.equal(row.user_id, F.owner.id);
  assert.equal(row.device_id, F.devOnline);
  assert.equal(row.workspace_id, F.wsId);
  assert.equal(row.details, 'type: enable_kiosk_lockdown, delivered: true, queued: false');
  await genericRow(since, F.owner.id, 'POST /api/devices/:id/command');

  since = await maxAuditId(app.db);
  r = await call('POST', `/api/devices/${F.devOnline}/command`, F.ownerToken, { type: 'screen_off', payload: { note: marker } });
  assert.equal(r.status, 200, r.text);
  row = await waitedRow(since, F.owner.id, 'device_command_sent');
  assert.equal(row.details, 'type: screen_off, delivered: true, queued: false');
  assert.equal(row.device_id, F.devOnline);
  await genericRow(since, F.owner.id, 'POST /api/devices/:id/command');

  since = await maxAuditId(app.db);
  r = await call('POST', `/api/devices/${F.devOffline}/command`, F.ownerToken, { type: 'disable_kiosk_lockdown', payload: { note: marker } });
  assert.equal(r.status, 200, r.text);
  row = await oneRow(since, 'device_command_sent');
  assert.equal(row.details, 'type: disable_kiosk_lockdown, delivered: false, queued: true');
  assert.equal(row.device_id, F.devOffline);
  assert.equal(row.workspace_id, F.wsId);

  since = await maxAuditId(app.db);
  r = await call('POST', `/api/devices/${F.devOffline}/command`, F.ownerToken, { type: 'screen_on', payload: { note: marker } });
  assert.equal(r.status, 200, r.text);
  row = await waitedRow(since, F.owner.id, 'device_command_sent');
  assert.equal(row.details, 'type: screen_on, delivered: false, queued: true');
  online.clear();
  commandQueue._resetForTests();
});

// ---- 23. device_group_command_sent ----
test('device_group_command_sent: group, type, sent/total; lockdown awaited, others fire-and-forget; no payload', async () => {
  const marker = `PAYLOAD-${randTag()}`;
  secrets.push(marker);
  online.add(F.devOnline);

  let since = await maxAuditId(app.db);
  let r = await call('POST', `/api/groups/${F.groupId}/command`, F.ownerToken, { type: 'enable_kiosk_lockdown', payload: { note: marker } });
  assert.equal(r.status, 200, r.text);
  let row = await oneRow(since, 'device_group_command_sent'); // awaited
  assert.equal(row.user_id, F.owner.id);
  assert.equal(row.details, `group: ${F.groupId}, type: enable_kiosk_lockdown, sent: 1/2`);
  assert.equal(row.workspace_id, F.wsId);
  await genericRow(since, F.owner.id, 'POST /api/groups/:id/command');

  since = await maxAuditId(app.db);
  r = await call('POST', `/api/groups/${F.groupId}/command`, F.ownerToken, { type: 'reboot', payload: { note: marker } });
  assert.equal(r.status, 200, r.text);
  row = await waitedRow(since, F.owner.id, 'device_group_command_sent');
  assert.equal(row.details, `group: ${F.groupId}, type: reboot, sent: 1/2`);
  await genericRow(since, F.owner.id, 'POST /api/groups/:id/command');
  online.clear();
});

// ---- 25. registration codes ----
test('registration_code_created / _regenerated / _revoked: id, workspace, planned name, expiry - never the code; awaited', async () => {
  const planned = `${P} lobby screen`;
  let since = await maxAuditId(app.db);
  const c = await call('POST', '/api/provisioning/registration-codes', F.ownerToken, { workspace_id: F.wsId, planned_device_name: planned });
  assert.equal(c.status, 201, c.text);
  codeValues.push(c.json.code);
  let row = await oneRow(since, 'registration_code_created');
  assert.equal(row.user_id, F.owner.id);
  assert.equal(row.details, `code_id: ${c.json.id}, workspace: ${F.wsId}, planned_device_name: ${planned}, expires_at: ${c.json.expires_at}`);
  assert.equal(row.workspace_id, F.wsId);
  assert.equal(row.organization_id, F.orgId);
  await genericRow(since, F.owner.id, 'POST /api/provisioning/registration-codes');

  since = await maxAuditId(app.db);
  const g = await call('POST', `/api/provisioning/registration-codes/${c.json.id}/regenerate`, F.ownerToken);
  assert.equal(g.status, 201, g.text);
  codeValues.push(g.json.code);
  row = await oneRow(since, 'registration_code_regenerated');
  assert.equal(row.details, `code_id: ${g.json.id}, workspace: ${F.wsId}, planned_device_name: ${planned}, expires_at: ${g.json.expires_at}, from: ${c.json.id}`);
  await genericRow(since, F.owner.id, 'POST /api/provisioning/registration-codes/:id/regenerate');

  since = await maxAuditId(app.db);
  assert.equal((await call('DELETE', `/api/provisioning/registration-codes/${g.json.id}`, F.ownerToken)).status, 200);
  row = await oneRow(since, 'registration_code_revoked');
  assert.equal(row.details, `code_id: ${g.json.id}, workspace: ${F.wsId}, planned_device_name: ${planned}, expires_at: ${g.json.expires_at}`);
  assert.equal(row.organization_id, F.orgId);
  await genericRow(since, F.owner.id, 'DELETE /api/provisioning/registration-codes/:id');

  // No planned name -> "none"; two concurrent deletes -> one row.
  const n = await call('POST', '/api/provisioning/registration-codes', F.ownerToken, { workspace_id: F.wsId });
  assert.equal(n.status, 201, n.text);
  codeValues.push(n.json.code);
  since = await maxAuditId(app.db);
  const dels = await Promise.all([1, 2].map(() => call('DELETE', `/api/provisioning/registration-codes/${n.json.id}`, F.ownerToken)));
  assert.ok(dels.some((d) => d.status === 200), dels.map((d) => d.status).join(','));
  row = await oneRow(since, 'registration_code_revoked');
  assert.equal(row.details, `code_id: ${n.json.id}, workspace: ${F.wsId}, planned_device_name: none, expires_at: ${n.json.expires_at}`);
});

// ---- SCIM tokens + Entra SPs (existing rows, now awaited) ----
test('admin_create_scim_token / admin_revoke_scim_token and Entra SP register / revoke: awaited, details unchanged, no secret', async () => {
  const name = `${P} scim`;
  let since = await maxAuditId(app.db);
  const s = await call('POST', '/api/admin/scim-tokens', F.platformToken, { name, organization_id: F.orgId });
  assert.equal(s.status, 201, s.text);
  created.scim.push(s.json.id);
  secrets.push(s.json.token, hashToken(s.json.token), s.json.prefix);
  let row = await oneRow(since, 'admin_create_scim_token');
  assert.equal(row.user_id, F.platform.id);
  assert.equal(row.details, `name: ${name}, organization: ${F.orgId}`);
  assert.equal(row.organization_id, F.orgId);
  await genericRow(since, F.platform.id, 'POST /api/admin/scim-tokens');

  since = await maxAuditId(app.db);
  assert.equal((await call('DELETE', `/api/admin/scim-tokens/${s.json.id}`, F.platformToken)).status, 200);
  row = await oneRow(since, 'admin_revoke_scim_token');
  assert.equal(row.details, `name: ${name}`);
  assert.equal(row.organization_id, F.orgId);
  await genericRow(since, F.platform.id, 'DELETE /api/admin/scim-tokens/:id');

  const clientId = crypto.randomUUID();
  const clientSecret = `SPSECRET-${randTag()}`; // no such field exists; must not leak anywhere
  secrets.push(clientSecret);
  since = await maxAuditId(app.db);
  const sp = await call('POST', '/api/admin/entra-service-principals', F.platformToken, { client_id: clientId, name: `${P} sp`, workspace_id: F.wsId, scope: 'read', client_secret: clientSecret });
  assert.equal(sp.status, 201, sp.text);
  created.sp.push(sp.json.id);
  row = await oneRow(since, 'admin_register_entra_sp');
  assert.equal(row.details, `client_id: ${clientId}, workspace: ${F.wsId}, scope: read`);
  assert.equal(row.workspace_id, F.wsId);
  await genericRow(since, F.platform.id, 'POST /api/admin/entra-service-principals');

  since = await maxAuditId(app.db);
  assert.equal((await call('DELETE', `/api/admin/entra-service-principals/${sp.json.id}`, F.platformToken)).status, 200);
  row = await oneRow(since, 'admin_revoke_entra_sp');
  assert.equal(row.details, `client_id: ${clientId}`);
  assert.equal(row.workspace_id, F.wsId);
  await genericRow(since, F.platform.id, 'DELETE /api/admin/entra-service-principals/:id');
});

test('concurrent revokes of the same SCIM token / Entra SP: exactly ONE revoke row each', async () => {
  const s = await call('POST', '/api/admin/scim-tokens', F.platformToken, { name: `${P} scim race`, organization_id: F.orgId });
  assert.equal(s.status, 201, s.text);
  created.scim.push(s.json.id);
  secrets.push(s.json.token, hashToken(s.json.token), s.json.prefix);
  let since = await maxAuditId(app.db);
  let results = await Promise.all(Array.from({ length: 8 }, () => call('DELETE', `/api/admin/scim-tokens/${s.json.id}`, F.platformToken)));
  assert.deepEqual(results.map((r) => r.status), Array(8).fill(200));
  await waitForAuditRows(app.db, { sinceId: since, userId: F.platform.id, actions: ['DELETE /api/admin/scim-tokens/:id'], count: 8 });
  let rows = await rowsOf(since, 'admin_revoke_scim_token');
  assert.equal(rows.length, 1, `one SCIM revocation recorded, got ${rows.length}`);

  const sp = await call('POST', '/api/admin/entra-service-principals', F.platformToken, { client_id: crypto.randomUUID(), name: `${P} sp race`, workspace_id: F.wsId, scope: 'read' });
  assert.equal(sp.status, 201, sp.text);
  created.sp.push(sp.json.id);
  since = await maxAuditId(app.db);
  results = await Promise.all(Array.from({ length: 8 }, () => call('DELETE', `/api/admin/entra-service-principals/${sp.json.id}`, F.platformToken)));
  assert.deepEqual(results.map((r) => r.status), Array(8).fill(200));
  await waitForAuditRows(app.db, { sinceId: since, userId: F.platform.id, actions: ['DELETE /api/admin/entra-service-principals/:id'], count: 8 });
  rows = await rowsOf(since, 'admin_revoke_entra_sp');
  assert.equal(rows.length, 1, `one SP revocation recorded, got ${rows.length}`);
});

// ---- 24. dashboard socket ----
test('device_command_sent (socket): via socket, outcome, device_id, handshake IP; a failed audit write disconnects nothing', async () => {
  const httpServer = http.createServer();
  const io = new Server(httpServer);
  setupDashboardSocket(io);
  io.of('/device').on('connection', (s) => { s.on('register', (d) => s.join(d)); });
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${httpServer.address().port}`;
  const marker = `PAYLOAD-${randTag()}`;
  secrets.push(marker);
  const sockets = [];
  try {
    const dev = ioClient(`${base}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
    sockets.push(dev);
    await new Promise((r, j) => { dev.on('connect', r); dev.on('connect_error', j); });
    dev.emit('register', F.devOnline);
    const dash = ioClient(`${base}/dashboard`, {
      auth: { token: F.ownerToken }, transports: ['websocket'], reconnection: false, forceNew: true,
      extraHeaders: { 'x-forwarded-for': '203.0.113.9' }, // loopback peer is a trusted proxy
    });
    sockets.push(dash);
    await new Promise((r, j) => { dash.on('connect', r); dash.on('connect_error', j); });
    let disconnected = false;
    dash.on('disconnect', () => { disconnected = true; });
    const send = (deviceId, type) => new Promise((resolve) => {
      dash.timeout(3000).emit('dashboard:device-command', { device_id: deviceId, type, payload: { note: marker } },
        (err, ack) => resolve(err ? { timedOut: true } : ack));
    });
    await new Promise((r) => setTimeout(r, 100)); // device room joined

    let since = await maxAuditId(app.db);
    assert.deepEqual(await send(F.devOnline, 'screen_off'), { delivered: true });
    let row = await waitedRow(since, F.owner.id, 'device_command_sent');
    assert.equal(row.details, 'type: screen_off, via: socket, delivered: true, queued: false');
    assert.equal(row.device_id, F.devOnline);
    assert.equal(row.workspace_id, F.wsId);
    assert.equal(row.ip_address, '203.0.113.9');

    since = await maxAuditId(app.db);
    assert.deepEqual(await send(F.devOffline, 'screen_on'), { delivered: false, queued: true, reason: 'offline' });
    row = await waitedRow(since, F.owner.id, 'device_command_sent');
    assert.equal(row.details, 'type: screen_on, via: socket, delivered: false, queued: true');
    assert.equal(row.device_id, F.devOffline);

    // Forced audit failure on the next socket command: the command still goes out, the
    // ack arrives, the socket stays connected, the failure is reported loudly.
    errors.length = 0;
    failNextAudit = { action: 'device_command_sent', deviceId: F.devOnline };
    since = await maxAuditId(app.db);
    assert.deepEqual(await send(F.devOnline, 'reboot'), { delivered: true });
    const deadline = Date.now() + 3000;
    while (!errors.some((e) => e.includes('[audit] NOT AUDITED: action=device_command_sent')) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(failNextAudit, null, 'the forced failure fired');
    assert.ok(errors.some((e) => e.includes(`[audit] NOT AUDITED: action=device_command_sent actor=${F.owner.id} target=${F.devOnline}`)), errors.join('\n'));
    await noRow(since, 'device_command_sent');
    assert.equal(dash.connected, true, 'dashboard socket still connected');
    assert.equal(disconnected, false);
    // ... and the next command works and is audited.
    since = await maxAuditId(app.db);
    assert.deepEqual(await send(F.devOnline, 'screen_on'), { delivered: true });
    row = await waitedRow(since, F.owner.id, 'device_command_sent');
    assert.equal(row.details, 'type: screen_on, via: socket, delivered: true, queued: false');
  } finally {
    for (const s of sockets) { try { s.close(); } catch { /* */ } }
    commandQueue._resetForTests();
    await new Promise((r) => io.close(() => r()));
  }
});

// ---- secret scan over everything this file wrote ----
test('secret scan: no token value / hash / prefix, registration code, command payload or SP secret in any row', async () => {
  const rows = await rowsSince(since0);
  assert.ok(rows.length > 30, `rows to scan: ${rows.length}`);
  for (const r of rows) {
    const text = `${r.action} ${r.details ?? ''} ${r.ip_address ?? ''}`;
    for (const s of secrets) assert.ok(!text.includes(s), `audit row ${r.id} (${r.action}) contains a secret`);
    for (const c of codeValues) assert.ok(!new RegExp(`(^|[^0-9])${c}([^0-9]|$)`).test(text), `audit row ${r.id} (${r.action}) contains a registration code`);
  }
});
