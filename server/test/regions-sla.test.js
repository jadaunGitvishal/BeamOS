'use strict';

// Phase 3 Stage B — GET /api/organizations/:orgId/regions/sla-overview
//
// The REAL organizations router in-process (helpers/inprocess-app.js, requireAuth
// only) against the REAL MySQL test DB (beamos_test via npm test). Seeds a
// multi-region org with hand-picked device_usage_daily so every rolled-up number
// is checkable by hand, then confirms a single-workspace member sees a rollup
// covering ONLY their workspace — no other region's data leaking into the aggregate.
//
// Fixtures are test-owned (rs- prefix, generated ids) and removed afterwards;
// device_usage_daily has no FK, so its rows are deleted by device id.

const test = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const { generateToken } = require('../middleware/auth');
const { startInProcessApp } = require('./helpers/inprocess-app');
const { randTag, cleanupUsers } = require('./helpers/disposable');

// The RBAC test asserts that the member's response never contains "70" (South's
// average); the generated ids appear in that response, so they must not contain it.
let tag = randTag();
while (tag.includes('70')) tag = randTag();
const P = `rs-${tag}`;
const id = (name) => `${P}-${name}`;
let app;
const userIds = [];
const deviceIds = [];
const T = {};

// 3 seeded days; each device holds the same online_seconds every day so its
// avg_availability_pct == the target % exactly.
const dayStr = (agoDays) => new Date(Date.now() - agoDays * 86400000).toISOString().slice(0, 10);
const DAYS = [dayStr(0), dayStr(1), dayStr(2)];
const start = dayStr(3), end = dayStr(0);

test.before(async () => {
  app = await startInProcessApp({ only: ['/api/organizations'] });
  const run = (sql, ...p) => app.db.prepare(sql).run(...p);

  const u = async (key, role = 'user') => {
    const uid = id(key);
    await run("INSERT INTO users (id, email, name, password_hash, auth_provider, role) VALUES (?, ?, ?, NULL, 'local', ?)", uid, `${uid}@t.test`, uid, role);
    userIds.push(uid);
    T[key] = generateToken({ id: uid, email: `${uid}@t.test`, role }, null);
  };
  await u('owner-a'); await u('member-n1'); await u('outsider-b'); await u('plat', 'platform_admin');

  const org = "INSERT INTO organizations (id, name, owner_user_id, plan_id, subscription_status) VALUES (?, ?, ?, 'enterprise', 'active')";
  await run(org, id('org-a'), `${P} Org A`, id('owner-a'));
  await run(org, id('org-b'), `${P} Org B`, id('outsider-b'));
  await run("INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'org_owner')", id('org-a'), id('owner-a'));
  await run("INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'org_owner')", id('org-b'), id('outsider-b'));

  const region = 'INSERT INTO regions (id, organization_id, name) VALUES (?, ?, ?)';
  await run(region, id('r-north'), id('org-a'), 'North');
  await run(region, id('r-south'), id('org-a'), 'South');
  await run(region, id('r-east'), id('org-a'), 'East'); // no workspaces -> omitted

  const ws = (w, org, reg) => run('INSERT INTO workspaces (id, organization_id, name, region_id) VALUES (?, ?, ?, ?)', id(w), id(org), id(w), reg ? id(reg) : null);
  await ws('ws-n1', 'org-a', 'r-north');
  await ws('ws-n2', 'org-a', 'r-north');
  await ws('ws-s1', 'org-a', 'r-south');
  await ws('ws-u1', 'org-a', null); // Unassigned bucket
  await ws('ws-b1', 'org-b', null);

  await run("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_viewer')", id('ws-n1'), id('member-n1'));
  await run("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin')", id('ws-b1'), id('outsider-b'));

  const dev = async (d, w) => { await run('INSERT INTO devices (id, workspace_id) VALUES (?, ?)', id(d), id(w)); deviceIds.push(id(d)); };
  await dev('d-n1a', 'ws-n1'); await dev('d-n1b', 'ws-n1');
  await dev('d-n2a', 'ws-n2'); await dev('d-n2b', 'ws-n2'); // d-n2b: NO usage data
  await dev('d-s1a', 'ws-s1'); await dev('d-s1b', 'ws-s1');
  await dev('d-u1a', 'ws-u1');
  await dev('d-b1a', 'ws-b1'); // org-b, must never appear

  const usage = async (d, pct) => {
    const sec = Math.round((pct / 100) * 86400);
    for (const day of DAYS) await run('INSERT INTO device_usage_daily (device_id, day, online_seconds) VALUES (?, ?, ?)', id(d), day, sec);
  };
  await usage('d-n1a', 99.5);
  await usage('d-n1b', 99.2);
  await usage('d-n2a', 99.4);
  // d-n2b: none
  await usage('d-s1a', 80.0);
  await usage('d-s1b', 60.0);
  await usage('d-u1a', 100.0);
  await usage('d-b1a', 100.0); // org-b — leak canary
});

test.after(async () => {
  try {
    if (app) {
      await app.db.prepare(`DELETE FROM device_usage_daily WHERE device_id IN (${deviceIds.map(() => '?').join(',')})`).run(...deviceIds);
      await cleanupUsers(app.db, [...userIds].reverse());
    }
  } finally {
    if (app) await app.stop(); else await db.close();
  }
});

const get = (orgId, token) =>
  fetch(`${app.base}/api/organizations/${orgId}/regions/sla-overview?start=${start}&end=${end}`, { headers: { Authorization: `Bearer ${token}` } });
const byName = (regions) => Object.fromEntries(regions.map((r) => [r.region_name, r]));

test('org_owner: hand-checked rollup for every region + Unassigned; empty region omitted', async () => {
  const res = await get(id('org-a'), T['owner-a']);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.target.uptime_target_pct, 99);
  assert.deepEqual(body.period, { start, end });

  const r = byName(body.regions);
  assert.deepEqual(Object.keys(r).sort(), ['North', 'South', 'Unassigned']); // no "East"
  assert.equal(body.regions.at(-1).region_name, 'Unassigned'); // Unassigned sorted last

  // North: 2 ws, 4 devices (d-n2b has no usage), 3 with data,
  //        mean(99.5, 99.2, 99.4) = 99.366… -> 99.4 -> compliant (>= 99)
  assert.deepEqual(r.North, {
    region_id: id('r-north'), region_name: 'North',
    workspace_count: 2, device_count: 4, devices_with_data: 3,
    avg_uptime_pct: 99.4, sla_status: 'compliant',
  });
  // South: 1 ws, 2 devices, mean(80, 60) = 70.0 -> breach
  assert.deepEqual(r.South, {
    region_id: id('r-south'), region_name: 'South',
    workspace_count: 1, device_count: 2, devices_with_data: 2,
    avg_uptime_pct: 70, sla_status: 'breach',
  });
  // Unassigned: 1 ws, 1 device @ 100 -> compliant
  assert.deepEqual(r.Unassigned, {
    region_id: null, region_name: 'Unassigned',
    workspace_count: 1, device_count: 1, devices_with_data: 1,
    avg_uptime_pct: 100, sla_status: 'compliant',
  });
});

test('platform_admin sees the same full rollup', async () => {
  const body = await (await get(id('org-a'), T.plat)).json();
  assert.deepEqual(byName(body.regions).North.avg_uptime_pct, 99.4);
  assert.equal(body.regions.length, 3);
});

test('RBAC: a member of ONE workspace sees only that workspace — no other region leaks in', async () => {
  const res = await get(id('org-a'), T['member-n1']);
  assert.equal(res.status, 200);
  const body = await res.json();
  // only North, and only ws-n1's slice of it
  assert.equal(body.regions.length, 1);
  assert.deepEqual(body.regions[0], {
    region_id: id('r-north'), region_name: 'North',
    workspace_count: 1, // ws-n1 only, not ws-n2
    device_count: 2, // d-n1a, d-n1b only
    devices_with_data: 2,
    avg_uptime_pct: 99.4, // mean(99.5, 99.2) = 99.35 -> 99.4
    sla_status: 'compliant',
  });
  // hard proof South / Unassigned / org-b numbers are absent
  assert.ok(!JSON.stringify(body).includes('South'));
  assert.ok(!JSON.stringify(body).includes('Unassigned'));
  assert.ok(!JSON.stringify(body).includes('70'));
});

test('RBAC: no accessible workspace in the org -> 403; unknown org -> 404', async () => {
  assert.equal((await get(id('org-a'), T['outsider-b'])).status, 403);
  assert.equal((await get(id('org-missing'), T.plat)).status, 404);
});
