'use strict';

// Phase 5 Stage A — campaigns data model + admin endpoints.
//
// The REAL workspaces router in-process (helpers/inprocess-app.js, mounted as
// server.js does: activityLogger, then requireAuth only; per-handler RBAC via
// canWriteWorkspace / canAccessWorkspace, no resolveTenancy) against the REAL MySQL
// test DB (beamos_test via npm test). Covers the RBAC matrix, validation (dates,
// target, cross-workspace playlist), the computed draft/live/completed status, that
// DELETE removes only the wrapper (playlist survives), and activity_log rows.
//
// Fixtures are test-owned (cp- prefix, generated ids) and removed afterwards (newest
// user first, so each org owner goes last). play_logs.content_id has a real FK to
// content, so the content the playlist snapshot names exists as content rows.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { db } = require('../db/database');
const { generateToken } = require('../middleware/auth');
const { startInProcessApp } = require('./helpers/inprocess-app');
const { randTag, cleanupUsers, cleanupRows } = require('./helpers/disposable');
const { waitForAuditRows, maxAuditId } = require('./helpers/wait-for-audit');

const P = `cp-${randTag()}`;
const id = (name) => `${P}-${name}`;
let app;
const userIds = [];
const U = {};
const T = {};
const ID = {
  orgA: id('org-a'), orgB: id('org-b'), wsA: id('ws-a'), wsB: id('ws-b'),
  plA: id('pl-a'), plADraft: id('pl-a-draft'), plB: id('pl-b'), plNoWs: id('pl-nows'),
  devA: id('dev-a'), devB: id('dev-b'), con1: id('con-1'), con2: id('con-2'), con9: id('con-9'),
};

async function mkUser(key, role = 'user') {
  const uid = id(key);
  const email = `${uid}@t.test`;
  await app.db.prepare("INSERT INTO users (id, email, name, password_hash, auth_provider, role) VALUES (?, ?, ?, NULL, 'local', ?)")
    .run(uid, email, uid, role);
  userIds.push(uid);
  U[key] = { id: uid, email };
  T[key] = generateToken({ id: uid, email, role }, null);
}

test.before(async () => {
  app = await startInProcessApp({ only: ['/api/workspaces'] });
  const run = (sql, ...p) => app.db.prepare(sql).run(...p);

  await mkUser('plat', 'platform_admin');
  await mkUser('orgOwner');
  await mkUser('wsAdmin');
  await mkUser('editor');
  await mkUser('viewer');
  await mkUser('other');
  await mkUser('nobody');

  const org = "INSERT INTO organizations (id, name, owner_user_id, plan_id, subscription_status) VALUES (?, ?, ?, 'enterprise', 'active')";
  await run(org, ID.orgA, `${P} Org A`, U.orgOwner.id);
  await run(org, ID.orgB, `${P} Org B`, U.other.id);
  const om = 'INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, ?)';
  await run(om, ID.orgA, U.orgOwner.id, 'org_owner');
  await run(om, ID.orgB, U.other.id, 'org_owner');

  await run('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)', ID.wsA, ID.orgA, `${P} WS A`);
  await run('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)', ID.wsB, ID.orgB, `${P} WS B`);
  const wm = 'INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)';
  await run(wm, ID.wsA, U.wsAdmin.id, 'workspace_admin');
  await run(wm, ID.wsA, U.editor.id, 'workspace_editor');
  await run(wm, ID.wsA, U.viewer.id, 'workspace_viewer');
  await run(wm, ID.wsB, U.other.id, 'workspace_admin');

  // play_logs.content_id has a real FK to content.
  const content = "INSERT INTO content (id, user_id, workspace_id, filename, mime_type) VALUES (?, ?, ?, ?, 'video/mp4')";
  await run(content, ID.con1, U.orgOwner.id, ID.wsA, '1.mp4');
  await run(content, ID.con2, U.orgOwner.id, ID.wsA, '2.mp4');
  await run(content, ID.con9, U.orgOwner.id, ID.wsA, '9.mp4');

  const PL_A_SNAP = JSON.stringify([
    { content_id: ID.con1, widget_id: null, sort_order: 0, filename: '1.mp4' },
    { content_id: ID.con2, widget_id: null, sort_order: 1, filename: '2.mp4' },
    { content_id: null, widget_id: 'wid-x', sort_order: 2 },
  ]);
  const pl = 'INSERT INTO playlists (id, user_id, workspace_id, name, published_snapshot) VALUES (?, ?, ?, ?, ?)';
  await run(pl, ID.plA, U.orgOwner.id, ID.wsA, 'Summer Reel', PL_A_SNAP);
  await run(pl, ID.plADraft, U.orgOwner.id, ID.wsA, 'Unpublished Reel', null);
  await run(pl, ID.plB, U.other.id, ID.wsB, 'Other WS Playlist', null);
  await run(pl, ID.plNoWs, U.orgOwner.id, null, 'Legacy no-workspace', null);

  await run('INSERT INTO devices (id, workspace_id) VALUES (?, ?)', ID.devA, ID.wsA);
  await run('INSERT INTO devices (id, workspace_id) VALUES (?, ?)', ID.devB, ID.wsB); // another workspace, same shared content
});

test.after(async () => {
  try {
    if (app) {
      // The no-workspace playlist cascades from nothing; everything else goes with its org.
      await app.db.prepare('DELETE FROM playlists WHERE id = ?').run(ID.plNoWs);
      await cleanupUsers(app.db, [...userIds].reverse());
      await cleanupRows(app.db, 'content', [ID.con1, ID.con2, ID.con9]);
    }
  } finally {
    if (app) await app.stop(); else await db.close();
  }
});

const call = (method, path, token, body) =>
  fetch(app.base + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const camps = (ws) => `/api/workspaces/${ws}/campaigns`;
// Only this file's rows: the shared test DB holds other files' audit rows too.
const auditCount = async (action) => Number((await app.db
  .prepare(`SELECT COUNT(*) AS c FROM activity_log WHERE action = ? AND user_id IN (${userIds.map(() => '?').join(',')})`)
  .get(action, ...userIds)).c);

const TODAY = new Date().toISOString().slice(0, 10);
const plusDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

// -------------------------------------------------------------------

test('editor creates a campaign; defaults + activity_log row', async () => {
  const before = await auditCount('campaign_created');
  const sinceId = await maxAuditId(app.db);
  const r = await call('POST', camps(ID.wsA), T.editor, {
    name: 'Q3 Launch', start_date: plusDays(-1), end_date: plusDays(5),
  });
  assert.equal(r.status, 201);
  await waitForAuditRows(app.db, { sinceId, userId: U.editor.id, actions: ['campaign_created'] });
  const c = await r.json();
  assert.equal(c.name, 'Q3 Launch');
  assert.equal(c.workspace_id, ID.wsA);
  assert.equal(c.playlist_id, null);
  assert.equal(c.target_plays_per_day, null);
  assert.equal(c.created_by, U.editor.id);
  assert.equal(c.created_by_email, U.editor.email);
  assert.equal(c.status, 'live', 'started yesterday, ends in 5d -> live');
  assert.equal(await auditCount('campaign_created'), before + 1);
});

test('create with playlist + all fields; playlist_name resolved', async () => {
  const r = await call('POST', camps(ID.wsA), T.wsAdmin, {
    name: 'Holiday Push', description: 'End of year', playlist_id: ID.plA,
    start_date: plusDays(10), end_date: plusDays(40), target_plays_per_day: 24,
  });
  assert.equal(r.status, 201);
  const c = await r.json();
  assert.equal(c.playlist_id, ID.plA);
  assert.equal(c.playlist_name, 'Summer Reel');
  assert.equal(c.target_plays_per_day, 24);
  assert.equal(c.description, 'End of year');
  assert.equal(c.status, 'draft', 'starts in 10d -> draft');
});

test('create validation: name, dates, target, playlist', async () => {
  const ok = { name: 'x', start_date: TODAY, end_date: plusDays(3) };
  assert.equal((await call('POST', camps(ID.wsA), T.editor, { ...ok, name: '  ' })).status, 400);
  assert.equal((await call('POST', camps(ID.wsA), T.editor, { name: 'x' })).status, 400, 'missing dates');
  assert.equal((await call('POST', camps(ID.wsA), T.editor, { ...ok, start_date: '2026-13-40' })).status, 400, 'not a real date');
  assert.equal((await call('POST', camps(ID.wsA), T.editor, { ...ok, start_date: '06/01/2026' })).status, 400, 'wrong format');
  assert.equal((await call('POST', camps(ID.wsA), T.editor, { name: 'x', start_date: plusDays(5), end_date: plusDays(1) })).status, 400, 'end before start');
  assert.equal((await call('POST', camps(ID.wsA), T.editor, { ...ok, target_plays_per_day: 0 })).status, 400);
  assert.equal((await call('POST', camps(ID.wsA), T.editor, { ...ok, target_plays_per_day: 2.5 })).status, 400);
  assert.equal((await call('POST', camps(ID.wsA), T.editor, { ...ok, playlist_id: id('pl-missing') })).status, 404);
  assert.equal((await call('POST', camps(ID.wsA), T.editor, { ...ok, playlist_id: ID.plB })).status, 400, 'playlist in ws-b');
  assert.equal((await call('POST', camps(ID.wsA), T.editor, { ...ok, playlist_id: ID.plNoWs })).status, 400, 'null-workspace playlist rejected too');
  // same-day campaign is allowed
  assert.equal((await call('POST', camps(ID.wsA), T.editor, { name: 'oneday', start_date: TODAY, end_date: TODAY })).status, 201);
});

test('RBAC: viewer reads but cannot create/update/delete; non-member + other-org denied', async () => {
  const list = await call('GET', camps(ID.wsA), T.viewer);
  assert.equal(list.status, 200);
  const any = (await list.json())[0];

  assert.equal((await call('POST', camps(ID.wsA), T.viewer, { name: 'no', start_date: TODAY, end_date: plusDays(1) })).status, 403);
  assert.equal((await call('PATCH', `${camps(ID.wsA)}/${any.id}`, T.viewer, { name: 'no' })).status, 403);
  assert.equal((await call('DELETE', `${camps(ID.wsA)}/${any.id}`, T.viewer)).status, 403);

  for (const who of [T.nobody, T.other]) {
    assert.equal((await call('GET', camps(ID.wsA), who)).status, 403);
    assert.equal((await call('POST', camps(ID.wsA), who, { name: 'x', start_date: TODAY, end_date: plusDays(1) })).status, 403);
  }
  assert.equal((await call('GET', camps(id('ws-zzz')), T.plat)).status, 404);
  assert.equal((await call('POST', camps(id('ws-zzz')), T.plat, { name: 'x', start_date: TODAY, end_date: plusDays(1) })).status, 404);
});

test('RBAC: org_owner and platform_admin can manage without a workspace_members row', async () => {
  assert.equal((await call('POST', camps(ID.wsA), T.orgOwner, { name: 'from org owner', start_date: TODAY, end_date: plusDays(2) })).status, 201);
  assert.equal((await call('POST', camps(ID.wsA), T.plat, { name: 'from platform', start_date: TODAY, end_date: plusDays(2) })).status, 201);
});

test('computed status: draft / live / completed by date window', async () => {
  const mk = (name, s, e) => call('POST', camps(ID.wsA), T.editor, { name, start_date: s, end_date: e }).then((r) => r.json());
  const past = await mk('past', plusDays(-20), plusDays(-10));
  const now = await mk('now', plusDays(-2), plusDays(2));
  const future = await mk('future', plusDays(10), plusDays(20));
  assert.equal(past.status, 'completed');
  assert.equal(now.status, 'live');
  assert.equal(future.status, 'draft');

  // list ?status= filter
  const live = await (await call('GET', `${camps(ID.wsA)}?status=live`, T.viewer)).json();
  assert.ok(live.every((c) => c.status === 'live'));
  assert.ok(live.some((c) => c.id === now.id));
  assert.equal((await call('GET', `${camps(ID.wsA)}?status=bogus`, T.viewer)).status, 400);
});

test('PATCH: fields + date-window revalidation + no-op + 404s', async () => {
  const c = await (await call('POST', camps(ID.wsA), T.editor, { name: 'patch me', start_date: plusDays(1), end_date: plusDays(10) })).json();
  const url = `${camps(ID.wsA)}/${c.id}`;
  const before = await auditCount('campaign_updated');
  const sinceId = await maxAuditId(app.db);

  let u = await (await call('PATCH', url, T.editor, { name: 'patched', target_plays_per_day: 12, playlist_id: ID.plA })).json();
  assert.equal(u.name, 'patched');
  assert.equal(u.target_plays_per_day, 12);
  assert.equal(u.playlist_id, ID.plA);

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
  assert.equal((await call('PATCH', `${camps(ID.wsA)}/nope`, T.editor, { name: 'x' })).status, 404);
  const cB = id('c-b');
  await app.db.prepare("INSERT INTO campaigns (id, workspace_id, name, start_date, end_date) VALUES (?, ?, 'B camp', '2026-01-01', '2026-02-01')").run(cB, ID.wsB);
  assert.equal((await call('PATCH', `${camps(ID.wsA)}/${cB}`, T.editor, { name: 'x' })).status, 404, 'campaign in ws-b not visible under ws-a');

  await waitForAuditRows(app.db, { sinceId, userId: U.editor.id, actions: ['campaign_updated'], count: 3 });
  assert.equal(await auditCount('campaign_updated'), before + 3);
});

test('DELETE removes only the wrapper - the playlist survives; activity_log; 404s', async () => {
  const c = await (await call('POST', camps(ID.wsA), T.editor, {
    name: 'doomed', playlist_id: ID.plA, start_date: TODAY, end_date: plusDays(5),
  })).json();
  const before = await auditCount('campaign_deleted');
  const sinceId = await maxAuditId(app.db);

  const del = await call('DELETE', `${camps(ID.wsA)}/${c.id}`, T.editor);
  assert.equal(del.status, 200);
  assert.deepEqual(await del.json(), { success: true });
  await waitForAuditRows(app.db, { sinceId, userId: U.editor.id, actions: ['campaign_deleted'] });

  assert.equal(Number((await app.db.prepare('SELECT COUNT(*) AS n FROM campaigns WHERE id = ?').get(c.id)).n), 0, 'campaign gone');
  assert.equal(Number((await app.db.prepare('SELECT COUNT(*) AS n FROM playlists WHERE id = ?').get(ID.plA)).n), 1, 'playlist untouched');
  assert.equal(await auditCount('campaign_deleted'), before + 1);

  assert.equal((await call('DELETE', `${camps(ID.wsA)}/${c.id}`, T.editor)).status, 404, 'already gone');
  assert.equal((await call('DELETE', `${camps(ID.wsA)}/nope`, T.editor)).status, 404);
});

test('GET detail + 404 for other workspace', async () => {
  const c = await (await call('POST', camps(ID.wsA), T.editor, { name: 'detail me', start_date: TODAY, end_date: plusDays(1) })).json();
  const got = await call('GET', `${camps(ID.wsA)}/${c.id}`, T.viewer);
  assert.equal(got.status, 200);
  assert.equal((await got.json()).name, 'detail me');
  assert.equal((await call('GET', `${camps(ID.wsB)}/${c.id}`, T.other)).status, 404);
});

// ===================== Phase 5 Stage B — delivery tracking =====================

const epoch = (iso) => Math.floor(Date.parse(iso) / 1000);
const play = (contentId, iso, device = ID.devA) =>
  app.db.prepare('INSERT INTO play_logs (device_id, content_id, started_at) VALUES (?, ?, ?)').run(device, contentId, epoch(iso));

test('delivery fields: hand-checked against seeded play_logs, wrong content excluded', async () => {
  // campaign over pl-a (con-1 / con-2), a 10-day window ending 5 days out,
  // target 10/day. Back-date so "today" sits mid-flight (day 3).
  const c = await (await call('POST', camps(ID.wsA), T.editor, {
    name: 'delivery', playlist_id: ID.plA, start_date: plusDays(-2), end_date: plusDays(7), target_plays_per_day: 10,
  })).json();

  const s = plusDays(-2);
  await play(ID.con1, s + 'T09:00:00Z');   // day 1
  await play(ID.con2, s + 'T18:00:00Z');   // day 1
  await play(ID.con1, plusDays(-1) + 'T10:00:00Z'); // day 2
  await play(ID.con1, TODAY + 'T08:00:00Z');        // day 3 (today)
  await play(ID.con2, TODAY + 'T09:00:00Z');        // day 3
  await play(ID.con9, TODAY + 'T09:00:00Z');        // WRONG content -> excluded
  await play(ID.con1, plusDays(3) + 'T09:00:00Z');  // AFTER today -> excluded
  await play(ID.con1, plusDays(-5) + 'T09:00:00Z'); // BEFORE start -> excluded

  const got = await (await call('GET', `${camps(ID.wsA)}/${c.id}`, T.viewer)).json();
  assert.equal(got.actual_plays, 5, 'only the 5 in-window pl-a plays');
  assert.equal(got.delivery_days_elapsed, 3, 'day 1..today inclusive');
  assert.equal(got.expected_plays, 30, '10/day * 3 days');
  assert.equal(got.delivery_pct, Math.round((5 / 30) * 1000) / 10);

  // same numbers via the list endpoint
  const inList = (await (await call('GET', camps(ID.wsA), T.viewer)).json()).find((x) => x.id === c.id);
  assert.equal(inList.actual_plays, 5);
  assert.equal(inList.expected_plays, 30);

  // a play of the SAME content, in-window, but on a device in ANOTHER workspace
  // (shared/template content reused elsewhere) must NOT be credited here.
  await play(ID.con1, TODAY + 'T10:00:00Z', ID.devB);
  await play(ID.con2, TODAY + 'T11:00:00Z', ID.devB);
  const after = await (await call('GET', `${camps(ID.wsA)}/${c.id}`, T.viewer)).json();
  assert.equal(after.actual_plays, 5, "another workspace's plays of the same content are excluded");
});

test('delivery: null target -> actual_plays computed, expected/pct null', async () => {
  const c = await (await call('POST', camps(ID.wsA), T.editor, {
    name: 'no target', playlist_id: ID.plA, start_date: plusDays(-1), end_date: plusDays(5),
  })).json();
  await play(ID.con1, TODAY + 'T07:00:00Z');
  const got = await (await call('GET', `${camps(ID.wsA)}/${c.id}`, T.viewer)).json();
  assert.equal(typeof got.actual_plays, 'number');
  assert.equal(got.expected_plays, null);
  assert.equal(got.delivery_pct, null);
  assert.ok(got.delivery_days_elapsed >= 1);
});

test('delivery: null playlist -> every delivery field null, no error', async () => {
  const c = await (await call('POST', camps(ID.wsA), T.editor, {
    name: 'no playlist', start_date: plusDays(-1), end_date: plusDays(5), target_plays_per_day: 10,
  })).json();
  assert.equal(c.playlist_id, null);
  assert.equal(c.actual_plays, null);
  assert.equal(c.expected_plays, null);
  assert.equal(c.delivery_pct, null);
  assert.equal(c.delivery_days_elapsed, null);
});

test('delivery: unpublished playlist -> actual_plays 0 (not null)', async () => {
  const c = await (await call('POST', camps(ID.wsA), T.editor, {
    name: 'draft playlist', playlist_id: ID.plADraft, start_date: plusDays(-1), end_date: plusDays(5), target_plays_per_day: 8,
  })).json();
  assert.equal(c.actual_plays, 0);
  assert.equal(c.expected_plays, 16, '8/day * 2 days');
  assert.equal(c.delivery_pct, 0);
});

test('delivery: not-started campaign -> zeros, pct null', async () => {
  const c = await (await call('POST', camps(ID.wsA), T.editor, {
    name: 'future', playlist_id: ID.plA, start_date: plusDays(10), end_date: plusDays(20), target_plays_per_day: 10,
  })).json();
  assert.equal(c.actual_plays, 0);
  assert.equal(c.delivery_days_elapsed, 0);
  assert.equal(c.expected_plays, 0);
  assert.equal(c.delivery_pct, null);
});
