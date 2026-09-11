'use strict';

// Regression tests for the SERVER-SIDE data contracts added by the mute + zone-orphan
// branch. These guard the exact bugs we fixed so they can't silently come back:
//   1. GET /api/devices/:id must carry each item's `muted` — and BOTH true and false
//      (the bug was a SELECT that dropped the column; the false case is the one that broke).
//   2. GET /api/devices/:id must return `active_layout_zones` for a multi-zone device
//      (the contract the dashboard zone-selector now depends on).
//   3. The single-source orphan rule (lib/zone-validate): a zone in the active layout is
//      NOT orphaned; a zone from a DIFFERENT layout IS — surfaced as the per-item `orphan`
//      flag and the device-list `orphan_count`.
//   4. Reassigning an orphan to a valid zone drops `orphan_count` to 0.
//   5. Assign-time hardening: a zone_id not in the device's active layout is cleared to
//      null on POST; a valid one is kept.
//
// In-process against the real MySQL database (see test/helpers/inprocess-app.js). Every
// row this test creates is disposable: workspace-scoped rows (device, playlist, layouts)
// cascade from the disposable user's org; `content` rows are seeded with workspace_id
// left NULL (the platform-template shape) so they do NOT cascade and are cleaned up
// explicitly (test/helpers/disposable.js's cleanupContent).
// No player/DOM/Playwright tests.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startInProcessApp } = require('./helpers/inprocess-app');
const { randTag, cleanupUsers, cleanupContent } = require('./helpers/disposable');

let base, db, stop;
const S = {};
const created = { userIds: [], contentIds: [] };

async function jfetch(p, opts = {}) {
  const res = await fetch(base + p, opts);
  let body = null; try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
}
const auth = (tok) => ({ headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' } });
const post = (tok, obj) => ({ method: 'POST', ...auth(tok), body: JSON.stringify(obj || {}) });
const put = (tok, obj) => ({ method: 'PUT', ...auth(tok), body: JSON.stringify(obj || {}) });

// Find one item in the device payload by playlist_item id (ids are integers; coerce both).
async function getAssignment(itemId) {
  const r = await jfetch(`/api/devices/${S.deviceId}`, auth(S.jwt));
  return (r.body.assignments || []).find((a) => Number(a.id) === Number(itemId));
}
// Read the device's orphan_count off the workspace device list.
async function getOrphanCount() {
  const r = await jfetch('/api/devices', auth(S.jwt));
  const d = (r.body || []).find((x) => x.id === S.deviceId);
  return d ? d.orphan_count : undefined;
}

before(async () => {
  ({ base, db, stop } = await startInProcessApp({ only: ['/api/auth', '/api/devices', '/api/layouts', '/api/playlists', '/api/assignments'] }));

  const tag = randTag();
  const reg = await jfetch('/api/auth/register', post(null, { email: `devzone-${tag}@x.local`, password: 'Passw0rd123' }));
  S.jwt = reg.body.token;
  created.userIds.push(reg.body.user.id);
  S.userId = reg.body.user.id;
  S.wsA = reg.body.current_workspace_id;

  // Active multi-zone layout L1 (Main, Side) + a DIFFERENT layout L2 (Other) — via the API
  // so zone ids are real and workspace-scoped. L2's zone is the "different layout" orphan.
  const l1 = await jfetch('/api/layouts', post(S.jwt, { name: 'L1', zones: [{ name: 'Main', width_percent: 60, height_percent: 100 }, { name: 'Side', width_percent: 40, height_percent: 100 }] }));
  S.L1 = l1.body.id; S.Z1 = l1.body.zones[0].id; S.Z2 = l1.body.zones[1].id;
  const l2 = await jfetch('/api/layouts', post(S.jwt, { name: 'L2', zones: [{ name: 'Other', width_percent: 100, height_percent: 100 }] }));
  S.ZX = l2.body.zones[0].id;

  const pl = await jfetch('/api/playlists', post(S.jwt, { name: 'zone-pl' }));
  S.playlistId = pl.body.id;

  // Content rows are seeded directly (workspace_id left NULL — the platform-template
  // shape; tracked in created.contentIds for explicit cleanup) and a device + playlist_items
  // via the real db module. The orphan item is seeded DIRECTLY so it bypasses assign-time
  // validation — that's how real orphans arise (assigned under a different layout / layout
  // switched after the fact).
  const mkContent = async (name) => {
    const id = `${tag}-c-${name}`;
    await db.prepare("INSERT INTO content (id, filename, filepath, mime_type, file_size, remote_url) VALUES (?,?,?,?,0,?)")
      .run(id, name, '', 'image/png', `https://example.com/${name}.png`);
    created.contentIds.push(id);
    return id;
  };
  S.cMute = await mkContent('mute'); S.cValid = await mkContent('valid'); S.cOrphan = await mkContent('orphan');
  S.cPostStale = await mkContent('post-stale'); S.cPostOk = await mkContent('post-ok');

  S.deviceId = `${tag}-dev`;
  await db.prepare("INSERT INTO devices (id, name, status, workspace_id, user_id, layout_id, playlist_id) VALUES (?,?,?,?,?,?,?)")
    .run(S.deviceId, 'ZoneDev', 'online', S.wsA, S.userId, S.L1, S.playlistId);

  const addItem = async (contentId, zoneId, sort) =>
    (await db.prepare("INSERT INTO playlist_items (playlist_id, content_id, zone_id, sort_order, duration_sec, muted) VALUES (?,?,?,?,10,0)")
      .run(S.playlistId, contentId, zoneId, sort)).lastInsertRowid;
  S.itemMute = await addItem(S.cMute, null, 0);     // no zone — for the mute round-trip
  S.itemValid = await addItem(S.cValid, S.Z1, 1);   // zone in the active layout -> NOT orphan
  S.itemOrphan = await addItem(S.cOrphan, S.ZX, 2); // zone from L2 -> orphan
});

after(async () => {
  await cleanupContent(db, created.contentIds);
  await cleanupUsers(db, created.userIds);
  await stop();
});

// 1. muted must round-trip through the device payload SELECT — both states.
test('GET /api/devices/:id carries per-item muted (true AND false)', async () => {
  await jfetch(`/api/assignments/${S.itemMute}`, put(S.jwt, { muted: true }));
  let a = await getAssignment(S.itemMute);
  assert.ok(a, 'item appears in the device payload');
  assert.equal(a.muted, 1, 'muted=true survives the GET /api/devices/:id SELECT');

  await jfetch(`/api/assignments/${S.itemMute}`, put(S.jwt, { muted: false }));
  a = await getAssignment(S.itemMute);
  assert.equal(a.muted, 0, 'muted=false survives too (the case that originally broke)');
});

// 2. active_layout_zones contract for a multi-zone device.
test('GET /api/devices/:id returns active_layout_zones for a multi-zone device', async () => {
  const r = await jfetch(`/api/devices/${S.deviceId}`, auth(S.jwt));
  const zones = r.body.active_layout_zones;
  assert.ok(Array.isArray(zones), 'active_layout_zones is present');
  assert.equal(zones.length, 2, 'both zones of the active layout are returned');
  assert.deepEqual(zones.map((z) => z.id).sort(), [S.Z1, S.Z2].sort(), 'exactly the active-layout zone ids');
});

// 3. orphan definition: in-layout zone -> not orphan; different-layout zone -> orphan.
test('orphan flag + orphan_count reflect the single-source rule', async () => {
  const valid = await getAssignment(S.itemValid);
  const orphan = await getAssignment(S.itemOrphan);
  assert.equal(valid.orphan, false, 'a zone in the active layout is NOT orphaned');
  assert.equal(orphan.orphan, true, 'a zone from a different layout IS orphaned');
  assert.equal(await getOrphanCount(), 1, 'device list orphan_count counts exactly the one orphan');
});

// 4. reassigning the orphan to a valid zone clears the count.
test('reassigning an orphan to a valid zone clears orphan_count', async () => {
  assert.equal(await getOrphanCount(), 1, 'precondition: one orphan');
  const r = await jfetch(`/api/assignments/${S.itemOrphan}`, put(S.jwt, { zone_id: S.Z1 }));
  assert.equal(r.body.zone_id, S.Z1, 'reassignment to a valid zone persists');
  assert.equal(await getOrphanCount(), 0, 'orphan_count drops to 0 after reassign');
});

// 5. assign-time hardening: stale zone_id cleared, valid kept.
test('POST assignment clears a stale zone_id and keeps a valid one', async () => {
  const stale = await jfetch(`/api/assignments/device/${S.deviceId}`, post(S.jwt, { content_id: S.cPostStale, zone_id: S.ZX, duration_sec: 10 }));
  assert.equal(stale.status, 201);
  assert.equal(stale.body.zone_id, null, 'a zone_id from a different layout is cleared to null on add');

  const ok = await jfetch(`/api/assignments/device/${S.deviceId}`, post(S.jwt, { content_id: S.cPostOk, zone_id: S.Z2, duration_sec: 10 }));
  assert.equal(ok.status, 201);
  assert.equal(ok.body.zone_id, S.Z2, 'a zone_id in the active layout is kept');
});
