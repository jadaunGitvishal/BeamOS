'use strict';

// #144 — HTTP integration: the real /api/update/check endpoint with the breaker wired.
// Proves end-to-end behavior + the device_id passthrough/keying. Rapid requests stay
// within the 60s rate window, so THRESHOLD(3) trips on the 4th. Server (and port) via
// test/helpers/spawn-server.js.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { startServer } = require('./helpers/spawn-server');

let srv, BASE, DATA_DIR, LATEST;
const check = async (version, deviceId) => {
  const q = `version=${encodeURIComponent(version)}` + (deviceId ? `&device_id=${encodeURIComponent(deviceId)}` : '');
  const r = await fetch(`${BASE}/api/update/check?${q}`);
  return r.json();
};

before(async () => {
  // the breaker only reports update_available when an APK actually exists — give the
  // test server a dummy one. lib/apk-cache.js checks DATA_DIR/BeamOS.apk FIRST, so
  // this fake wins over any real repo-root APK. The DATA_DIR has to exist before boot,
  // so this file creates it and passes it in (caller env wins over the helper's own).
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'st-ota-'));
  fs.writeFileSync(path.join(DATA_DIR, 'BeamOS.apk'), Buffer.alloc(1024, 1));
  srv = await startServer({ name: 'ota-check', env: { DATA_DIR } });
  BASE = srv.base;
  LATEST = (await check('0.0.1')).latest_version;   // an ancient version reads back the server's latest
});
after(async () => {
  try { if (srv) await srv.stop(); } finally { if (DATA_DIR) fs.rmSync(DATA_DIR, { recursive: true, force: true }); }
});

test('a device already on latest gets no offer (up-to-date)', async () => {
  const r = await check(LATEST);
  assert.equal(r.update_available, false);
  assert.equal(r.reason, 'up-to-date');
});

test('(a) phantom version (superseded old-core prerelease) -> instant no-offer over HTTP', async () => {
  const r = await check('1.9.1-beta4');
  assert.equal(r.update_available, false);
  assert.equal(r.reason, 'superseded-prerelease');
});

test('(b/f) legacy client (no device_id) looping the same version trips the version-keyed breaker', async () => {
  const v = '1.6.0';                       // fresh offerable older version, no device_id
  const results = [];
  for (let i = 0; i < 5; i++) results.push(await check(v));   // rapid, within the 60s window
  assert.ok(results.slice(0, 3).every(r => r.update_available === true), 'first 3 offered');
  assert.equal(results[3].update_available, false, '4th trips');
  assert.equal(results[3].reason, 'rate-backoff');
  assert.ok(results[3].retry_after_seconds >= 1, 'response carries retry_after_seconds');
});

test('(e) device_id looping is throttled per-device; another device on the same version is unaffected', async () => {
  const v = '1.5.0';
  for (let i = 0; i < 3; i++) await check(v, 'devA');
  const aTrip = await check(v, 'devA');                       // devA 4th -> trips
  assert.equal(aTrip.update_available, false, 'devA throttled');
  const bOk = await check(v, 'devB');                         // devB first check -> offered
  assert.equal(bOk.update_available, true, 'devB (same version, different device) unaffected');
});
