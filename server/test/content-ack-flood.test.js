'use strict';

// #143 integration — a device cycling DIFFERENT content ids at high rate (the case
// dedup misses) is rate-limited; an under-budget device passes every ack. Observed
// via the server log: passing acks log `Device <id> content <cid>: ready`; over-
// budget drops are silent except ONE `[content-ack] shedding device <id>` line.
// Normal band (default lag thresholds). Server via test/helpers/spawn-server.js.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const ioClient = require('socket.io-client');
const { startServer } = require('./helpers/spawn-server');

let srv, BASE;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

before(async () => {
  srv = await startServer({ name: 'content-ack-flood', env: {
    CONTENT_ACK_MAX_PER_WINDOW: '5', CONTENT_ACK_RATE_WINDOW_MS: '10000', CONTENT_ACK_DEDUP_MS: '50',
  } });
  BASE = srv.base;
});
after(async () => { if (srv) await srv.stop(); });

function provision() {
  const code = String(crypto.randomInt(100000, 1000000));
  return new Promise((resolve) => {
    const sock = ioClient(`${BASE}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
    sock.on('connect', () => sock.emit('device:register', { pairing_code: code }));
    sock.on('device:registered', (d) => { try { sock.close(); } catch { /* */ } resolve({ id: d.device_id, token: d.device_token }); });
    setTimeout(() => resolve(null), 4000);
  });
}
function openRegistered(dev) {
  return new Promise((resolve, reject) => {
    const sock = ioClient(`${BASE}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
    sock.on('connect', () => sock.emit('device:register', { device_id: dev.id, device_token: dev.token, device_info: { app_version: 'test' } }));
    sock.on('device:registered', () => resolve(sock));
    sock.on('device:auth-error', () => reject(new Error('auth-error')));
    setTimeout(() => reject(new Error('register timeout')), 4000);
  });
}
const linesFor = (id, needle) => srv.output().split('\n').filter(l => l.includes(id) && l.includes(needle)).length;
// The same predicate as linesFor (one line containing both id and needle), as a regex.
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const lineRe = (id, needle) => new RegExp(`[^\\n]*(?:${esc(id)}[^\\n]*${esc(needle)}|${esc(needle)}[^\\n]*${esc(id)})`);
// Waits until `re` has matched n times in the server output (srv.waitForOutput's error,
// with the output tail, if not within ms).
const waitForCount = (re, n, ms = 5000) => srv.waitForOutput(new RegExp(`(?:${re.source}[\\s\\S]*?){${n}}`, re.flags.replace('g', '')), ms);

test('#143: cycling 4 different content ids at high rate is rate-limited (dedup misses it)', async () => {
  const dev = await provision();
  assert.ok(dev, 'provisioned');
  const sock = await openRegistered(dev);
  const ids = ['a', 'b', 'c', 'd'];
  // 15 acks, ~100ms apart -> each id repeats every ~400ms (> 50ms dedup) so dedup
  // never fires; budget is 5/10s, so only 5 pass and the rest are shed.
  for (let i = 0; i < 15; i++) { sock.emit('device:content-ack', { device_id: dev.id, content_id: ids[i % 4], status: 'ready' }); await sleep(100); }
  await sleep(400);
  try { sock.close(); } catch { /* */ }

  // The budget's lines and the shed-start line must APPEAR: wait for them, then count
  // exactly as before (the sleeps above are still the settle time for "no more than").
  await waitForCount(lineRe(dev.id, 'content '), 5);
  await waitForCount(lineRe(dev.id, 'shedding device'), 1);
  const passed = linesFor(dev.id, 'content ');     // `Device <id> content <cid>: ready`
  const shedStart = linesFor(dev.id, 'shedding device');
  assert.equal(passed, 5, `exactly the budget (5) passed/logged, got ${passed}`);
  assert.ok(shedStart >= 1, 'a single shed-start line was logged when flood control engaged');
  assert.ok(shedStart === 1, `shed-start logged ONCE per window (no per-drop flood), got ${shedStart}`);
});

test('a device under budget has every ack processed', async () => {
  const dev = await provision();
  const sock = await openRegistered(dev);
  for (const id of ['p', 'q', 'r', 's']) { sock.emit('device:content-ack', { device_id: dev.id, content_id: id, status: 'ready' }); await sleep(60); }
  await sleep(300);
  try { sock.close(); } catch { /* */ }
  // All 4 must APPEAR - and the 4th is also the later marker before "no shedding".
  await waitForCount(lineRe(dev.id, 'content '), 4);
  assert.equal(linesFor(dev.id, 'content '), 4, 'all 4 under-budget acks processed');
  assert.equal(linesFor(dev.id, 'shedding device'), 0, 'no shedding for an under-budget device');
});
