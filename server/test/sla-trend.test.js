'use strict';

// Ref 51 Step 4 — GET /api/dashboard/reports/sla-trend
//
// The real requireAuth + resolveTenancy chain and dashboard-reports router
// (helpers/inprocess-app.js) against the REAL MySQL test DB (beamos_test via npm test).
// device_usage_daily is seeded with hand-picked online_seconds so every returned
// avg_uptime_pct is checkable by hand; a second workspace's rows prove the query is
// workspace-scoped. Days are relative to today (as before).
//
// Fixtures are test-owned (slt- prefix, generated ids). device_usage_daily has no FK to
// devices, so this file deletes its own rows by device id; the rest goes with the users.

const test = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const { generateToken } = require('../middleware/auth');
const { startInProcessApp } = require('./helpers/inprocess-app');
const { randTag, cleanupUsers } = require('./helpers/disposable');

const P = `slt-${randTag()}`;
const id = (name) => `${P}-${name}`;
const ID = {
  userA: id('user-a'), userB: id('user-b'), userX: id('user-x'), orgA: id('org-a'), orgB: id('org-b'),
  wsA: id('ws-a'), wsB: id('ws-b'),
};
const DEVICES = ['a1', 'a2', 'a3', 'b1'].map(id);

const dayStr = (agoDays) => new Date(Date.now() - agoDays * 86400000).toISOString().slice(0, 10);
const D0 = dayStr(0), D1 = dayStr(1), D2 = dayStr(2), D3 = dayStr(3);

let app;
let base;
let tokA;
let tokB;

test.before(async () => {
  app = await startInProcessApp({ only: ['/api/dashboard/reports'] });
  base = app.base;
  const run = (sql, ...p) => db.prepare(sql).run(...p);
  await run("INSERT INTO users (id, email, role, password_hash, auth_provider) VALUES (?, ?, 'user', NULL, 'local')", ID.userA, `${P}-a@t.test`);
  await run("INSERT INTO users (id, email, role, password_hash, auth_provider) VALUES (?, ?, 'user', NULL, 'local')", ID.userB, `${P}-b@t.test`);
  const org = "INSERT INTO organizations (id, name, owner_user_id, plan_id, subscription_status) VALUES (?, ?, ?, 'enterprise', 'active')";
  await run(org, ID.orgA, `${P} A`, ID.userA);
  await run(org, ID.orgB, `${P} B`, ID.userB);
  await run('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)', ID.wsA, ID.orgA, 'WS A');
  await run('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)', ID.wsB, ID.orgB, 'WS B');
  await run("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin')", ID.wsA, ID.userA);
  await run("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin')", ID.wsB, ID.userB);

  for (const d of ['a1', 'a2', 'a3']) await run('INSERT INTO devices (id, workspace_id, name) VALUES (?, ?, ?)', id(d), ID.wsA, d);
  await run('INSERT INTO devices (id, workspace_id, name) VALUES (?, ?, ?)', id('b1'), ID.wsB, 'b1');

  const usage = (device, day, sec) =>
    run('INSERT INTO device_usage_daily (device_id, day, online_seconds) VALUES (?, ?, ?)', id(device), day, sec);
  // D3 (oldest): 3 devices at 25% / 50% / 75%  -> avg 50.0
  await usage('a1', D3, 21600); await usage('a2', D3, 43200); await usage('a3', D3, 64800);
  // D2: only 2 devices reported, 100% / 50%      -> avg 75.0
  await usage('a1', D2, 86400); await usage('a2', D2, 43200);
  // D1: 3 devices all at 10%                     -> avg 10.0
  await usage('a1', D1, 8640); await usage('a2', D1, 8640); await usage('a3', D1, 8640);
  // D0 (today): 3 devices 90% / 95% / 100%       -> avg 95.0
  await usage('a1', D0, 77760); await usage('a2', D0, 82080); await usage('a3', D0, 86400);
  // ws-b, D1: a full day — must never appear in ws-a's trend
  await usage('b1', D1, 86400);

  tokA = generateToken({ id: ID.userA, email: `${P}-a@t.test`, role: 'user' }, ID.wsA);
  tokB = generateToken({ id: ID.userB, email: `${P}-b@t.test`, role: 'user' }, ID.wsB);
});

test.after(async () => {
  try {
    if (app) {
      // device_usage_daily has no FK to devices: delete this file's rows explicitly.
      for (const d of DEVICES) await db.prepare('DELETE FROM device_usage_daily WHERE device_id = ?').run(d);
      await cleanupUsers(db, [ID.userX, ID.userB, ID.userA]);
    }
  } finally {
    if (app) await app.stop(); else await db.close();
  }
});

const get = (token, qs = '') =>
  fetch(`${base}/api/dashboard/reports/sla-trend${qs}`, { headers: { Authorization: `Bearer ${token}` } });

test('returns one hand-checked point per day with data, oldest first', async () => {
  const res = await get(tokA, '?days=7');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, [
    { day: D3, avg_uptime_pct: 50 },
    { day: D2, avg_uptime_pct: 75 },
    { day: D1, avg_uptime_pct: 10 },
    { day: D0, avg_uptime_pct: 95 },
  ]);
});

test('the line is not flat — real day-to-day movement', async () => {
  const body = await (await get(tokA, '?days=7')).json();
  const pcts = body.map((p) => p.avg_uptime_pct);
  assert.ok(Math.max(...pcts) - Math.min(...pcts) >= 50, 'range spans 10% -> 95%');
});

test('workspace-scoped: WS A never sees WS B usage (its full-day b1 row)', async () => {
  const body = await (await get(tokA, '?days=7')).json();
  const d1 = body.find((p) => p.day === D1);
  assert.equal(d1.avg_uptime_pct, 10, 'still 10 — b1 (100%) is not averaged in');

  const bodyB = await (await get(tokB, '?days=7')).json();
  assert.deepEqual(bodyB, [{ day: D1, avg_uptime_pct: 100 }]);
});

test('days param clamps and defaults', async () => {
  // days=1 -> only today's point
  assert.deepEqual(await (await get(tokA, '?days=1')).json(), [{ day: D0, avg_uptime_pct: 95 }]);
  // absurd values fall back / clamp, still 200 with the 4 seeded points
  assert.equal((await (await get(tokA, '?days=abc')).json()).length, 4);
  assert.equal((await (await get(tokA, '?days=99999')).json()).length, 4);
  assert.equal((await (await get(tokA, '?days=0')).json()).length, 4);
});

test('no workspace context -> empty array, not an error', async () => {
  // a valid user with no workspace membership at all
  await db.prepare("INSERT INTO users (id, email, role, password_hash, auth_provider) VALUES (?, ?, 'user', NULL, 'local')").run(ID.userX, `${P}-x@t.test`);
  const tok = generateToken({ id: ID.userX, email: `${P}-x@t.test`, role: 'user' }, null);
  const res = await get(tok, '?days=7');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), []);
});
