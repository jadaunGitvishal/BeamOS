'use strict';

// Regression test for the missing-`await` bug on accessContext() (server/lib/tenancy.js):
// `const ctx = ws && accessContext(...)` without `await` leaves ctx as a pending Promise,
// which is always truthy, so the "!ctx -> 403" gate silently never fires and any
// authenticated user could read/write ANY other tenant's resources. Fixed at 10 call sites
// across assignments.js, layouts.js, playlists.js, schedules.js, video-walls.js.
//
// This test drives the REAL routers (real auth front + resolveTenancy + route files, mounted
// exactly as server.js does - helpers/inprocess-app.js, so video-walls is at /api/walls)
// against the REAL MySQL test DB (beamos_test via npm test) over real HTTP requests, so it
// exercises the actual buggy line inside each route handler - not just accessContext() in
// isolation. Fixtures are test-owned (tct- prefix, generated ids); deleting the two users
// cascades their orgs, workspaces and every tenant-A resource. It directly
// covers 5 of the 10 fixed call sites (one representative route per resource type):
//   playlists.js:47, layouts.js:49, schedules.js:43, video-walls.js:19, assignments.js:41
// The other 5 (assignments.js:156, layouts.js:69/275, playlists.js:189, video-walls.js:106)
// share the exact same one-line pattern and fix, but aren't separately exercised here.

const test = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const { generateToken } = require('../middleware/auth');
const { startInProcessApp } = require('./helpers/inprocess-app');
const { randTag, cleanupUsers } = require('./helpers/disposable');

const P = `tct-${randTag()}`;
const id = (name) => `${P}-${name}`;
const ID = {
  userA: id('user-a'), userB: id('user-b'), orgA: id('org-a'), orgB: id('org-b'), wsA: id('ws-a'), wsB: id('ws-b'),
  device: id('device-a'), playlist: id('playlist-a'), layout: id('layout-a'), schedule: id('schedule-a'), wall: id('wall-a'),
};

let app;
let base;
let tokA;
let tokB;

test.before(async () => {
  app = await startInProcessApp({ only: ['/api/playlists', '/api/layouts', '/api/schedules', '/api/walls', '/api/assignments'] });
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
  // user-b has NO membership, org-admin, or platform role touching ws-a - the cross-tenant case.

  await run('INSERT INTO devices (id, workspace_id, name) VALUES (?, ?, ?)', ID.device, ID.wsA, 'Lobby Screen');
  await run('INSERT INTO playlists (id, user_id, workspace_id, name) VALUES (?, ?, ?, ?)', ID.playlist, ID.userA, ID.wsA, 'Tenant A Playlist');
  await run('INSERT INTO layouts (id, user_id, workspace_id, name) VALUES (?, ?, ?, ?)', ID.layout, ID.userA, ID.wsA, 'Tenant A Layout');
  await run("INSERT INTO schedules (id, user_id, workspace_id, device_id, start_time, end_time) VALUES (?, ?, ?, ?, '00:00', '23:59')",
    ID.schedule, ID.userA, ID.wsA, ID.device);
  await run('INSERT INTO video_walls (id, user_id, workspace_id, name) VALUES (?, ?, ?, ?)', ID.wall, ID.userA, ID.wsA, 'Tenant A Wall');

  // current_workspace_id pins each token's resolved workspace deterministically.
  tokA = generateToken({ id: ID.userA, email: `${P}-a@tenant-a.test`, role: 'user' }, ID.wsA);
  tokB = generateToken({ id: ID.userB, email: `${P}-b@tenant-b.test`, role: 'user' }, ID.wsB);
});

test.after(async () => {
  try {
    if (app) await cleanupUsers(db, [ID.userB, ID.userA]);
  } finally {
    if (app) await app.stop(); else await db.close();
  }
});

function authed(token) {
  return { headers: { Authorization: `Bearer ${token}` } };
}

test('cross-tenant: user-b is denied tenant A playlist (playlists.js:47)', async () => {
  const res = await fetch(`${base}/api/playlists/${ID.playlist}`, authed(tokB));
  assert.equal(res.status, 403);
});

test('cross-tenant: user-b is denied tenant A layout (layouts.js:49)', async () => {
  const res = await fetch(`${base}/api/layouts/${ID.layout}`, authed(tokB));
  assert.equal(res.status, 403);
});

test('cross-tenant: user-b is denied writing tenant A schedule (schedules.js:43)', async () => {
  const res = await fetch(`${base}/api/schedules/${ID.schedule}`, {
    ...authed(tokB),
    method: 'PUT',
    headers: { ...authed(tokB).headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'hijacked' }),
  });
  assert.equal(res.status, 403);
});

test('cross-tenant: user-b is denied tenant A video wall (video-walls.js:19)', async () => {
  const res = await fetch(`${base}/api/walls/${ID.wall}`, authed(tokB));
  assert.equal(res.status, 403);
});

test('cross-tenant: user-b is denied tenant A device assignments (assignments.js:41)', async () => {
  const res = await fetch(`${base}/api/assignments/device/${ID.device}`, authed(tokB));
  assert.equal(res.status, 403);
});

test('control: user-a can read their own tenant A playlist (200, proves the test isn\'t just failing everything)', async () => {
  const res = await fetch(`${base}/api/playlists/${ID.playlist}`, authed(tokA));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.id, ID.playlist);
});
