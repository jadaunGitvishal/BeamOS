'use strict';

// #142 step 5 — content-ack dedup. Repeated identical (device_id, content_id, status)
// reports are suppressed within config.contentAckDedupMs; a status change or a report
// after the window passes. Observed via the server log (the handler logs+emits only
// when it does NOT dedup). Server via test/helpers/spawn-server.js (fresh port).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const ioClient = require('socket.io-client');
const { startServer } = require('./helpers/spawn-server');

const DEDUP_MS = 600;
let srv, BASE;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// Waits until `re` has matched n times in the server output (srv.waitForOutput's error,
// with the output tail, if not within ms).
const waitForCount = (re, n, ms = 5000) => srv.waitForOutput(new RegExp(`(?:${re.source}[\\s\\S]*?){${n}}`, re.flags.replace('g', '')), ms);

before(async () => {
  srv = await startServer({ name: 'content-ack-dedup', env: { CONTENT_ACK_DEDUP_MS: String(DEDUP_MS) } });
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

test('repeated identical content-acks are deduped; window-expiry and status-change pass', async () => {
  const dev = await provision();
  assert.ok(dev, 'device provisioned');
  const sock = await openRegistered(dev);
  const cid = 'cid-' + crypto.randomBytes(3).toString('hex');

  // 5 rapid identical "ready" within the dedup window -> only ONE should log/emit
  for (let i = 0; i < 5; i++) { sock.emit('device:content-ack', { device_id: dev.id, content_id: cid, status: 'ready' }); await sleep(40); }
  // wait past the window, then "ready" again -> passes (a fresh report)
  await sleep(DEDUP_MS + 250);
  sock.emit('device:content-ack', { device_id: dev.id, content_id: cid, status: 'ready' });
  // a status CHANGE has a different key -> passes immediately
  await sleep(60);
  sock.emit('device:content-ack', { device_id: dev.id, content_id: cid, status: 'error' });
  await sleep(400);
  try { sock.close(); } catch { /* */ }

  // The expected lines must APPEAR: wait for them rather than trusting the sleeps alone,
  // then count exactly as before (the sleeps above are still the settle time).
  const READY = new RegExp(`content ${cid}: ready`, 'g');
  const ERROR = new RegExp(`content ${cid}: error`, 'g');
  await waitForCount(READY, 2);
  await waitForCount(ERROR, 1);
  const log = srv.output();
  const ready = (log.match(READY) || []).length;
  const err = (log.match(ERROR) || []).length;
  assert.equal(ready, 2, 'a burst of identical "ready" collapses to one; a second after the window passes -> 2 total');
  assert.equal(err, 1, 'a status change is not deduped');
});
