'use strict';

// Phase 1C batch 1: credential issuance writes its audit row IN THE SAME TRANSACTION as
// the change (services/activity.js auditInTx). If the audit write fails, nothing is
// created, no secret / code is returned and the request gets
// 503 { error: 'Change not applied: audit unavailable', code: 'AUDIT_UNAVAILABLE' }.
//
// Routes: API token create, agency targets change (a grant; pure narrowing keeps the
// awaited post-commit row), SCIM token create, Entra SP register, registration code
// create / regenerate.
//
// Failure injection: helpers/fail-audit-in-tx.js wraps lib/activity-chain's exported
// appendInTx so ONE chosen auditInTx call throws. It must load before services/activity
// (first require below). Each failure test snapshots the affected tables before and after
// and asserts "not applied", no audit row, no secret in the response, then that the next
// attempt succeeds with exactly one row (read immediately: it committed with the change).
//
// Also: a pre-existing race on the SP-register lines, fixed in this batch (concurrent
// registrations of one client_id: exactly one 201, the rest 409); a burst of concurrent
// credential requests plus fire-and-forget rows (no deadlock 500s, every change matched by
// its row); verifyChain and GET /api/activity/verify-integrity over every row written here.
//
// Real routers in-process (helpers/inprocess-app.js, with server.js's error handler)
// against the real MySQL test DB. Fixtures are test-owned (prefix ait-).

const failHook = require('./helpers/fail-audit-in-tx'); // before services/activity loads

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { db } = require('../db/database');
const { generateToken } = require('../middleware/auth');
const { hashToken } = require('../middleware/apiToken');
const { logActivity } = require('../services/activity');
const { verifyChain } = require('../lib/activity-chain');
const { startInProcessApp } = require('./helpers/inprocess-app');
const { randTag, cleanupUsers } = require('./helpers/disposable');
const { maxAuditId, waitForAuditRows } = require('./helpers/wait-for-audit');

const P = `ait-${randTag()}`;
const id = (n) => `${P}-${n}`;
let app;
let since0;
const userIds = [];
const F = {};
const UNAVAILABLE = { error: 'Change not applied: audit unavailable', code: 'AUDIT_UNAVAILABLE' };

test.before(async () => {
  app = await startInProcessApp({ only: ['/api/tokens', '/api/provisioning', '/api/admin', '/api/activity'] });
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
});

test.after(async () => {
  try {
    if (app) {
      failHook.disarm();
      await app.db.prepare('DELETE FROM scim_tokens WHERE organization_id = ?').run(F.orgId);
      await app.db.prepare('DELETE FROM entra_service_principals WHERE workspace_id = ?').run(F.wsId);
      await app.db.prepare('DELETE FROM registration_codes WHERE workspace_id = ?').run(F.wsId);
      await cleanupUsers(app.db, [...userIds].reverse());
    }
  } finally {
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
  'SELECT id, user_id, action, details, workspace_id, organization_id FROM activity_log WHERE id > ? ORDER BY id',
).all(since);
const rowsOf = async (since, action) => (await rowsSince(since)).filter((r) => r.action === action);
async function oneRow(since, action) {
  const rows = await rowsOf(since, action);
  assert.equal(rows.length, 1, `exactly one ${action} row, read immediately after the response (got ${rows.length})`);
  return rows[0];
}
const list = (ids) => `[${[...ids].sort().join(', ')}]`;

// Every row of the credential tables this file's fixtures can own, as one comparable value.
async function snapshot() {
  const q = (sql, ...p) => app.db.prepare(sql).all(...p);
  return JSON.stringify({
    api_tokens: await q('SELECT id, name, scope, revoked_at FROM api_tokens WHERE workspace_id = ? ORDER BY id', F.wsId),
    targets: await q('SELECT t.token_id, t.playlist_id FROM api_token_targets t JOIN api_tokens a ON a.id = t.token_id WHERE a.workspace_id = ? ORDER BY t.token_id, t.playlist_id', F.wsId),
    scim_tokens: await q('SELECT id, name, revoked_at FROM scim_tokens WHERE organization_id = ? ORDER BY id', F.orgId),
    sps: await q('SELECT id, client_id, name, scope, revoked_at FROM entra_service_principals WHERE workspace_id = ? ORDER BY id', F.wsId),
    codes: await q('SELECT id, code, status FROM registration_codes WHERE workspace_id = ? ORDER BY id', F.wsId),
  });
}

// One injected audit failure for `action`: 503 AUDIT_UNAVAILABLE, nothing changed, no
// row, nothing secret in the response. Returns `since` for the follow-up attempt.
async function assertFailureNotApplied(action, request) {
  const before = await snapshot();
  const since = await maxAuditId(app.db);
  const fired0 = failHook.fired();
  failHook.failNextAuditInTx(action);
  const r = await request();
  const disarmed = failHook.disarm();
  const after = await snapshot();
  const rows = await rowsOf(since, action);
  if (after !== before && rows.length === 0) {
    assert.fail(`change applied, no row: ${action} answered ${r.status} and changed the DB without an audit row`);
  }
  assert.equal(disarmed, false, `the injected failure for ${action} fired`);
  assert.equal(failHook.fired(), fired0 + 1);
  assert.equal(r.status, 503, `${r.status} ${r.text}`);
  assert.deepEqual(r.json, UNAVAILABLE, 'nothing but the error and its code in the response');
  assert.equal(after, before, 'the change was not applied');
  assert.deepEqual(rows, [], `no ${action} row`);
  return since;
}

// ---- failure proofs ----
test('API token create: audit failure -> 503, no token, no secret; next attempt -> one row', async () => {
  await assertFailureNotApplied('api_token_created', () => call('POST', '/api/tokens', F.ownerToken, { name: `${P} t1`, scope: 'read' }));
  const since = await maxAuditId(app.db);
  const ok = await call('POST', '/api/tokens', F.ownerToken, { name: `${P} t1`, scope: 'read' });
  assert.equal(ok.status, 201, ok.text);
  const row = await oneRow(since, 'api_token_created');
  assert.equal(row.details, `token: ${ok.json.id}, name: ${P} t1, scope: read, workspace: ${F.wsId}`);
  assert.ok(!row.details.includes(ok.json.token) && !row.details.includes(hashToken(ok.json.token)) && !row.details.includes(ok.json.prefix));

  // Agency: the token AND its targets roll back together.
  await assertFailureNotApplied('api_token_created', () => call('POST', '/api/tokens', F.ownerToken, { name: `${P} a1`, scope: 'agency', target_playlist_ids: [F.pl[0], F.pl[1]] }));
});

test('agency targets: a grant (any playlist added) is in-transaction; pure narrowing keeps the post-commit row', async () => {
  const c = await call('POST', '/api/tokens', F.ownerToken, { name: `${P} agency`, scope: 'agency', target_playlist_ids: [F.pl[0]] });
  assert.equal(c.status, 201, c.text);
  const url = `/api/tokens/${c.json.id}/targets`;

  await assertFailureNotApplied('api_token_targets_changed', () => call('PUT', url, F.ownerToken, { target_playlist_ids: [F.pl[0], F.pl[1]] }));
  let since = await maxAuditId(app.db);
  assert.equal((await call('PUT', url, F.ownerToken, { target_playlist_ids: [F.pl[0], F.pl[1]] })).status, 200);
  let row = await oneRow(since, 'api_token_targets_changed');
  assert.equal(row.details, `token: ${c.json.id}, targets: ${list([F.pl[0]])} -> ${list([F.pl[0], F.pl[1]])}`);

  // A swap (one removed, one added) is not strictly lower -> a grant.
  await assertFailureNotApplied('api_token_targets_changed', () => call('PUT', url, F.ownerToken, { target_playlist_ids: [F.pl[0], F.pl[2]] }));

  // Narrowing: not in-transaction - an armed failure does not fire, the change applies
  // and its awaited row is written.
  since = await maxAuditId(app.db);
  failHook.failNextAuditInTx('api_token_targets_changed');
  const n = await call('PUT', url, F.ownerToken, { target_playlist_ids: [F.pl[1]] });
  assert.equal(failHook.disarm(), true, 'narrowing never reached auditInTx');
  assert.equal(n.status, 200, n.text);
  row = await oneRow(since, 'api_token_targets_changed');
  assert.equal(row.details, `token: ${c.json.id}, targets: ${list([F.pl[0], F.pl[1]])} -> ${list([F.pl[1]])}`);
});

test('SCIM token create: audit failure -> 503, no token, no secret; next attempt -> one row', async () => {
  await assertFailureNotApplied('admin_create_scim_token', () => call('POST', '/api/admin/scim-tokens', F.platformToken, { name: `${P} scim`, organization_id: F.orgId }));
  const since = await maxAuditId(app.db);
  const ok = await call('POST', '/api/admin/scim-tokens', F.platformToken, { name: `${P} scim`, organization_id: F.orgId });
  assert.equal(ok.status, 201, ok.text);
  const row = await oneRow(since, 'admin_create_scim_token');
  assert.equal(row.details, `name: ${P} scim, organization: ${F.orgId}`);
  assert.equal(row.organization_id, F.orgId);
});

test('Entra SP register (new and re-registering a revoked one): audit failure -> 503, nothing changed; next attempt -> one row', async () => {
  const clientId = crypto.randomUUID();
  const body = { client_id: clientId, name: `${P} sp`, workspace_id: F.wsId, scope: 'read' };
  await assertFailureNotApplied('admin_register_entra_sp', () => call('POST', '/api/admin/entra-service-principals', F.platformToken, body));
  let since = await maxAuditId(app.db);
  const ok = await call('POST', '/api/admin/entra-service-principals', F.platformToken, body);
  assert.equal(ok.status, 201, ok.text);
  const row = await oneRow(since, 'admin_register_entra_sp');
  assert.equal(row.details, `client_id: ${clientId}, workspace: ${F.wsId}, scope: read`);

  // Revoke, then a failed re-registration leaves it revoked (the in-place UPDATE rolls back).
  assert.equal((await call('DELETE', `/api/admin/entra-service-principals/${ok.json.id}`, F.platformToken)).status, 200);
  await assertFailureNotApplied('admin_register_entra_sp', () => call('POST', '/api/admin/entra-service-principals', F.platformToken, { ...body, scope: 'write' }));
  since = await maxAuditId(app.db);
  const again = await call('POST', '/api/admin/entra-service-principals', F.platformToken, { ...body, scope: 'write' });
  assert.equal(again.status, 201, again.text);
  assert.equal((await oneRow(since, 'admin_register_entra_sp')).details, `client_id: ${clientId}, workspace: ${F.wsId}, scope: write`);
});

test('registration code create / regenerate: audit failure -> 503, no code; next attempt -> one row', async () => {
  const planned = `${P} kiosk`;
  await assertFailureNotApplied('registration_code_created', () => call('POST', '/api/provisioning/registration-codes', F.ownerToken, { workspace_id: F.wsId, planned_device_name: planned }));
  let since = await maxAuditId(app.db);
  const c = await call('POST', '/api/provisioning/registration-codes', F.ownerToken, { workspace_id: F.wsId, planned_device_name: planned });
  assert.equal(c.status, 201, c.text);
  let row = await oneRow(since, 'registration_code_created');
  assert.equal(row.details, `code_id: ${c.json.id}, workspace: ${F.wsId}, planned_device_name: ${planned}, expires_at: ${c.json.expires_at}`);

  const url = `/api/provisioning/registration-codes/${c.json.id}/regenerate`;
  await assertFailureNotApplied('registration_code_regenerated', () => call('POST', url, F.ownerToken));
  since = await maxAuditId(app.db);
  const g = await call('POST', url, F.ownerToken);
  assert.equal(g.status, 201, g.text);
  row = await oneRow(since, 'registration_code_regenerated');
  assert.equal(row.details, `code_id: ${g.json.id}, workspace: ${F.wsId}, planned_device_name: ${planned}, expires_at: ${g.json.expires_at}, from: ${c.json.id}`);
  for (const r of await rowsSince(since0)) {
    for (const code of [c.json.code, g.json.code]) {
      assert.ok(!new RegExp(`(^|[^0-9])${code}([^0-9]|$)`).test(`${r.action} ${r.details ?? ''}`), `row ${r.id} holds a code`);
    }
  }
});

// ---- pre-existing race on the SP-register lines (fixed in this batch) ----
test('race: concurrent registrations of one client_id -> exactly one 201, the rest 409, one row, one audit row (new and revoked)', async () => {
  for (const revokedFirst of [false, true]) {
    const clientId = crypto.randomUUID();
    if (revokedFirst) {
      const r0 = await call('POST', '/api/admin/entra-service-principals', F.platformToken, { client_id: clientId, name: `${P} sp0`, workspace_id: F.wsId, scope: 'read' });
      assert.equal(r0.status, 201, r0.text);
      assert.equal((await call('DELETE', `/api/admin/entra-service-principals/${r0.json.id}`, F.platformToken)).status, 200);
    }
    const since = await maxAuditId(app.db);
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => call('POST', '/api/admin/entra-service-principals', F.platformToken,
      { client_id: clientId, name: `${P} sp-race-${i}`, workspace_id: F.wsId, scope: 'read' })));
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [201, 409, 409, 409, 409, 409, 409, 409], `${revokedFirst ? 'revoked' : 'new'} client_id: ${results.map((r) => r.text).join(' | ')}`);
    const winner = results.find((r) => r.status === 201).json;
    const live = await app.db.prepare('SELECT id, name, revoked_at FROM entra_service_principals WHERE client_id = ?').all(clientId);
    assert.equal(live.length, 1);
    assert.equal(live[0].id, winner.id, 'the stored registration is the one that answered 201');
    assert.equal(live[0].revoked_at, null);
    assert.equal((await rowsOf(since, 'admin_register_entra_sp')).length, 1, 'one registration audited');
  }
});

// ---- burst: concurrent in-scope credential requests + fire-and-forget rows ----
test('burst: 20 concurrent credential requests + 20 fire-and-forget rows -> no 500s, every change matched by exactly one row', async () => {
  const agency = await call('POST', '/api/tokens', F.ownerToken, { name: `${P} burst agency`, scope: 'agency', target_playlist_ids: [F.pl[0]] });
  assert.equal(agency.status, 201, agency.text);
  const since = await maxAuditId(app.db);
  const marker = `${P}-ff`;
  const reqs = [];
  for (let i = 0; i < 5; i++) reqs.push(['token', call('POST', '/api/tokens', F.ownerToken, { name: `${P} burst ${i}`, scope: 'write' })]);
  for (let i = 0; i < 4; i++) reqs.push(['scim', call('POST', '/api/admin/scim-tokens', F.platformToken, { name: `${P} burst scim ${i}`, organization_id: F.orgId })]);
  for (let i = 0; i < 4; i++) reqs.push(['sp', call('POST', '/api/admin/entra-service-principals', F.platformToken, { client_id: crypto.randomUUID(), name: `${P} burst sp ${i}`, workspace_id: F.wsId, scope: 'read' })]);
  for (let i = 0; i < 4; i++) reqs.push(['code', call('POST', '/api/provisioning/registration-codes', F.ownerToken, { workspace_id: F.wsId, planned_device_name: `${P} burst ${i}` })]);
  for (let i = 0; i < 3; i++) reqs.push(['targets', call('PUT', `/api/tokens/${agency.json.id}/targets`, F.ownerToken, { target_playlist_ids: F.pl.slice(0, i + 2) })]);
  const ff = Array.from({ length: 20 }, (_, i) => logActivity(F.owner.id, 'burst_fire_and_forget', `${marker} ${i}`));
  const results = await Promise.all(reqs.map(([, p]) => p));
  assert.deepEqual(await Promise.all(ff), Array(20).fill(true), 'every fire-and-forget row written');
  const statuses = results.map((r) => r.status);
  assert.ok(statuses.every((s) => s === 200 || s === 201), `no errors: ${results.filter((r) => r.status >= 300).map((r) => `${r.status} ${r.text}`).join(' | ')}`);

  const rows = await rowsSince(since);
  const byAction = (a) => rows.filter((r) => r.action === a);
  const kind = (k) => reqs.map(([kk], i) => (kk === k ? results[i] : null)).filter(Boolean);
  const tokenIds = kind('token').map((r) => r.json.id).sort();
  assert.deepEqual(byAction('api_token_created').map((r) => /^token: ([^,]+),/.exec(r.details)[1]).sort(), tokenIds);
  assert.deepEqual(byAction('admin_create_scim_token').map((r) => r.details).sort(), kind('scim').map((r) => `name: ${r.json.name}, organization: ${F.orgId}`).sort());
  assert.deepEqual(byAction('admin_register_entra_sp').map((r) => /client_id: ([^,]+),/.exec(r.details)[1]).sort(), kind('sp').map((r) => r.json.client_id).sort());
  assert.deepEqual(byAction('registration_code_created').map((r) => /^code_id: ([^,]+),/.exec(r.details)[1]).sort(), kind('code').map((r) => r.json.id).sort());
  // Targets: every change is recorded and they chain [p1] -> ... -> final.
  const steps = byAction('api_token_targets_changed').map((r) => /targets: (\[[^\]]*\]) -> (\[[^\]]*\])$/.exec(r.details)).map((m) => ({ from: m[1], to: m[2] }));
  let cur = list([F.pl[0]]);
  const left = [...steps];
  while (left.length) {
    const i = left.findIndex((s) => s.from === cur);
    assert.notEqual(i, -1, `targets chain broken at ${cur}: ${JSON.stringify(steps)}`);
    cur = left.splice(i, 1)[0].to;
  }
  const final = list((await app.db.prepare('SELECT playlist_id FROM api_token_targets WHERE token_id = ?').all(agency.json.id)).map((r) => r.playlist_id));
  assert.equal(cur, final);
  assert.equal(rows.filter((r) => r.action === 'burst_fire_and_forget' && r.details.startsWith(marker)).length, 20);
  // And the DB holds exactly what was answered.
  for (const t of tokenIds) assert.ok(await app.db.prepare('SELECT 1 FROM api_tokens WHERE id = ?').get(t));
  for (const r of kind('code')) assert.ok(await app.db.prepare('SELECT 1 FROM registration_codes WHERE id = ?').get(r.json.id));
});

// ---- chain integrity over everything written here ----
test('chain: verifyChain and GET /api/activity/verify-integrity pass over every row this file wrote', async () => {
  const end = await maxAuditId(app.db);
  assert.ok(end > since0 + 30, `rows written: ${end - since0}`);
  const report = await verifyChain(app.db, { startId: since0 + 1, endId: end });
  assert.equal(report.ok, true, JSON.stringify(report).slice(0, 2000));
  const r = await call('GET', `/api/activity/verify-integrity?start_id=${since0 + 1}&end_id=${end}`, F.platformToken);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.ok, true, r.text.slice(0, 2000));
});
