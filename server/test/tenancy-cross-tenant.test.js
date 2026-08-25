'use strict';

// Regression test for the missing-`await` bug on accessContext() (server/lib/tenancy.js):
// `const ctx = ws && accessContext(...)` without `await` leaves ctx as a pending Promise,
// which is always truthy, so the "!ctx -> 403" gate silently never fires and any
// authenticated user could read/write ANY other tenant's resources. Fixed at 10 call sites
// across assignments.js, layouts.js, playlists.js, schedules.js, video-walls.js.
//
// This test drives the REAL Express app (real requireAuth + resolveTenancy + route files,
// mounted exactly as server.js does) against a real HTTP request, so it exercises the actual
// buggy line inside each route handler - not just accessContext() in isolation. It directly
// covers 5 of the 10 fixed call sites (one representative route per resource type):
//   playlists.js:47, layouts.js:49, schedules.js:43, video-walls.js:19, assignments.js:41
// The other 5 (assignments.js:156, layouts.js:69/275, playlists.js:189, video-walls.js:106)
// share the exact same one-line pattern and fix, but aren't separately exercised here.

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

process.env.JWT_SECRET = 'test-secret-tenancy-cross-tenant';

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
    id TEXT PRIMARY KEY, workspace_id TEXT, name TEXT DEFAULT '', playlist_id TEXT,
    status TEXT DEFAULT 'offline'
  );
  CREATE TABLE device_groups (
    id TEXT PRIMARY KEY, workspace_id TEXT, name TEXT DEFAULT ''
  );
  CREATE TABLE playlists (
    id TEXT PRIMARY KEY, user_id TEXT, workspace_id TEXT, name TEXT NOT NULL,
    description TEXT DEFAULT '', status TEXT DEFAULT 'draft', published_snapshot TEXT
  );
  CREATE TABLE playlist_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, playlist_id TEXT, content_id TEXT, widget_id TEXT,
    zone_id TEXT, sort_order INTEGER DEFAULT 0, duration_sec INTEGER DEFAULT 10, muted INTEGER DEFAULT 0
  );
  CREATE TABLE content (
    id TEXT PRIMARY KEY, filename TEXT, mime_type TEXT, filepath TEXT, thumbnail_path TEXT,
    duration_sec REAL, file_size INTEGER, remote_url TEXT
  );
  CREATE TABLE widgets (
    id TEXT PRIMARY KEY, name TEXT, widget_type TEXT, config TEXT
  );
  CREATE TABLE layouts (
    id TEXT PRIMARY KEY, user_id TEXT, workspace_id TEXT, name TEXT NOT NULL,
    width INTEGER DEFAULT 1920, height INTEGER DEFAULT 1080, is_template INTEGER DEFAULT 0
  );
  CREATE TABLE layout_zones (
    id TEXT PRIMARY KEY, layout_id TEXT, name TEXT DEFAULT 'Zone', sort_order INTEGER DEFAULT 0
  );
  CREATE TABLE schedules (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT, device_id TEXT, group_id TEXT,
    zone_id TEXT, content_id TEXT, widget_id TEXT, layout_id TEXT, playlist_id TEXT,
    title TEXT DEFAULT '', start_time TEXT NOT NULL, end_time TEXT NOT NULL, timezone TEXT DEFAULT 'UTC',
    recurrence TEXT, recurrence_end TEXT, priority INTEGER DEFAULT 0, enabled INTEGER DEFAULT 1,
    color TEXT DEFAULT '#3B82F6'
  );
  CREATE TABLE video_walls (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT, name TEXT NOT NULL,
    grid_cols INTEGER DEFAULT 2, grid_rows INTEGER DEFAULT 2,
    bezel_h_mm REAL DEFAULT 0, bezel_v_mm REAL DEFAULT 0,
    screen_w_mm REAL DEFAULT 400, screen_h_mm REAL DEFAULT 225, sync_mode TEXT DEFAULT 'leader'
  );
  CREATE TABLE video_wall_devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT, wall_id TEXT, device_id TEXT,
    grid_col INTEGER DEFAULT 0, grid_row INTEGER DEFAULT 0
  );
`);

const dbModulePath = require.resolve('../db/database');
require.cache[dbModulePath] = { id: dbModulePath, filename: dbModulePath, loaded: true, exports: { db } };

const express = require('express');
const { generateToken, requireAuth } = require('../middleware/auth');
const { resolveTenancy } = require('../lib/tenancy');

// --- Seed two tenants ---------------------------------------------------
db.prepare("INSERT INTO users (id, email, role) VALUES ('user-a', 'a@tenant-a.test', 'user')").run();
db.prepare("INSERT INTO users (id, email, role) VALUES ('user-b', 'b@tenant-b.test', 'user')").run();

db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES ('org-a', 'Org A', 'user-a')").run();
db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES ('org-b', 'Org B', 'user-b')").run();

db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES ('ws-a', 'org-a', 'Workspace A')").run();
db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES ('ws-b', 'org-b', 'Workspace B')").run();

db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('ws-a', 'user-a', 'workspace_admin')").run();
db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('ws-b', 'user-b', 'workspace_admin')").run();
// user-b has NO membership, org-admin, or platform role touching ws-a - the cross-tenant case.

db.prepare("INSERT INTO devices (id, workspace_id, name) VALUES ('device-a', 'ws-a', 'Lobby Screen')").run();
db.prepare("INSERT INTO playlists (id, user_id, workspace_id, name) VALUES ('playlist-a', 'user-a', 'ws-a', 'Tenant A Playlist')").run();
db.prepare("INSERT INTO layouts (id, user_id, workspace_id, name) VALUES ('layout-a', 'user-a', 'ws-a', 'Tenant A Layout')").run();
db.prepare(
  "INSERT INTO schedules (id, user_id, workspace_id, device_id, start_time, end_time) VALUES ('schedule-a', 'user-a', 'ws-a', 'device-a', '00:00', '23:59')"
).run();
db.prepare("INSERT INTO video_walls (id, user_id, workspace_id, name) VALUES ('wall-a', 'user-a', 'ws-a', 'Tenant A Wall')").run();

// current_workspace_id pins each token's resolved workspace deterministically.
const tokA = generateToken({ id: 'user-a', email: 'a@tenant-a.test', role: 'user' }, 'ws-a');
const tokB = generateToken({ id: 'user-b', email: 'b@tenant-b.test', role: 'user' }, 'ws-b');

// --- Real app, mounted exactly as server.js mounts these routers --------
const app = express();
app.use(express.json());
for (const [path, mod] of [
  ['/api/playlists', '../routes/playlists'],
  ['/api/layouts', '../routes/layouts'],
  ['/api/schedules', '../routes/schedules'],
  ['/api/video-walls', '../routes/video-walls'],
  ['/api/assignments', '../routes/assignments'],
]) {
  app.use(path, requireAuth, resolveTenancy, require(mod));
}
// Surface handler errors as JSON instead of Express's default HTML page, so a thrown
// error (e.g. a schema mismatch in this test's minimal DB) fails assertions legibly.
app.use((err, req, res, _next) => {
  res.status(500).json({ error: err.message });
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
  return { headers: { Authorization: `Bearer ${token}` } };
}

test('cross-tenant: user-b is denied tenant A playlist (playlists.js:47)', async () => {
  const res = await fetch(`${base}/api/playlists/playlist-a`, authed(tokB));
  assert.equal(res.status, 403);
});

test('cross-tenant: user-b is denied tenant A layout (layouts.js:49)', async () => {
  const res = await fetch(`${base}/api/layouts/layout-a`, authed(tokB));
  assert.equal(res.status, 403);
});

test('cross-tenant: user-b is denied writing tenant A schedule (schedules.js:43)', async () => {
  const res = await fetch(`${base}/api/schedules/schedule-a`, {
    ...authed(tokB),
    method: 'PUT',
    headers: { ...authed(tokB).headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'hijacked' }),
  });
  assert.equal(res.status, 403);
});

test('cross-tenant: user-b is denied tenant A video wall (video-walls.js:19)', async () => {
  const res = await fetch(`${base}/api/video-walls/wall-a`, authed(tokB));
  assert.equal(res.status, 403);
});

test('cross-tenant: user-b is denied tenant A device assignments (assignments.js:41)', async () => {
  const res = await fetch(`${base}/api/assignments/device/device-a`, authed(tokB));
  assert.equal(res.status, 403);
});

test('control: user-a can read their own tenant A playlist (200, proves the test isn\'t just failing everything)', async () => {
  const res = await fetch(`${base}/api/playlists/playlist-a`, authed(tokA));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.id, 'playlist-a');
});
