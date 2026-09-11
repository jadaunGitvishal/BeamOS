'use strict';

// Thumbnail serving: remote (proxied) vs local (sendFile). Regression test for the
// YouTube hqdefault.jpg ENOENT bug — content.js stores thumbnail_path as a REMOTE URL
// (https://img.youtube.com/vi/<id>/hqdefault.jpg), and the serving route used to
// path.resolve it into contentDir -> a local file that never existed -> ENOENT spam.
// The public GET /api/content/:id/thumbnail (routes/public-content.js, extracted from
// server.js — see its own file header) proxies remote http(s) thumbnails server-side;
// local files still sendFile unchanged. A local HTTP server stands in for
// img.youtube.com (the "mock upstream") so no network is needed.
//
// In-process against the real MySQL database (see test/helpers/inprocess-app.js),
// mounting the SAME real public-content module server.js mounts (not a duplicate).
// Every row this test creates is disposable and removed in after().

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

// MUST be set before requiring config (transitively, via helpers/inprocess-app) -
// config.js resolves contentDir from DATA_DIR at require time. Without this, an
// in-process test (no spawned subprocess of its own DATA_DIR) would write its
// disposable local-thumbnail file into the REAL production uploads/content dir.
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-thumb-inprocess-' + crypto.randomBytes(4).toString('hex'));

const { startInProcessApp } = require('./helpers/inprocess-app');
const { randTag, cleanupUsers, cleanupContent } = require('./helpers/disposable');

const CONTENT_DIR = path.join(require('../config').contentDir);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMCAYAAAAxN7CkAAAAASUVORK5CYII=', 'base64');

let base, db, stop, upstream, upstreamPort, upstreamHits = 0;
const created = { userIds: [], contentIds: [], playlistIds: [] };
let plId, localFileName;

async function jget(p) {
  const res = await fetch(base + p);
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, type: res.headers.get('content-type') || '', buf };
}

// Insert a content row + a playlist_items row (so the public thumbnail gate passes).
async function makeContent(thumbnailPath, { mime = 'image/png' } = {}) {
  const id = `${randTag()}-content`;
  await db.prepare('INSERT INTO content (id, filename, filepath, mime_type, file_size, thumbnail_path) VALUES (?,?,?,?,0,?)')
    .run(id, 'item', '', mime, thumbnailPath);
  created.contentIds.push(id);
  await db.prepare('INSERT INTO playlist_items (playlist_id, content_id) VALUES (?, ?)').run(plId, id);
  return id;
}

before(async () => {
  // Mock upstream standing in for img.youtube.com. /missing/* -> 404 to exercise the
  // clean-failure path; everything else -> a 200 image/png.
  upstream = http.createServer((req, res) => {
    upstreamHits++;
    if (req.url.includes('missing')) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(PNG);
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamPort = upstream.address().port;

  ({ base, db, stop } = await startInProcessApp({ only: ['/api/auth', '/api/status', '/api/content/public'] }));

  const tag = randTag();
  const email = `thumbproxy-${tag}@x.local`;
  const r = await (await fetch(base + '/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Passw0rd123' }),
  })).json();
  created.userIds.push(r.user.id);

  // A real playlist (playlist_items.playlist_id FK-references playlists(id) under real
  // MySQL — the original SQLite-era test used a dangling 'pl-test' string, which SQLite
  // never enforced but MySQL genuinely rejects).
  plId = `${tag}-pl`;
  await db.prepare('INSERT INTO playlists (id, user_id, workspace_id, name) VALUES (?, ?, ?, ?)')
    .run(plId, r.user.id, r.current_workspace_id, 'thumb-test-pl');
  created.playlistIds.push(plId);

  localFileName = `${tag}-localthumb.png`;
  fs.mkdirSync(CONTENT_DIR, { recursive: true });
  fs.writeFileSync(path.join(CONTENT_DIR, localFileName), PNG);
});

after(async () => {
  try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* */ }
  await cleanupContent(db, created.contentIds);
  for (const id of created.playlistIds) { try { await db.prepare('DELETE FROM playlists WHERE id = ?').run(id); } catch { /* */ } }
  await cleanupUsers(db, created.userIds);
  try { upstream.close(); } catch { /* */ }
  await stop();
});

test('local-file thumbnail still serves via sendFile', async () => {
  const id = await makeContent(localFileName);
  const r = await jget(`/api/content/${id}/thumbnail`);
  assert.equal(r.status, 200, 'local thumbnail served');
  assert.match(r.type, /^image\//, 'image content-type');
  assert.ok(r.buf.equals(PNG), 'served the local bytes');
});

test('remote http thumbnail is proxied (no local read, no ENOENT)', async () => {
  const before = upstreamHits;
  // A YouTube-style remote thumbnail. The basename is hqdefault.jpg — the exact name
  // the old bug tried (and failed) to read from contentDir.
  const id = await makeContent(`http://127.0.0.1:${upstreamPort}/vi/abc/hqdefault.jpg`, { mime: 'video/youtube' });
  // The local file the buggy path would have looked for must NOT exist.
  assert.ok(!fs.existsSync(path.join(CONTENT_DIR, 'hqdefault.jpg')), 'no local hqdefault.jpg exists');

  const r = await jget(`/api/content/${id}/thumbnail`);
  assert.equal(r.status, 200, 'remote thumbnail proxied');
  assert.equal(r.type, 'image/png', 'upstream content-type passed through');
  assert.ok(r.buf.equals(PNG), 'served the upstream bytes');
  assert.equal(upstreamHits, before + 1, 'fetched the upstream once (proxied, not read from disk)');
});

test('remote upstream 404 yields a clean 404 (process stays up)', async () => {
  const id = await makeContent(`http://127.0.0.1:${upstreamPort}/vi/missing/hqdefault.jpg`, { mime: 'video/youtube' });
  const r = await jget(`/api/content/${id}/thumbnail`);
  assert.equal(r.status, 404, 'upstream 404 maps to a clean 404');
  // server still alive
  assert.equal((await fetch(base + '/api/status')).ok, true, 'server survived the upstream failure');
});
