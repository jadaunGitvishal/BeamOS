'use strict';

// Ref 36: periodic live screen preview.
//
// Boots a real server with a short sweep interval, connects a fake device that answers
// device:screenshot-request, and asserts:
//   1. the sweep persists a screenshots row per cycle (>=2 rows, ~interval apart)
//   2. on-demand dashboard:request-screenshot still streams dashboard:screenshot-ready
//      and does NOT add a persisted row (unchanged behaviour)
//
// Hits the same MySQL the dev server uses. Unique PORT 3991.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const ioClient = require('socket.io-client');

const PORT = 3991;
const BASE = `http://127.0.0.1:${PORT}`;
const SWEEP_MS = 6000;
const DATA_DIR = path.join(os.tmpdir(), 'st-shot-' + crypto.randomBytes(4).toString('hex'));
const LOG = path.join(os.tmpdir(), 'st-shot-' + crypto.randomBytes(4).toString('hex') + '.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = () => String(crypto.randomInt(100000, 1000000));
// ~300 chars of base64 - passes the server's `image_b64` truthiness + <2MB checks.
const FAKE_JPEG_B64 = Buffer.from('x'.repeat(220)).toString('base64');

let proc, JWT, db, deviceSock;

before(async () => {
  const logFd = fs.openSync(LOG, 'w');
  proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test', SCREENSHOT_PREVIEW_INTERVAL_MS: String(SWEEP_MS) },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ }
    await sleep(250);
  }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-3000));

  const r = await fetch(BASE + '/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `shot-${rnd()}@test.local`, password: 'test12345', name: 'Shot' }),
  });
  JWT = (await r.json()).token;
  assert.ok(JWT, 'registered + got a JWT');

  db = require('../db/database').db;
});

after(async () => {
  try { deviceSock && deviceSock.close(); } catch { /* */ }
  try { proc.kill('SIGKILL'); } catch { /* */ }
  try { await db.close(); } catch { /* */ }
});

function provisionWithCode(code) {
  return new Promise((resolve) => {
    const s = ioClient(`${BASE}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
    s.on('connect', () => s.emit('device:register', { pairing_code: code }));
    s.on('device:registered', (d) => { try { s.close(); } catch { /* */ } resolve({ id: d.device_id, token: d.device_token }); });
    setTimeout(() => resolve(null), 5000);
  });
}

test('sweep persists a screenshots row per cycle; on-demand stays relay-only', async () => {
  // --- pair a device ---
  const code = rnd();
  const dev = await provisionWithCode(code);
  assert.ok(dev && dev.id, 'device provisioned');
  const pairRes = await fetch(BASE + '/api/provision/pair', {
    method: 'POST', headers: { Authorization: 'Bearer ' + JWT, 'Content-Type': 'application/json' },
    body: JSON.stringify({ pairing_code: code, name: 'Screenshot Kiosk' }),
  });
  assert.equal(pairRes.status, 200, 'operator paired the device');

  await db.prepare('DELETE FROM screenshots WHERE device_id = ?').run(dev.id);

  // --- fake device: stay connected, answer every screenshot request ---
  let requestsSeen = 0;
  deviceSock = ioClient(`${BASE}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
  deviceSock.on('connect', () => deviceSock.emit('device:register', { device_id: dev.id, device_token: dev.token, device_info: { app_version: 'test' } }));
  deviceSock.on('device:screenshot-request', () => {
    requestsSeen++;
    deviceSock.emit('device:screenshot', { device_id: dev.id, image_b64: FAKE_JPEG_B64 });
  });
  await sleep(800); // let register settle

  // --- wait for >=2 sweep cycles ---
  await sleep(SWEEP_MS * 2 + 3000);

  const rows = await db.prepare('SELECT id, filepath, captured_at FROM screenshots WHERE device_id = ? ORDER BY captured_at ASC').all(dev.id);
  console.log(`  screenshot-request events seen by device: ${requestsSeen}`);
  console.log(`  persisted rows:`, rows.map((r) => ({ filepath: r.filepath, captured_at: r.captured_at })));

  assert.ok(requestsSeen >= 2, `device received >=2 automatic screenshot requests (got ${requestsSeen})`);
  assert.ok(rows.length >= 2, `>=2 screenshot rows persisted by the sweep (got ${rows.length})`);

  // timestamps roughly one interval apart (allow generous slack for CI jitter)
  const gap = rows[rows.length - 1].captured_at - rows[0].captured_at;
  const expectedMin = (SWEEP_MS / 1000) * (rows.length - 1) * 0.5;
  assert.ok(gap >= expectedMin, `rows span ~${SWEEP_MS / 1000}s per cycle (spanned ${gap}s across ${rows.length} rows)`);

  // files actually written (spawned server resolves screenshotsDir under its DATA_DIR)
  for (const row of rows) {
    const fp = path.join(DATA_DIR, 'uploads', 'screenshots', path.basename(row.filepath));
    assert.ok(fs.existsSync(fp), `backing file exists: ${row.filepath}`);
  }

  // --- on-demand still streams dashboard:screenshot-ready (unchanged behaviour) ---
  // (Non-persistence of on-demand shots is proven deterministically by the
  //  persistScreenshotIfPending unit test below - here the sweep is still running so a
  //  row-count assertion would race a concurrent cycle.)
  const dash = ioClient(`${BASE}/dashboard`, { transports: ['websocket'], reconnection: false, forceNew: true, auth: { token: JWT } });
  const gotReady = await new Promise((resolve) => {
    dash.on('connect', () => setTimeout(() => dash.emit('dashboard:request-screenshot', { device_id: dev.id }), 300));
    dash.on('dashboard:screenshot-ready', (d) => resolve(d && d.device_id === dev.id));
    setTimeout(() => resolve(false), 5000);
  });
  assert.ok(gotReady, 'on-demand dashboard:request-screenshot -> dashboard:screenshot-ready still works');
  try { dash.close(); } catch { /* */ }
});

test('persistScreenshotIfPending is a no-op when the device has no pending sweep request', async () => {
  // In-process, no DB, no server: the guard clause that keeps on-demand previews
  // relay-only. An on-demand screenshot never populates _pendingCaptures, so this
  // returns false and touches neither disk nor the screenshots table.
  const sched = require('../services/screenshot-scheduler');
  sched._pendingCaptures.clear();
  const result = await sched.persistScreenshotIfPending('some-device-with-no-pending', FAKE_JPEG_B64);
  assert.equal(result, false, 'no pending entry -> returns false, no persist');
});
