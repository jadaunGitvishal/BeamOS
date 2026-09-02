'use strict';

// Phase 3 Stage B — GET /api/organizations/:orgId/regions/sla-overview
//
// In-memory sqlite + the real organizations router (requireAuth only). Seeds a
// multi-region org with hand-picked device_usage_daily so every rolled-up number
// is checkable by hand, then confirms a single-workspace member sees a rollup
// covering ONLY their workspace — no other region's data leaking into the aggregate.

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

process.env.JWT_SECRET = 'test-secret-regions-sla';

const db = new Database(':memory:');
db.function('UNIX_TIMESTAMP', () => Math.floor(Date.now() / 1000));
db.exec(`
  CREATE TABLE users (
    id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT DEFAULT '',
    password_hash TEXT, auth_provider TEXT NOT NULL DEFAULT 'local', avatar_url TEXT,
    role TEXT NOT NULL DEFAULT 'user', plan_id TEXT DEFAULT 'free', email_alerts INTEGER DEFAULT 1,
    must_change_password INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_user_id TEXT NOT NULL);
  CREATE TABLE organization_members (id INTEGER PRIMARY KEY AUTOINCREMENT, organization_id TEXT, user_id TEXT, role TEXT);
  CREATE TABLE workspaces (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, name TEXT NOT NULL, region_id TEXT);
  CREATE TABLE workspace_members (id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT, user_id TEXT, role TEXT);
  CREATE TABLE regions (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, name TEXT NOT NULL);
  CREATE TABLE devices (id TEXT PRIMARY KEY, workspace_id TEXT, name TEXT DEFAULT '', status TEXT DEFAULT 'offline');
  CREATE TABLE device_usage_daily (device_id TEXT NOT NULL, day TEXT NOT NULL, online_seconds INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (device_id, day));
  CREATE TABLE activity_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, device_id TEXT, action TEXT, details TEXT, ip_address TEXT, workspace_id TEXT, created_at INTEGER DEFAULT 0);
`);

const dbModulePath = require.resolve('../db/database');
require.cache[dbModulePath] = { id: dbModulePath, filename: dbModulePath, loaded: true, exports: { db } };

const express = require('express');
const { generateToken, requireAuth } = require('../middleware/auth');

// --- fixtures --------------------------------------------------------
const u = (id, role = 'user') => db.prepare("INSERT INTO users (id,email,role) VALUES (?, ?, ?)").run(id, id + '@t.test', role);
u('u-owner-a'); u('u-member-n1'); u('u-outsider-b'); u('u-plat', 'platform_admin');

db.prepare("INSERT INTO organizations (id,name,owner_user_id) VALUES ('org-a','Org A','u-owner-a')").run();
db.prepare("INSERT INTO organizations (id,name,owner_user_id) VALUES ('org-b','Org B','u-outsider-b')").run();
db.prepare("INSERT INTO organization_members (organization_id,user_id,role) VALUES ('org-a','u-owner-a','org_owner')").run();
db.prepare("INSERT INTO organization_members (organization_id,user_id,role) VALUES ('org-b','u-outsider-b','org_owner')").run();

db.prepare("INSERT INTO regions (id,organization_id,name) VALUES ('r-north','org-a','North')").run();
db.prepare("INSERT INTO regions (id,organization_id,name) VALUES ('r-south','org-a','South')").run();
db.prepare("INSERT INTO regions (id,organization_id,name) VALUES ('r-east','org-a','East')").run(); // no workspaces -> omitted

const ws = (id, org, region) => db.prepare("INSERT INTO workspaces (id,organization_id,name,region_id) VALUES (?, ?, ?, ?)").run(id, org, id, region);
ws('ws-n1', 'org-a', 'r-north');
ws('ws-n2', 'org-a', 'r-north');
ws('ws-s1', 'org-a', 'r-south');
ws('ws-u1', 'org-a', null); // Unassigned bucket
ws('ws-b1', 'org-b', null);

db.prepare("INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ('ws-n1','u-member-n1','workspace_viewer')").run();
db.prepare("INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ('ws-b1','u-outsider-b','workspace_admin')").run();

const dev = (id, wsId) => db.prepare("INSERT INTO devices (id,workspace_id) VALUES (?, ?)").run(id, wsId);
dev('d-n1a', 'ws-n1'); dev('d-n1b', 'ws-n1');
dev('d-n2a', 'ws-n2'); dev('d-n2b', 'ws-n2'); // d-n2b: NO usage data
dev('d-s1a', 'ws-s1'); dev('d-s1b', 'ws-s1');
dev('d-u1a', 'ws-u1');
dev('d-b1a', 'ws-b1'); // org-b, must never appear

// 3 seeded days; each device holds the same online_seconds every day so its
// avg_availability_pct == the target % exactly.
const dayStr = (agoDays) => new Date(Date.now() - agoDays * 86400000).toISOString().slice(0, 10);
const DAYS = [dayStr(0), dayStr(1), dayStr(2)];
const usage = (device, pct) => {
  const sec = Math.round((pct / 100) * 86400);
  for (const day of DAYS) db.prepare("INSERT INTO device_usage_daily (device_id,day,online_seconds) VALUES (?, ?, ?)").run(device, day, sec);
};
usage('d-n1a', 99.5);
usage('d-n1b', 99.2);
usage('d-n2a', 99.4);
// d-n2b: none
usage('d-s1a', 80.0);
usage('d-s1b', 60.0);
usage('d-u1a', 100.0);
usage('d-b1a', 100.0); // org-b — leak canary

const start = dayStr(3), end = dayStr(0);
const app = express();
app.use(express.json());
app.use('/api/organizations', requireAuth, require('../routes/organizations'));
app.use((err, req, res, _next) => { res.status(500).json({ error: err.message, stack: err.stack }); });
const server = app.listen(0);
let base;
test.before(async () => {
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); db.close(); });

const tok = (id) => generateToken(db.prepare('SELECT id,email,role FROM users WHERE id = ?').get(id), null);
const get = (orgId, token) =>
  fetch(`${base}/api/organizations/${orgId}/regions/sla-overview?start=${start}&end=${end}`, { headers: { Authorization: `Bearer ${token}` } });
const byName = (regions) => Object.fromEntries(regions.map((r) => [r.region_name, r]));

test('org_owner: hand-checked rollup for every region + Unassigned; empty region omitted', async () => {
  const res = await get('org-a', tok('u-owner-a'));
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
    region_id: 'r-north', region_name: 'North',
    workspace_count: 2, device_count: 4, devices_with_data: 3,
    avg_uptime_pct: 99.4, sla_status: 'compliant',
  });
  // South: 1 ws, 2 devices, mean(80, 60) = 70.0 -> breach
  assert.deepEqual(r.South, {
    region_id: 'r-south', region_name: 'South',
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
  const body = await (await get('org-a', tok('u-plat'))).json();
  assert.deepEqual(byName(body.regions).North.avg_uptime_pct, 99.4);
  assert.equal(body.regions.length, 3);
});

test('RBAC: a member of ONE workspace sees only that workspace — no other region leaks in', async () => {
  const res = await get('org-a', tok('u-member-n1'));
  assert.equal(res.status, 200);
  const body = await res.json();
  // only North, and only ws-n1's slice of it
  assert.equal(body.regions.length, 1);
  assert.deepEqual(body.regions[0], {
    region_id: 'r-north', region_name: 'North',
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
  assert.equal((await get('org-a', tok('u-outsider-b'))).status, 403);
  assert.equal((await get('org-missing', tok('u-plat'))).status, 404);
});