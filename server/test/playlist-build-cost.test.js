'use strict';

// #146 P2.5 — classify buildPlaylistPayload under a legitimate fleet-wide simultaneous
// reconnect (e.g. 230 disty devices after one network blip). Each first connect passes
// the flap/reconnect gates and runs buildPlaylistPayload. Since the MySQL migration it is
// ASYNC (it awaits the device + playlist reads), so the invariant is now: each awaited
// build stays well under ~50ms, and a fleet-wide burst of builds never blocks the event
// loop for ~50ms (the DB waits yield; only the snapshot parse/shaping is synchronous).

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-plcost-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Server } = require('socket.io');
const { db } = require('../db/database');
const setupDeviceSocket = require('../ws/deviceSocket');

const P = 'PB-' + crypto.randomBytes(4).toString('hex');
const USER = `${P}-u`, PL = `${P}-pl-big`, DEV = `${P}-perf-dev`;
let httpServer, io, buildPlaylistPayload;
before(async () => {
  httpServer = http.createServer(); io = new Server(httpServer); setupDeviceSocket(io);
  buildPlaylistPayload = setupDeviceSocket.buildPlaylistPayload;
  await new Promise((r) => httpServer.listen(0, r));

  // a realistically LARGE published snapshot: 200 items.
  const snap = JSON.stringify(Array.from({ length: 200 }, (_, i) => ({
    content_id: 'c' + i, type: 'image', duration_sec: 10, url: '/uploads/content/c' + i + '.jpg', name: 'item ' + i,
  })));
  // Real MySQL (beamos_test via npm test): a test-owned user (playlists.user_id FK),
  // the big published playlist and a device on it; only these rows are removed.
  await db.prepare("INSERT INTO users (id, email, name) VALUES (?, ?, 'PB owner')").run(USER, `${USER.toLowerCase()}@test.local`);
  await db.prepare("INSERT INTO playlists (id, user_id, name, status, published_snapshot) VALUES (?, ?, 'Big', 'published', ?)").run(PL, USER, snap);
  await db.prepare("INSERT INTO devices (id, status, playlist_id) VALUES (?, 'online', ?)").run(DEV, PL);
});
after(async () => {
  try {
    try { io.close(); } catch { /* */ } try { httpServer.close(); } catch { /* */ }
    await db.prepare('DELETE FROM devices WHERE id = ?').run(DEV);
    await db.prepare('DELETE FROM playlists WHERE id = ?').run(PL);
    await db.prepare('DELETE FROM users WHERE id = ?').run(USER);
  } finally { await db.close(); }
});

test('buildPlaylistPayload is cheap enough for a fleet-wide reconnect (awaited per call, never blocks the loop)', async () => {
  assert.equal(typeof buildPlaylistPayload, 'function');
  const payload = await buildPlaylistPayload(DEV);
  assert.equal(payload.assignments.length, 200, 'parsed the 200-item snapshot');

  // Warm, then measure the awaited per-call cost over a disty-scale fleet count.
  for (let i = 0; i < 50; i++) await buildPlaylistPayload(DEV);
  const N = 230, times = [];
  for (let i = 0; i < N; i++) { const t = process.hrtime.bigint(); await buildPlaylistPayload(DEV); times.push(Number(process.hrtime.bigint() - t) / 1e6); }
  const sorted = [...times].sort((a, b) => a - b);
  const max = sorted[N - 1];
  const p99 = sorted[Math.floor(0.99 * N)];
  const avg = times.reduce((a, b) => a + b, 0) / N;
  const aggregate = avg * N;
  console.log(`[P2.5] buildPlaylistPayload x${N}: avg=${avg.toFixed(3)}ms p99=${p99.toFixed(3)}ms max=${max.toFixed(3)}ms aggregate=${aggregate.toFixed(1)}ms (awaited, sequential)`);

  // Per-call is the real unit — far under 50ms. An awaited call includes DB wait time
  // (which yields, it doesn't block), so a single stray DB hiccup is not a regression:
  // the 50ms budget applies to the 99th percentile; the strict max is on the loop below.
  assert.ok(p99 < 50, `single build p99 ${p99.toFixed(2)}ms < 50ms invariant`);
  assert.ok(avg < 5, `single build avg ${avg.toFixed(3)}ms is cheap`);

  // The fleet-wide reconnect itself: all N builds in flight at once. The event loop must
  // never be blocked for ~50ms (a 1ms ticker's largest gap = the worst synchronous block).
  let maxGap = 0, last = Date.now();
  const ticker = setInterval(() => { const n = Date.now(); maxGap = Math.max(maxGap, n - last); last = n; }, 1);
  const built = await Promise.all(Array.from({ length: N }, () => buildPlaylistPayload(DEV)));
  clearInterval(ticker);
  console.log(`[P2.5] ${N} concurrent builds: max event-loop gap ${maxGap}ms`);
  assert.ok(built.every((p) => p.assignments.length === 200), 'every concurrent build is complete');
  assert.ok(maxGap < 50, `a fleet-wide burst never blocks the loop for 50ms (max gap ${maxGap}ms)`);
});
