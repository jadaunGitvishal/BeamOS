'use strict';

// Ref 51 (SLA Dashboard, Stage 1) — verification for
// GET /api/dashboard/reports/sla-overview.
//
// Same harness as dashboard-content-export.test.js: the REAL requireAuth +
// resolveTenancy chain and router (helpers/inprocess-app.js) against the REAL MySQL test
// DB (beamos_test via npm test). Fixtures are test-owned (slo- prefix, generated ids);
// device_status_log, device_usage_daily and outage_history have no FK to devices, so this
// file deletes its own rows by device id; the rest goes with the users. app_settings: the
// schema seeds the two SLA keys with the config defaults (99.0 / 4); the override test
// writes its own values and restores the seeded rows exactly (value + updated_at).
//
// The data below is hand-constructed so every output number can be checked by
// hand (see the comment on each device). It exercises each edge case the spec
// calls out:
//   dev1 - two clean completed outages -> MTTR = mean of the two
//   dev2 - one ongoing outage past the escalation threshold -> live breach
//   dev3 - log starts with an 'online' row (device was already offline before
//          the window) -> NO phantom outage; plus a short ongoing outage that
//          is under the threshold -> ongoing, but NOT a live breach
//   dev4 - 'offline' then 'offline_timeout' then 'online' -> ONE completed
//          outage, not two
//   dev-b - lives in another workspace, must never appear for workspace A

const test = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const { generateToken } = require('../middleware/auth');
const appSettings = require('../lib/app-settings');
const { runOutageHistory } = require('../services/outage-history');
const { startInProcessApp } = require('./helpers/inprocess-app');
const { randTag, cleanupUsers } = require('./helpers/disposable');

const P = `slo-${randTag()}`;
const id = (name) => `${P}-${name}`;
const DEV = (name) => id(name);
const ID = { userA: id('user-a'), userB: id('user-b'), orgA: id('org-a'), orgB: id('org-b'), wsA: id('ws-a'), wsB: id('ws-b') };
const devices = [];

const H = 3600;
const now = Math.floor(Date.now() / 1000);

let app;
let tokA;
let tokB;

test.before(async () => {
  app = await startInProcessApp({ only: ['/api/dashboard/reports'] });
  const run = (sql, ...p) => db.prepare(sql).run(...p);

  // --- Two tenants ----------------------------------------------------------
  await run("INSERT INTO users (id, email, role, password_hash, auth_provider) VALUES (?, ?, 'user', NULL, 'local')", ID.userA, `${P}-a@t.test`);
  await run("INSERT INTO users (id, email, role, password_hash, auth_provider) VALUES (?, ?, 'user', NULL, 'local')", ID.userB, `${P}-b@t.test`);
  const org = "INSERT INTO organizations (id, name, owner_user_id, plan_id, subscription_status) VALUES (?, ?, ?, 'enterprise', 'active')";
  await run(org, ID.orgA, `${P} Org A`, ID.userA);
  await run(org, ID.orgB, `${P} Org B`, ID.userB);
  await run('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)', ID.wsA, ID.orgA, 'WS A');
  await run('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)', ID.wsB, ID.orgB, 'WS B');
  await run("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin')", ID.wsA, ID.userA);
  await run("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin')", ID.wsB, ID.userB);

  const dev = (name, ws, label, sort) => {
    devices.push(DEV(name));
    return run('INSERT INTO devices (id, workspace_id, name, sort_order, created_at) VALUES (?, ?, ?, ?, 0)', DEV(name), ws, label, sort);
  };
  await dev('dev1', ID.wsA, 'Lobby', 1);
  await dev('dev2', ID.wsA, 'Cafeteria', 2);
  await dev('dev3', ID.wsA, 'Reception', 3);
  await dev('dev4', ID.wsA, 'Boardroom', 4);
  await dev('dev-b', ID.wsB, 'Other-Tenant Screen', 1);

  const log = (name, status, ago) =>
    run('INSERT INTO device_status_log (device_id, status, timestamp) VALUES (?, ?, ?)', DEV(name), status, now - ago);
  const usage = (name, dayOffset, seconds) =>
    run('INSERT INTO device_usage_daily (device_id, day, online_seconds) VALUES (?, ?, ?)',
      DEV(name), new Date((now - dayOffset * 86400) * 1000).toISOString().slice(0, 10), seconds);

  // NOTE (Stage 2): completed-outage MTTR is now read from outage_history, which
  // this hook populates by running the real recorder once over this same
  // device_status_log data. Ongoing / live-breach detection still reads the log
  // live. The hand-checked numbers below are unchanged by that move.

  // dev1: outage A = 10h..9h ago (3600s); outage B = 5h..4.5h ago (1800s).
  //       MTTR = (3600 + 1800) / 2 = 2700s. completed_outages = 2.
  //       usage: 2 days @ 85968s -> 85968/86400*100 = 99.5% -> compliant (>= 99.0)
  await log('dev1', 'offline', 10 * H);
  await log('dev1', 'online', 9 * H);
  await log('dev1', 'offline', 5 * H);
  await log('dev1', 'online', Math.round(4.5 * H));
  await usage('dev1', 1, 85968);
  await usage('dev1', 2, 85968);

  // dev2: online 20h ago, offline 6h ago, never recovered.
  //       ongoing_outage_seconds ~= 6h = 21600s > threshold 4h (14400s) -> live breach.
  //       completed_outages = 0, mttr = null.
  //       usage: 3 days @ 69120s -> 69120/86400*100 = 80.0% -> breach (< 99.0)
  await log('dev2', 'online', 20 * H);
  await log('dev2', 'offline', 6 * H);
  await usage('dev2', 1, 69120);
  await usage('dev2', 2, 69120);
  await usage('dev2', 3, 69120);

  // dev3: FIRST row is 'online' 8h ago (device was already offline before the
  //       window opened) -> must NOT invent a phantom outage.
  //       Then 'offline' 2h ago, never recovered -> ongoing_outage_seconds ~= 7200s,
  //       which is UNDER the 14400s threshold -> ongoing but NOT a live breach.
  //       completed_outages = 0, mttr = null.
  //       No usage rows -> availability_pct null -> sla_status 'unknown'.
  await log('dev3', 'online', 8 * H);
  await log('dev3', 'offline', 2 * H);

  // dev4: 'offline' 12h ago, 'offline_timeout' 11.5h ago (same outage, escalated by
  //       the heartbeat checker), 'online' 11h ago. Must collapse to ONE completed
  //       outage of 12h-11h = 3600s, NOT two.
  //       usage: 1 day @ 85536s -> 85536/86400*100 = 99.0% -> compliant (boundary, >=)
  await log('dev4', 'offline', 12 * H);
  await log('dev4', 'offline_timeout', Math.round(11.5 * H));
  await log('dev4', 'online', 11 * H);
  await usage('dev4', 1, 85536);

  // dev-b: outage + usage in the OTHER workspace. Must never surface for WS A.
  await log('dev-b', 'offline', 9 * H);
  await log('dev-b', 'online', 8 * H);
  await usage('dev-b', 1, 1000);

  tokA = generateToken({ id: ID.userA, email: `${P}-a@t.test`, role: 'user' }, ID.wsA);
  tokB = generateToken({ id: ID.userB, email: `${P}-b@t.test`, role: 'user' }, ID.wsB);

  // Populate outage_history from the seeded status log, exactly as the scheduled
  // service does in production.
  await runOutageHistory(db);
});

test.after(async () => {
  try {
    if (app) {
      // No FK to devices on these tables: delete this file's rows explicitly.
      for (const d of devices) {
        await db.prepare('DELETE FROM device_status_log WHERE device_id = ?').run(d);
        await db.prepare('DELETE FROM device_usage_daily WHERE device_id = ?').run(d);
        await db.prepare('DELETE FROM outage_history WHERE device_id = ?').run(d);
      }
      await cleanupUsers(db, [ID.userB, ID.userA]);
    }
  } finally {
    if (app) await app.stop(); else await db.close();
  }
});

const get = (token) =>
  fetch(`${app.base}/api/dashboard/reports/sla-overview`, { headers: { Authorization: `Bearer ${token}` } });
const byId = (devices) => Object.fromEntries(devices.map((d) => [d.device_id, d]));

test('defaults: target comes from config when app_settings is empty', async () => {
  const res = await get(tokA);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.target, { uptime_target_pct: 99.0, escalation_threshold_hours: 4 });
});

test('dev1: MTTR is the mean of the two completed outages (2700s), 2 outages', async () => {
  const d = byId((await (await get(tokA)).json()).devices)[DEV('dev1')];
  assert.equal(d.completed_outages, 2);
  assert.equal(d.mttr_seconds, 2700);
  assert.equal(d.ongoing_outage_seconds, null);
  assert.equal(d.live_breach, false);
  assert.equal(d.availability_pct, 99.5);
  assert.equal(d.sla_status, 'compliant');
});

test('dev2: ongoing outage over threshold is a live breach; uptime under target is a breach', async () => {
  const d = byId((await (await get(tokA)).json()).devices)[DEV('dev2')];
  assert.equal(d.completed_outages, 0);
  assert.equal(d.mttr_seconds, null);
  // ~6h ago; allow a few seconds of test runtime slack.
  assert.ok(Math.abs(d.ongoing_outage_seconds - 6 * H) <= 60, `got ${d.ongoing_outage_seconds}`);
  assert.equal(d.live_breach, true);
  assert.equal(d.availability_pct, 80.0);
  assert.equal(d.sla_status, 'breach');
});

test('dev3: no phantom outage from a leading online row; short ongoing outage is not a live breach', async () => {
  const d = byId((await (await get(tokA)).json()).devices)[DEV('dev3')];
  assert.equal(d.completed_outages, 0, 'leading online row must not create a completed outage');
  assert.equal(d.mttr_seconds, null);
  assert.ok(Math.abs(d.ongoing_outage_seconds - 2 * H) <= 60, `got ${d.ongoing_outage_seconds}`);
  assert.equal(d.live_breach, false, '2h < 4h threshold');
  assert.equal(d.availability_pct, null);
  assert.equal(d.sla_status, 'unknown');
});

test('dev4: offline + offline_timeout + online collapses to ONE 3600s outage', async () => {
  const d = byId((await (await get(tokA)).json()).devices)[DEV('dev4')];
  assert.equal(d.completed_outages, 1);
  assert.equal(d.mttr_seconds, 3600);
  assert.equal(d.ongoing_outage_seconds, null);
  assert.equal(d.availability_pct, 99.0);
  assert.equal(d.sla_status, 'compliant', '99.0 >= 99.0 target boundary');
});

test('summary tallies match the per-device rows', async () => {
  const body = await (await get(tokA)).json();
  assert.deepEqual(body.summary, {
    devices_total: 4,
    devices_compliant: 2,
    devices_breach: 1,
    devices_unknown: 1,
    live_breaches: 1,
  });
});

test('workspace isolation: WS A never sees the other tenant device', async () => {
  const bodyA = await (await get(tokA)).json();
  assert.ok(!bodyA.devices.some((d) => d.device_id === DEV('dev-b')));
  const bodyB = await (await get(tokB)).json();
  assert.deepEqual(bodyB.devices.map((d) => d.device_id), [DEV('dev-b')]);
});

test('app_settings override: lowering the threshold to 1h makes dev3 a live breach', async () => {
  // Save the two keys exactly (the schema seeds them), override, restore in finally.
  const KEYS = ['sla_escalation_threshold_hours', 'sla_uptime_target_pct'];
  const saved = await db.prepare(`SELECT \`key\`, value, updated_at FROM app_settings WHERE \`key\` IN (?, ?)`).all(...KEYS);
  const put = (k, v) => db.prepare('INSERT INTO app_settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)').run(k, v);
  await put('sla_escalation_threshold_hours', '1');
  await put('sla_uptime_target_pct', '95');
  await appSettings.__reload();
  try {
    const body = await (await get(tokA)).json();
    assert.deepEqual(body.target, { uptime_target_pct: 95, escalation_threshold_hours: 1 });
    const d = byId(body.devices);
    assert.equal(d[DEV('dev3')].live_breach, true, '2h > 1h threshold now');
    assert.equal(d[DEV('dev2')].live_breach, true);
    assert.equal(body.summary.live_breaches, 2);
    // dev2 at 80% is still a breach vs the lowered 95% target; dev1/dev4 still compliant.
    assert.equal(d[DEV('dev2')].sla_status, 'breach');
    assert.equal(d[DEV('dev1')].sla_status, 'compliant');
  } finally {
    await db.prepare('DELETE FROM app_settings WHERE `key` IN (?, ?)').run(...KEYS);
    for (const r of saved) {
      await db.prepare('INSERT INTO app_settings (`key`, value, updated_at) VALUES (?, ?, ?)').run(r.key, r.value, r.updated_at);
    }
    await appSettings.__reload();
  }
});
