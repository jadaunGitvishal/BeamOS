'use strict';

// #143 Step 2 integration — the global loop-lag pressure valve. Lag thresholds are
// forced to 0 so the band is CRITICAL from the first sample; rate budget is set high
// so we isolate the VALVE (not the per-device rate limit). Under critical: content-
// acks are shed (no log/emit), while a reconnect AND an HTTP/dashboard request still
// process, and the valve edge is logged once. Server via test/helpers/spawn-server.js.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const ioClient = require('socket.io-client');
const { startServer } = require('./helpers/spawn-server');

let srv, BASE;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// Waits until `re` has matched n times in the server output (srv.waitForOutput's error,
// with the output tail, if not within ms).
const waitForCount = (re, n, ms = 5000) => srv.waitForOutput(new RegExp(`(?:${re.source}[\\s\\S]*?){${n}}`, re.flags.replace('g', '')), ms);
const countOf = (re) => (srv.output().match(re) || []).length;   // re must carry the g flag

before(async () => {
  srv = await startServer({ name: 'content-ack-valve', env: {
    LAG_CRITICAL_MS: '1', LAG_ELEVATED_MS: '1', LAG_SAMPLE_INTERVAL_MS: '150', // tiny thresholds (NOT 0 — config uses `|| default`, 0 is falsy) -> band critical immediately
    CONTENT_ACK_MAX_PER_WINDOW: '1000', CONTENT_ACK_RATE_WINDOW_MS: '10000',   // high, so the VALVE is what sheds
  } });
  BASE = srv.base;
  await sleep(600); // let the valve open (>=1 sample at 150ms in the critical band)
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
  return new Promise((resolve) => {
    const sock = ioClient(`${BASE}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
    let done = false; const finish = (v) => { if (!done) { done = true; resolve(v); } };
    sock.on('connect', () => sock.emit('device:register', { device_id: dev.id, device_token: dev.token, device_info: { app_version: 'test' } }));
    sock.on('device:registered', () => finish({ sock, registered: true }));
    sock.on('device:auth-error', () => finish({ sock, registered: false }));
    setTimeout(() => finish({ sock, registered: false }), 4000);
  });
}

test('valve OPEN under critical: content-acks are shed, reconnect + HTTP still process', async () => {
  await srv.waitForOutput(/\[shed\] global valve OPEN/, 5000);   // the valve edge must APPEAR
  const log0 = srv.output();
  assert.ok(/\[shed\] global valve OPEN/.test(log0), 'valve edge logged once on entering critical');

  // 1) content-acks under critical -> shed (no log/emit)
  const dev = await provision();
  const { sock, registered } = await openRegistered(dev);
  assert.ok(registered, 'a device can still register/reconnect under critical (reconnects always processed)');
  for (let i = 0; i < 6; i++) { sock.emit('device:content-ack', { device_id: dev.id, content_id: 'v' + i, status: 'ready' }); await sleep(40); }
  await sleep(300);
  // "None logged" needs a settle point: this socket's disconnect line. Socket.io handles a
  // socket's events in order, so once its disconnect is logged every ack it sent has been
  // processed. Count the device's disconnect lines first (its provisioning socket may
  // already have logged one), then wait for the next.
  const DISCONNECTED = new RegExp(`Device disconnected: ${dev.id}`, 'g');
  const disconnectsBefore = countOf(DISCONNECTED);
  try { sock.close(); } catch { /* */ }
  await waitForCount(DISCONNECTED, disconnectsBefore + 1);
  const contentLines = srv.output().split('\n').filter(l => l.includes(dev.id) && l.includes('content ')).length;
  assert.equal(contentLines, 0, 'all content-acks shed by the valve under critical (none logged/emitted)');

  // 2) a fresh reconnect still registers (reconnects are never shed)
  const dev2 = await provision();
  const r2 = await openRegistered(dev2);
  assert.ok(r2.registered, 'reconnect processed under critical');
  try { r2.sock.close(); } catch { /* */ }

  // 3) HTTP / dashboard path still serves under critical
  const res = await fetch(BASE + '/api/status');
  assert.equal(res.status, 200, 'HTTP/dashboard requests always processed');
  const body = await res.json();
  assert.equal(body.loop_lag.band, 'critical', 'sanity: band really is critical');
});
