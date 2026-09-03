'use strict';

// Phase 5 Stage A — campaigns data model + admin endpoints.
//
// In-memory sqlite + the real workspaces router, mounted as server.js does
// (requireAuth only; per-handler RBAC via canWriteWorkspace / canAccessWorkspace,
// no resolveTenancy). Covers the RBAC matrix, validation (dates, target,
// cross-workspace playlist), the computed draft/live/completed status, that
// DELETE removes only the wrapper (playlist survives), and activity_log rows.

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

process.env.JWT_SECRET = 'test-secret-campaigns';

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
  CREATE TABLE organization_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT, organization_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL
  );
  CREATE TABLE workspaces (
    id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, name TEXT NOT NULL,
    slug TEXT, region_id TEXT, updated_at INTEGER DEFAULT 0
  );
  CREATE TABLE workspace_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL
  );
  CREATE TABLE playlists (
    id TEXT PRIMARY KEY, user_id TEXT, workspace_id TEXT, name TEXT NOT NULL,
    published_snapshot TEXT
  );
  CREATE TABLE devices (id TEXT PRIMARY KEY, workspace_id TEXT);
  CREATE TABLE play_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT, content_id TEXT, started_at INTEGER NOT NULL
  );
  CREATE TABLE campaigns (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, playlist_id TEXT,
    name TEXT NOT NULL, description TEXT, start_date TEXT NOT NULL, end_date TEXT NOT NULL,
    target_plays_per_day INTEGER, created_by TEXT,
    created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, device_id TEXT, action TEXT,
    details TEXT, ip_address TEXT, workspace_id TEXT, created_at INTEGER DEFAULT 0
  );
`);

const dbModulePath = require.resolve('../db/database');
require.cache[dbModulePath] = { id: dbModulePath, filename: dbModulePath, loaded: true, exports: { db } };

const express = require('express');
const { generateToken, requireAuth } = require('../middleware/auth');
const { activityLogger } = require('../services/activity');

// --- fixtures --------------------------------------------------------
db.prepare("INSERT INTO users (id,email,role) VALUES ('u-plat','plat@t.test','platform_admin')").run();
db.prepare("INSERT INTO users (id,email,role) VALUES ('u-orgowner','orgowner@t.test','user')").run();
db.prepare("INSERT INTO users (id,email,role) VALUES ('u-wsadmin','wsadmin@t.test','user')").run();
db.prepare("INSERT INTO users (id,email,role) VALUES ('u-editor','editor@t.test','user')").run();
db.prepare("INSERT INTO users (id,email,role) VALUES ('u-viewer','viewer@t.test','user')").run();
db.prepare("INSERT INTO users (id,email,role) VALUES ('u-other','other@t.test','user')").run();
db.prepare("INSERT INTO users (id,email,role) VALUES ('u-nobody','nobody@t.test','user')").run();

db.prepare("INSERT INTO organizations (id,name,owner_user_id) VALUES ('org-a','Org A','u-orgowner')").run();
db.prepare("INSERT INTO organizations (id,name,owner_user_id) VALUES ('org-b','Org B','u-other')").run();
db.prepare("INSERT INTO organization_members (organization_id,user_id,role) VALUES ('org-a','u-orgowner','org_owner')").run();
db.prepare("INSERT INTO organization_members (organization_id,user_id,role) VALUES ('org-b','u-other','org_owner')").run();

db.prepare("INSERT INTO workspaces (id,organization_id,name) VALUES ('ws-a','org-a','WS A')").run();
db.prepare("INSERT INTO workspaces (id,organization_id,name) VALUES ('ws-b','org-b','WS B')").run();
db.prepare("INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ('ws-a','u-wsadmin','workspace_admin')").run();
db.prepare("INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ('ws-a','u-editor','workspace_editor')").run();
db.prepare("INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ('ws-a','u-viewer','workspace_viewer')").run();
db.prepare("INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ('ws-b','u-other','workspace_admin')").run();

const PL_A_SNAP = JSON.stringify([
  { content_id: 'con-1', widget_id: null, sort_order: 0, filename: '1.mp4' },
  { content_id: 'con-2', widget_id: null, sort_order: 1, filename: '2.mp4' },
  { content_id: null, widget_id: 'wid-x', sort_order: 2 },
]);
db.prepare("INSERT INTO playlists (id,workspace_id,name,published_snapshot) VALUES ('pl-a','ws-a','Summer Reel',?)").run(PL_A_SNAP);
db.prepare("INSERT INTO playlists (id,workspace_id,name) VALUES ('pl-a-draft','ws-a','Unpublished Reel')").run();
db.prepare("INSERT INTO playlists (id,workspace_id,name) VALUES ('pl-b','ws-b','Other WS Playlist')").run();
db.prepare("INSERT INTO playlists (id,workspace_id,name) VALUES ('pl-nows',NULL,'Legacy no-workspace')").run();

db.prepare("INSERT INTO devices (id,workspace_id) VALUES ('dev-a','ws-a')").run();
db.prepare("INSERT INTO devices (id,workspace_id) VALUES ('dev-b','ws-b')").run(); // another workspace, same shared content

const tok = (id) => generateToken(db.prepare('SELECT id,email,role FROM users WHERE id = ?').get(id), null);
const T = {
  plat: tok('u-plat'), orgOwner: tok('u-orgowner'), wsAdmin: tok('u-wsadmin'),
  editor: tok('u-editor'), viewer: tok('u-viewer'), other: tok('u-other'), nobody: tok('u-nobody'),
};

const app = express();
app.use(express.json());
app.use(activityLogger);
app.use('/api/workspaces', requireAuth, require('../routes/workspaces'));
app.use((err, req, res, _next) => { res.status(500).json({ error: err.message, stack: err.stack }); });
const server = app.listen(0);
let base;
test.before(async () => {
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); db.close(); });

const call = (method, path, token, body) =>
  fetch(base + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const camps = (ws) => `/api/workspaces/${ws}/campaigns`;
const auditCount = (action) => db.prepare('SELECT COUNT(*) c FROM activity_log WHERE action = ?').get(action).c;

const TODAY = new Date().toISOString().slice(0, 10);
const plusDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

// -------------------------------------------------------------------

test('editor creates a campaign; defaults + activity_log row', async () => {
  const before = auditCount('campaign_created');
  const r = await call('POST', camps('ws-a'), T.editor, {
    name: 'Q3 Launch', start_date: plusDays(-1), end_date: plusDays(5),
  });
  assert.equal(r.status, 201);
  const c = await r.json();
  assert.equal(c.name, 'Q3 Launch');
  assert.equal(c.workspace_id, 'ws-a');
  assert.equal(c.playlist_id, null);
  assert.equal(c.target_plays_per_day, null);
  assert.equal(c.created_by, 'u-editor');
  assert.equal(c.created_by_email, 'editor@t.test');
  assert.equal(c.status, 'live', 'started yesterday, ends in 5d -> live');
  assert.equal(auditCount('campaign_created'), before + 1);
});

test('create with playlist + all fields; playlist_name resolved', async () => {
  const r = await call('POST', camps('ws-a'), T.wsAdmin, {
    name: 'Holiday Push', description: 'End of year', playlist_id: 'pl-a',
    start_date: plusDays(10), end_date: plusDays(40), target_plays_per_day: 24,
  });
  assert.equal(r.status, 201);
  const c = await r.json();
  assert.equal(c.playlist_id, 'pl-a');
  assert.equal(c.playlist_name, 'Summer Reel');
  assert.equal(c.target_plays_per_day, 24);
  assert.equal(c.description, 'End of year');
  assert.equal(c.status, 'draft', 'starts in 10d -> draft');
});

test('create validation: name, dates, target, playlist', async () => {
  const ok = { name: 'x', start_date: TODAY, end_date: plusDays(3) };
  assert.equal((await call('POST', camps('ws-a'), T.editor, { ...ok, name: '  ' })).status, 400);
  assert.equal((await call('POST', camps('ws-a'), T.editor, { name: 'x' })).status, 400, 'missing dates');
  assert.equal((await call('POST', camps('ws-a'), T.editor, { ...ok, start_date: '2026-13-40' })).status, 400, 'not a real date');
  assert.equal((await call('POST', camps('ws-a'), T.editor, { ...ok, start_date: '06/01/2026' })).status, 400, 'wrong format');
  assert.equal((await call('POST', camps('ws-a'), T.editor, { name: 'x', start_date: plusDays(5), end_date: plusDays(1) })).status, 400, 'end before start');
  assert.equal((await call('POST', camps('ws-a'), T.editor, { ...ok, target_plays_per_day: 0 })).status, 400);
  assert.equal((await call('POST', camps('ws-a'), T.editor, { ...ok, target_plays_per_day: 2.5 })).status, 400);
  assert.equal((await call('POST', camps('ws-a'), T.editor, { ...ok, playlist_id: 'pl-missing' })).status, 404);
  assert.equal((await call('POST', camps('ws-a'), T.editor, { ...ok, playlist_id: 'pl-b' })).status, 400, 'playlist in ws-b');
  assert.equal((await call('POST', camps('ws-a'), T.editor, { ...ok, playlist_id: 'pl-nows' })).status, 400, 'null-workspace playlist rejected too');
  // same-day campaign is allowed
  assert.equal((await call('POST', camps('ws-a'), T.editor, { name: 'oneday', start_date: TODAY, end_date: TODAY })).status, 201);
});

test('RBAC: viewer reads but cannot create/update/delete; non-member + other-org denied', async () => {
  const list = await call('GET', camps('ws-a'), T.viewer);
  assert.equal(list.status, 200);
  const any = (await list.json())[0];

  assert.equal((await call('POST', camps('ws-a'), T.viewer, { name: 'no', start_date: TODAY, end_date: plusDays(1) })).status, 403);
  assert.equal((await call('PATCH', `${camps('ws-a')}/${any.id}`, T.viewer, { name: 'no' })).status, 403);
  assert.equal((await call('DELETE', `${camps('ws-a')}/${any.id}`, T.viewer)).status, 403);

  for (const who of [T.nobody, T.other]) {
    assert.equal((await call('GET', camps('ws-a'), who)).status, 403);
    assert.equal((await call('POST', camps('ws-a'), who, { name: 'x', start_date: TODAY, end_date: plusDays(1) })).status, 403);
  }
  assert.equal((await call('GET', '/api/workspaces/ws-zzz/campaigns', T.plat)).status, 404);
  assert.equal((await call('POST', '/api/workspaces/ws-zzz/campaigns', T.plat, { name: 'x', start_date: TODAY, end_date: plusDays(1) })).status, 404);
});

test('RBAC: org_owner and platform_admin can manage without a workspace_members row', async () => {
  assert.equal((await call('POST', camps('ws-a'), T.orgOwner, { name: 'from org owner', start_date: TODAY, end_date: plusDays(2) })).status, 201);
  assert.equal((await call('POST', camps('ws-a'), T.plat, { name: 'from platform', start_date: TODAY, end_date: plusDays(2) })).status, 201);
});

test('computed status: draft / live / completed by date window', async () => {
  const mk = (name, s, e) => call('POST', camps('ws-a'), T.editor, { name, start_date: s, end_date: e }).then((r) => r.json());
  const past = await mk('past', plusDays(-20), plusDays(-10));
  const now = await mk('now', plusDays(-2), plusDays(2));
  const future = await mk('future', plusDays(10), plusDays(20));
  assert.equal(past.status, 'completed');
  assert.equal(now.status, 'live');
  assert.equal(future.status, 'draft');

  // list ?status= filter
  const live = await (await call('GET', `${camps('ws-a')}?status=live`, T.viewer)).json();
  assert.ok(live.every((c) => c.status === 'live'));
  assert.ok(live.some((c) => c.id === now.id));
  assert.equal((await call('GET', `${camps('ws-a')}?status=bogus`, T.viewer)).status, 400);
});

test('PATCH: fields + date-window revalidation + no-op + 404s', async () => {
  const c = await (await call('POST', camps('ws-a'), T.editor, { name: 'patch me', start_date: plusDays(1), end_date: plusDays(10) })).json();
  const url = `${camps('ws-a')}/${c.id}`;
  const before = auditCount('campaign_updated');

  let u = await (await call('PATCH', url, T.editor, { name: 'patched', target_plays_per_day: 12, playlist_id: 'pl-a' })).json();
  assert.equal(u.name, 'patched');
  assert.equal(u.target_plays_per_day, 12);
  assert.equal(u.playlist_id, 'pl-a');

  // move end before existing start -> 400
  assert.equal((await call('PATCH', url, T.editor, { end_date: plusDays(-5) })).status, 400);
  // move both consistently -> ok
  u = await (await call('PATCH', url, T.editor, { start_date: plusDays(-3), end_date: plusDays(3) })).json();
  assert.equal(u.status, 'live');
  // clear the playlist + target with null
  u = await (await call('PATCH', url, T.editor, { playlist_id: null, target_plays_per_day: null })).json();
  assert.equal(u.playlist_id, null);
  assert.equal(u.target_plays_per_day, null);

  assert.equal((await call('PATCH', url, T.editor, {})).status, 400, 'no fields');
  assert.equal((await call('PATCH', `${camps('ws-a')}/nope`, T.editor, { name: 'x' })).status, 404);
  db.prepare("INSERT INTO campaigns (id,workspace_id,name,start_date,end_date) VALUES ('c-b','ws-b','B camp','2026-01-01','2026-02-01')").run();
  assert.equal((await call('PATCH', `${camps('ws-a')}/c-b`, T.editor, { name: 'x' })).status, 404, 'campaign in ws-b not visible under ws-a');

  assert.equal(auditCount('campaign_updated'), before + 3);
});

test('DELETE removes only the wrapper - the playlist survives; activity_log; 404s', async () => {
  const c = await (await call('POST', camps('ws-a'), T.editor, {
    name: 'doomed', playlist_id: 'pl-a', start_date: TODAY, end_date: plusDays(5),
  })).json();
  const before = auditCount('campaign_deleted');

  const del = await call('DELETE', `${camps('ws-a')}/${c.id}`, T.editor);
  assert.equal(del.status, 200);
  assert.deepEqual(await del.json(), { success: true });

  assert.equal(db.prepare('SELECT COUNT(*) n FROM campaigns WHERE id = ?').get(c.id).n, 0, 'campaign gone');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM playlists WHERE id = 'pl-a'").get().n, 1, 'playlist untouched');
  assert.equal(auditCount('campaign_deleted'), before + 1);

  assert.equal((await call('DELETE', `${camps('ws-a')}/${c.id}`, T.editor)).status, 404, 'already gone');
  assert.equal((await call('DELETE', `${camps('ws-a')}/nope`, T.editor)).status, 404);
});

test('GET detail + 404 for other workspace', async () => {
  const c = await (await call('POST', camps('ws-a'), T.editor, { name: 'detail me', start_date: TODAY, end_date: plusDays(1) })).json();
  const got = await call('GET', `${camps('ws-a')}/${c.id}`, T.viewer);
  assert.equal(got.status, 200);
  assert.equal((await got.json()).name, 'detail me');
  assert.equal((await call('GET', `${camps('ws-b')}/${c.id}`, T.other)).status, 404);
});

// ===================== Phase 5 Stage B — delivery tracking =====================

const epoch = (iso) => Math.floor(Date.parse(iso) / 1000);
const play = (contentId, iso, device = 'dev-a') =>
  db.prepare('INSERT INTO play_logs (device_id, content_id, started_at) VALUES (?, ?, ?)').run(device, contentId, epoch(iso));

test('delivery fields: hand-checked against seeded play_logs, wrong content excluded', async () => {
  // campaign over pl-a (con-1 / con-2), a 10-day window ending 5 days out,
  // target 10/day. Back-date so "today" sits mid-flight (day 3).
  const c = await (await call('POST', camps('ws-a'), T.editor, {
    name: 'delivery', playlist_id: 'pl-a', start_date: plusDays(-2), end_date: plusDays(7), target_plays_per_day: 10,
  })).json();

  const s = plusDays(-2);
  play('con-1', s + 'T09:00:00Z');   // day 1
  play('con-2', s + 'T18:00:00Z');   // day 1
  play('con-1', plusDays(-1) + 'T10:00:00Z'); // day 2
  play('con-1', TODAY + 'T08:00:00Z');        // day 3 (today)
  play('con-2', TODAY + 'T09:00:00Z');        // day 3
  play('con-9', TODAY + 'T09:00:00Z');        // WRONG content -> excluded
  play('con-1', plusDays(3) + 'T09:00:00Z');  // AFTER today -> excluded
  play('con-1', plusDays(-5) + 'T09:00:00Z'); // BEFORE start -> excluded

  const got = await (await call('GET', `${camps('ws-a')}/${c.id}`, T.viewer)).json();
  assert.equal(got.actual_plays, 5, 'only the 5 in-window pl-a plays');
  assert.equal(got.delivery_days_elapsed, 3, 'day 1..today inclusive');
  assert.equal(got.expected_plays, 30, '10/day * 3 days');
  assert.equal(got.delivery_pct, Math.round((5 / 30) * 1000) / 10);

  // same numbers via the list endpoint
  const inList = (await (await call('GET', camps('ws-a'), T.viewer)).json()).find((x) => x.id === c.id);
  assert.equal(inList.actual_plays, 5);
  assert.equal(inList.expected_plays, 30);

  // a play of the SAME content, in-window, but on a device in ANOTHER workspace
  // (shared/template content reused elsewhere) must NOT be credited here.
  play('con-1', TODAY + 'T10:00:00Z', 'dev-b');
  play('con-2', TODAY + 'T11:00:00Z', 'dev-b');
  const after = await (await call('GET', `${camps('ws-a')}/${c.id}`, T.viewer)).json();
  assert.equal(after.actual_plays, 5, "another workspace's plays of the same content are excluded");
});

test('delivery: null target -> actual_plays computed, expected/pct null', async () => {
  const c = await (await call('POST', camps('ws-a'), T.editor, {
    name: 'no target', playlist_id: 'pl-a', start_date: plusDays(-1), end_date: plusDays(5),
  })).json();
  play('con-1', TODAY + 'T07:00:00Z');
  const got = await (await call('GET', `${camps('ws-a')}/${c.id}`, T.viewer)).json();
  assert.equal(typeof got.actual_plays, 'number');
  assert.equal(got.expected_plays, null);
  assert.equal(got.delivery_pct, null);
  assert.ok(got.delivery_days_elapsed >= 1);
});

test('delivery: null playlist -> every delivery field null, no error', async () => {
  const c = await (await call('POST', camps('ws-a'), T.editor, {
    name: 'no playlist', start_date: plusDays(-1), end_date: plusDays(5), target_plays_per_day: 10,
  })).json();
  assert.equal(c.playlist_id, null);
  assert.equal(c.actual_plays, null);
  assert.equal(c.expected_plays, null);
  assert.equal(c.delivery_pct, null);
  assert.equal(c.delivery_days_elapsed, null);
});

test('delivery: unpublished playlist -> actual_plays 0 (not null)', async () => {
  const c = await (await call('POST', camps('ws-a'), T.editor, {
    name: 'draft playlist', playlist_id: 'pl-a-draft', start_date: plusDays(-1), end_date: plusDays(5), target_plays_per_day: 8,
  })).json();
  assert.equal(c.actual_plays, 0);
  assert.equal(c.expected_plays, 16, '8/day * 2 days');
  assert.equal(c.delivery_pct, 0);
});

test('delivery: not-started campaign -> zeros, pct null', async () => {
  const c = await (await call('POST', camps('ws-a'), T.editor, {
    name: 'future', playlist_id: 'pl-a', start_date: plusDays(10), end_date: plusDays(20), target_plays_per_day: 10,
  })).json();
  assert.equal(c.actual_plays, 0);
  assert.equal(c.delivery_days_elapsed, 0);
  assert.equal(c.expected_plays, 0);
  assert.equal(c.delivery_pct, null);
});
