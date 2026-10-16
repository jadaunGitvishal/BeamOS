'use strict';

// Ref 50 — GET /api/dashboard/content/:contentId/plays (proof-of-play timeline).
//
// Same harness as dashboard-content-export.test.js: the REAL dashboard-content router
// with the real requireAuth + resolveTenancy chain (helpers/inprocess-app.js) against the
// REAL MySQL test DB (beamos_test via npm test). Two tenants, a device + play_logs in each.
// Asserts: the endpoint returns the caller's own individual play rows (device name
// joined, newest-first, capped), never the other tenant's; unknown / cross-tenant content
// ids yield an empty timeline, not a leak or a 500.
//
// Fixtures are test-owned (dcp- prefix, generated ids); deleting the two users cascades
// their orgs, workspaces, content, devices and (FK cascade) play_logs.

const test = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const { generateToken } = require('../middleware/auth');
const { startInProcessApp } = require('./helpers/inprocess-app');
const { randTag, cleanupUsers } = require('./helpers/disposable');

const P = `dcp-${randTag()}`;
const id = (name) => `${P}-${name}`;
const ID = {
  userA: id('user-a'), userB: id('user-b'), orgA: id('org-a'), orgB: id('org-b'),
  wsA: id('ws-a'), wsB: id('ws-b'), devA: id('device-a'), devB: id('device-b'),
  shared: id('shared-cid'), other: id('other-cid'),
};
const EMAIL_A = `${P}-a@tenant-a.test`;
let app;
let base;
let tokA;
let tokB;

test.before(async () => {
  app = await startInProcessApp({ only: ['/api/dashboard/content'] });
  base = app.base;
  const run = (sql, ...p) => app.db.prepare(sql).run(...p);

  // --- Seed two tenants ---
  await run("INSERT INTO users (id, email, role, password_hash, auth_provider) VALUES (?, ?, 'user', NULL, 'local')", ID.userA, EMAIL_A);
  await run("INSERT INTO users (id, email, role, password_hash, auth_provider) VALUES (?, ?, 'user', NULL, 'local')", ID.userB, `${P}-b@tenant-b.test`);
  const org = "INSERT INTO organizations (id, name, owner_user_id, plan_id, subscription_status) VALUES (?, ?, ?, 'enterprise', 'active')";
  await run(org, ID.orgA, `${P} Org A`, ID.userA);
  await run(org, ID.orgB, `${P} Org B`, ID.userB);
  await run('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)', ID.wsA, ID.orgA, 'Workspace A');
  await run('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)', ID.wsB, ID.orgB, 'Workspace B');
  await run("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin')", ID.wsA, ID.userA);
  await run("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin')", ID.wsB, ID.userB);
  await run('INSERT INTO devices (id, workspace_id, name) VALUES (?, ?, ?)', ID.devA, ID.wsA, 'Lobby A');
  await run('INSERT INTO devices (id, workspace_id, name) VALUES (?, ?, ?)', ID.devB, ID.wsB, 'Lobby B');
  // play_logs.content_id references content(id).
  const content = 'INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type) VALUES (?, ?, ?, ?, ?, ?)';
  await run(content, ID.shared, ID.userA, ID.wsA, 'shared.png', 'shared.png', 'image/png');
  await run(content, ID.other, ID.userB, ID.wsB, 'other.png', 'other.png', 'image/png');

  const now = Math.floor(Date.now() / 1000);
  const play = (device, cid, name, offset, dur, done) => run(
    'INSERT INTO play_logs (device_id, content_id, content_name, started_at, ended_at, duration_sec, completed) VALUES (?, ?, ?, ?, ?, ?, ?)',
    device, cid, name, now - offset, dur === null ? null : now - offset + dur, dur, done,
  );
  // Shared content id across both tenants — the canary: /plays for the shared id
  // must return ONLY the caller's own device's rows.
  await play(ID.devA, ID.shared, 'TENANT-A Promo', 300, 30, 1); // newest for A
  await play(ID.devA, ID.shared, 'TENANT-A Promo', 900, null, 0); // play-start only, no duration
  await play(ID.devA, ID.shared, 'TENANT-A Promo', 1800, 12, 0);
  await play(ID.devB, ID.shared, 'TENANT-B Promo', 120, 45, 1); // B's row — newer than any of A's
  await play(ID.devB, ID.other, 'TENANT-B Other', 60, 5, 1);

  tokA = generateToken({ id: ID.userA, email: EMAIL_A, role: 'user' }, ID.wsA);
  tokB = generateToken({ id: ID.userB, email: `${P}-b@tenant-b.test`, role: 'user' }, ID.wsB);
});

test.after(async () => {
  try {
    if (app) await cleanupUsers(app.db, [ID.userB, ID.userA]);
  } finally {
    if (app) await app.stop(); else await db.close();
  }
});

const authed = (token) => ({ headers: { Authorization: `Bearer ${token}` } });
async function plays(token, cid) {
  const res = await fetch(`${base}/api/dashboard/content/${encodeURIComponent(cid)}/plays`, authed(token));
  return { res, body: await res.json() };
}

test('returns the caller\'s own individual play rows, newest-first, device name joined', async () => {
  const { res, body } = await plays(tokA, ID.shared);
  assert.equal(res.status, 200);
  assert.equal(body.content_id, ID.shared);
  assert.equal(body.plays.length, 3);
  assert.deepEqual(
    body.plays.map((p) => p.started_at),
    [...body.plays.map((p) => p.started_at)].sort((a, b) => b - a),
  );
  assert.ok(body.plays.every((p) => p.device_name === 'Lobby A'));
  assert.equal(body.plays[0].completed, true);
  assert.equal(body.plays[0].duration_sec, 30);
  // play-start-only row survives with a null duration, not dropped
  assert.ok(body.plays.some((p) => p.duration_sec === null));
});

test('cross-tenant: tenant A never sees tenant B\'s rows for a shared content id', async () => {
  const { body } = await plays(tokA, ID.shared);
  assert.ok(body.plays.every((p) => p.device_name === 'Lobby A'));
  assert.ok(!JSON.stringify(body).includes('TENANT-B'));
  assert.ok(!JSON.stringify(body).includes('Lobby B'));
});

test('cross-tenant: tenant B sees only its own single row for the shared content id', async () => {
  const { body } = await plays(tokB, ID.shared);
  assert.equal(body.plays.length, 1);
  assert.equal(body.plays[0].device_name, 'Lobby B');
  assert.equal(body.content_name, 'TENANT-B Promo');
});

test('content id that exists only in the other tenant -> empty timeline, not a leak', async () => {
  const { res, body } = await plays(tokA, ID.other);
  assert.equal(res.status, 200);
  assert.deepEqual(body.plays, []);
  assert.equal(body.content_name, null);
});

test('unknown content id -> empty timeline, 200 not 500', async () => {
  const { res, body } = await plays(tokA, id('does-not-exist'));
  assert.equal(res.status, 200);
  assert.deepEqual(body.plays, []);
});

test('token with no explicit workspace still only ever yields the user\'s own rows', async () => {
  // resolveTenancy falls back to the user's own membership, so user-A here
  // resolves to ws-A - the point is it can NEVER resolve to ws-B's rows.
  const tokNoWs = generateToken({ id: ID.userA, email: EMAIL_A, role: 'user' }, null);
  const res = await fetch(`${base}/api/dashboard/content/${encodeURIComponent(ID.shared)}/plays`, authed(tokNoWs));
  if (res.status === 200) {
    const body = await res.json();
    assert.ok(body.plays.every((p) => p.device_name === 'Lobby A'));
    assert.ok(!JSON.stringify(body).includes('Lobby B'));
  } else {
    assert.ok([400, 401, 403].includes(res.status));
  }
});
