'use strict';

// Ref 2 Stage 1: lib/tls-policy.js - the TLS 1.2 floor and HSTS-only-over-TLS,
// over REAL TLS handshakes against a local https server built from the same
// buildSslOptions() server.js uses (fixture cert: test/fixtures/tls/).
//
// Proving a rejection is the SERVER's doing: modern OpenSSL clients refuse
// TLS 1.0/1.1 on their own at the default security level, which would make a
// naive "1.1 fails" test pass for the wrong reason. So the legacy client here
// opts into SECLEVEL=0, and a CONTROL server (no pin, floor lowered) is shown
// to complete a TLS 1.0/1.1 handshake with that very client first. Also, the
// process-wide tls.DEFAULT_MIN_VERSION is lowered to TLSv1 for the pinned
// server (what `node --tls-min-v1.0` does), proving the explicit minVersion -
// not Node's default - is what holds the line.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const tls = require('node:tls');
const https = require('node:https');
const http = require('node:http');
const express = require('express');

const { buildSslOptions, hstsWhenSecure, MIN_TLS_VERSION } = require('../lib/tls-policy');

const FIX = path.join(__dirname, 'fixtures', 'tls');
const cert = fs.readFileSync(path.join(FIX, 'cert.pem'));
const key = fs.readFileSync(path.join(FIX, 'key.pem'));
const LEGACY_CIPHERS = 'DEFAULT@SECLEVEL=0';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
function close(server) { return new Promise((resolve) => server.close(resolve)); }

// Resolves { ok: true, protocol } on a completed handshake, { ok: false, code } otherwise.
function handshake(port, { minVersion, maxVersion }) {
  return new Promise((resolve) => {
    const sock = tls.connect({
      host: '127.0.0.1', port, servername: 'localhost', ca: cert,
      minVersion, maxVersion, ciphers: LEGACY_CIPHERS,
    });
    sock.once('secureConnect', () => { const protocol = sock.getProtocol(); sock.end(); resolve({ ok: true, protocol }); });
    sock.once('error', (e) => resolve({ ok: false, code: e.code || e.message }));
  });
}

let pinned, pinnedPort, control, controlPort;
const savedDefaultMin = tls.DEFAULT_MIN_VERSION;

test.before(async () => {
  tls.DEFAULT_MIN_VERSION = 'TLSv1'; // simulate `node --tls-min-v1.0`
  const ok = (req, res) => res.end('ok');
  // Legacy ciphers on both so the ONLY thing refusing old protocols is minVersion.
  pinned = https.createServer({ ...buildSslOptions({ cert, key }), ciphers: LEGACY_CIPHERS }, ok);
  control = https.createServer({ cert, key, minVersion: 'TLSv1', ciphers: LEGACY_CIPHERS }, ok);
  pinnedPort = await listen(pinned);
  controlPort = await listen(control);
});

test.after(async () => {
  tls.DEFAULT_MIN_VERSION = savedDefaultMin;
  await close(pinned); await close(control);
});

test('buildSslOptions pins minVersion TLSv1.2 and passes cert/key through', () => {
  assert.equal(MIN_TLS_VERSION, 'TLSv1.2');
  const o = buildSslOptions({ cert, key });
  assert.equal(o.minVersion, 'TLSv1.2');
  assert.equal(o.cert, cert); assert.equal(o.key, key);
});

test('control: the legacy client CAN complete TLS 1.0 and 1.1 against an unpinned server', async () => {
  for (const v of ['TLSv1', 'TLSv1.1']) {
    const r = await handshake(controlPort, { minVersion: v, maxVersion: v });
    assert.deepEqual(r, { ok: true, protocol: v }, `control ${v}: ${JSON.stringify(r)}`);
  }
});

test('pinned server REJECTS TLS 1.0 and 1.1 even with the process default lowered to TLSv1', async () => {
  for (const v of ['TLSv1', 'TLSv1.1']) {
    const r = await handshake(pinnedPort, { minVersion: v, maxVersion: v });
    assert.equal(r.ok, false, `pinned ${v} unexpectedly negotiated ${r.protocol}`);
  }
});

test('pinned server ACCEPTS TLS 1.2 and 1.3', async () => {
  for (const v of ['TLSv1.2', 'TLSv1.3']) {
    const r = await handshake(pinnedPort, { minVersion: v, maxVersion: v });
    assert.deepEqual(r, { ok: true, protocol: v });
  }
});

// ---------------------------------------------------------------- HSTS

function hstsApp({ trustProxy } = {}) {
  const app = express();
  if (trustProxy) app.set('trust proxy', trustProxy);
  app.use(hstsWhenSecure());
  app.get('/', (req, res) => res.send('ok'));
  return app;
}
function get(url, { headers = {}, agent } = {}) {
  const mod = url.startsWith('https:') ? https : http;
  return new Promise((resolve, reject) => {
    mod.get(url, { headers, agent, ca: cert, servername: 'localhost' }, (res) => { res.resume(); res.on('end', () => resolve(res)); }).on('error', reject);
  });
}

test('HSTS is sent over HTTPS (the hasSsl case), with the prior max-age/includeSubDomains', async () => {
  const s = https.createServer(buildSslOptions({ cert, key }), hstsApp());
  const port = await listen(s);
  try {
    const res = await get(`https://127.0.0.1:${port}/`);
    assert.equal(res.headers['strict-transport-security'], 'max-age=31536000; includeSubDomains');
  } finally { await close(s); }
});

test('HSTS is NOT sent over plain HTTP (self-hosted LAN), and plain HTTP still serves', async () => {
  const s = http.createServer(hstsApp());
  const port = await listen(s);
  try {
    const res = await get(`http://127.0.0.1:${port}/`);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['strict-transport-security'], undefined);
  } finally { await close(s); }
});

test('HSTS IS sent behind a TRUSTED TLS-terminating proxy (X-Forwarded-Proto: https) - the Cloudflare case', async () => {
  const s = http.createServer(hstsApp({ trustProxy: 'loopback' }));
  const port = await listen(s);
  try {
    const res = await get(`http://127.0.0.1:${port}/`, { headers: { 'X-Forwarded-Proto': 'https' } });
    assert.equal(res.headers['strict-transport-security'], 'max-age=31536000; includeSubDomains');
  } finally { await close(s); }
});

test('HSTS is NOT sent when X-Forwarded-Proto comes from an UNTRUSTED source', async () => {
  const s = http.createServer(hstsApp()); // no trust proxy
  const port = await listen(s);
  try {
    const res = await get(`http://127.0.0.1:${port}/`, { headers: { 'X-Forwarded-Proto': 'https' } });
    assert.equal(res.headers['strict-transport-security'], undefined);
  } finally { await close(s); }
});
