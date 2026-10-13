'use strict';

// #129 mute: the per-item `muted` flag must persist on PUT /api/assignments/:id, come
// back in the item read (ITEM_SELECT), and reach the device by being included in the
// playlist's published_snapshot (buildSnapshotItems). Before the fix the PUT silently
// dropped `muted`, playlist_items had no such column, and the snapshot never carried it —
// so the dashboard mute toggle was a no-op end to end.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
// The spawned server and this process share the real MySQL test DB (beamos_test via
// npm test): seed / read through the same db module, test-owned rows only.
const { db } = require('../db/database');
const { cleanupUser } = require('./helpers/disposable');
const { startServer } = require('./helpers/spawn-server');

const PW = 'Passw0rd123';
let srv, BASE;
const S = {};

async function jfetch(p, opts = {}) {
  const res = await fetch(BASE + p, opts);
  let body = null; try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
}
const auth = (tok) => ({ headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' } });
const post = (tok, obj) => ({ method: 'POST', ...auth(tok), body: JSON.stringify(obj || {}) });
const put = (tok, obj) => ({ method: 'PUT', ...auth(tok), body: JSON.stringify(obj || {}) });

before(async () => {
  srv = await startServer({ name: 'mute' });
  BASE = srv.base;

  const reg = await jfetch('/api/auth/register', post(null, { email: 'mute-' + crypto.randomBytes(4).toString('hex') + '@x.local', password: PW }));
  S.jwt = reg.body.token;
  S.userId = reg.body.user.id;
  const pl = await jfetch('/api/playlists', post(S.jwt, { name: 'mute-pl' }));
  S.playlistId = pl.body.id;

  // Seed a content row (a NULL-workspace remote clip, content.workspace_id is nullable)
  // + a playlist_item on the real test DB.
  S.contentId = crypto.randomUUID();
  await db.prepare("INSERT INTO content (id, filename, filepath, mime_type, file_size, remote_url) VALUES (?,?,?,?,0,?)")
    .run(S.contentId, 'clip', '', 'video/mp4', 'https://example.com/clip.mp4');
  const info = await db.prepare('INSERT INTO playlist_items (playlist_id, content_id, sort_order, duration_sec) VALUES (?,?,0,10)')
    .run(S.playlistId, S.contentId);
  S.itemId = info.lastInsertRowid;
});

// Only this file's rows: the content row (cascades its playlist_items), then the
// registered user and everything their signup created (org, workspace, playlist).
after(async () => {
  if (srv) await srv.stop();
  try {
    if (S.contentId) await db.prepare('DELETE FROM content WHERE id = ?').run(S.contentId);
    if (S.userId) await cleanupUser(db, S.userId);
  } finally {
    await db.close();
  }
});

test('PUT /assignments/:id persists muted and returns it (ITEM_SELECT)', async () => {
  const on = await jfetch(`/api/assignments/${S.itemId}`, put(S.jwt, { muted: true }));
  assert.equal(on.status, 200);
  assert.equal(on.body.muted, 1, 'muted persisted + returned as 1');

  const off = await jfetch(`/api/assignments/${S.itemId}`, put(S.jwt, { muted: false }));
  assert.equal(off.status, 200);
  assert.equal(off.body.muted, 0, 'unmute persisted + returned as 0');
});

test('muted reaches the device via the published snapshot (buildSnapshotItems)', async () => {
  await jfetch(`/api/assignments/${S.itemId}`, put(S.jwt, { muted: true }));
  const pub = await jfetch(`/api/playlists/${S.playlistId}/publish`, post(S.jwt, {}));
  assert.equal(pub.status, 200);

  const snapRow = await db.prepare('SELECT published_snapshot FROM playlists WHERE id = ?').get(S.playlistId);
  const snap = JSON.parse(snapRow.published_snapshot);
  const item = snap.find((i) => i.content_id === S.contentId);
  assert.ok(item, 'the item is in the published snapshot');
  assert.equal(item.muted, 1, 'snapshot (device payload) carries muted=1');
});

test('mute toggle patches the published snapshot WITHOUT a manual republish (the beta7 bug)', async () => {
  // Baseline: publish once so the device has a snapshot carrying muted=0.
  await jfetch(`/api/assignments/${S.itemId}`, put(S.jwt, { muted: false }));
  await jfetch(`/api/playlists/${S.playlistId}/publish`, post(S.jwt, {}));
  const read = async () => JSON.parse((await db.prepare('SELECT published_snapshot FROM playlists WHERE id = ?').get(S.playlistId)).published_snapshot)
    .find((i) => i.content_id === S.contentId).muted;
  assert.equal(await read(), 0, 'baseline: snapshot the device plays carries muted=0');

  // The actual bug: a mute toggle ALONE (no /publish) must reach the played snapshot.
  // On beta7 this stayed 0 (markDraft only) so every loop re-applied full volume.
  await jfetch(`/api/assignments/${S.itemId}`, put(S.jwt, { muted: true }));
  assert.equal(await read(), 1, 'mute toggle patched the snapshot the device plays — no manual republish needed');

  // Unmute toggle reverts the snapshot too.
  await jfetch(`/api/assignments/${S.itemId}`, put(S.jwt, { muted: false }));
  assert.equal(await read(), 0, 'unmute toggle patched the snapshot back to 0');
});

test('PUT ignoring muted (other field) leaves muted untouched', async () => {
  await jfetch(`/api/assignments/${S.itemId}`, put(S.jwt, { muted: true }));
  const r = await jfetch(`/api/assignments/${S.itemId}`, put(S.jwt, { duration_sec: 15 }));
  assert.equal(r.status, 200);
  assert.equal(r.body.muted, 1, 'a non-mute update does not reset muted');
  assert.equal(r.body.duration_sec, 15);
});
