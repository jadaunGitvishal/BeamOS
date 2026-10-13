'use strict';

// Fingerprint-reclaim ERROR path (ws/deviceSocket.js). A DB error part-way through a
// reclaim used to be logged and swallowed, and the handler then fell through to the
// new-device pairing path: a second (ghost) devices row, a second device:registered for
// it, and - when it failed after registerConnection - a stale incumbent entry for the
// old device that deferred its next reclaim as "recently active".
//
// Each case spawns a REAL server.js with test/helpers/fail-query.js preloaded, making ONE
// statement of the reclaim reject (matched by SQL text + the seeded device id, which is
// generated before the server starts), then checks what the device and the DB see:
//  1. the token UPDATE fails            (before anything was sent to the device)
//  2. the status='online' UPDATE fails  (after this socket became the incumbent)
//  3. the dashboard's workspace lookup fails (after device:registered was sent)
// Real MySQL test DB (beamos_test via npm test); the devices, fingerprints and status
// rows are test-owned and removed afterwards.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const ioClient = require('socket.io-client');
const { db } = require('../db/database');
const { randTag } = require('./helpers/disposable');
const { startServer } = require('./helpers/spawn-server');

const HELPER = path.join(__dirname, 'helpers', 'fail-query.js');
const created = { deviceIds: new Set(), fingerprints: [], pairingCodes: [] };
const rnd = () => {
  const code = String(crypto.randomInt(100000, 1000000));
  created.pairingCodes.push(code);
  return code;
};

after(async () => {
  try {
    // Ghost rows a failing (pre-fix) run may have created for our pairing codes.
    for (const code of created.pairingCodes) {
      const rows = await db.prepare('SELECT id FROM devices WHERE pairing_code = ?').all(code);
      for (const r of rows) created.deviceIds.add(r.id);
    }
    for (const fp of created.fingerprints) await db.prepare('DELETE FROM device_fingerprints WHERE fingerprint = ?').run(fp);
    for (const id of created.deviceIds) {
      await db.prepare('DELETE FROM device_status_log WHERE device_id = ?').run(id);
      await db.prepare('DELETE FROM devices WHERE id = ?').run(id);
    }
  } finally {
    await db.close();
  }
});

// A device gone by every runtime signal (offline, ~27h stale heartbeat, no socket), so a
// reclaim passes the liveness gate.
async function seedDevice(id, fp) {
  await db.prepare("INSERT INTO devices (id, status, last_heartbeat, device_token) VALUES (?, 'offline', UNIX_TIMESTAMP() - 99999, 'tok')").run(id);
  created.deviceIds.add(id);
  await db.prepare('INSERT INTO device_fingerprints (fingerprint, device_id) VALUES (?, ?)').run(fp, id);
  created.fingerprints.push(fp);
}

// One register on a fresh socket. Records every device:registered, auth-error and
// server:error, and how the socket ended. Settles when the server closes the socket, or
// after `ms` (the pre-fix behaviour never closes it); `keep` leaves an open socket open.
function attempt(base, payload, { ms = 3000, keep = false } = {}) {
  return new Promise((resolve) => {
    const sock = ioClient(`${base}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
    const got = { sock, registered: [], authErrors: [], serverErrors: [], disconnectReason: null };
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      if (!keep) { try { sock.close(); } catch { /* */ } }
      resolve(got);
    };
    sock.on('connect', () => sock.emit('device:register', payload));
    sock.on('device:registered', (d) => { got.registered.push(d); if (keep) setTimeout(finish, 300); });
    sock.on('device:auth-error', (e) => { got.authErrors.push(e && e.error); finish(); });
    sock.on('server:error', (e) => got.serverErrors.push(e));
    sock.on('disconnect', (reason) => { got.disconnectReason = reason; finish(); });
    setTimeout(finish, ms);
  });
}

const CASES = [
  { name: 'token UPDATE fails', sql: 'SET device_token = ?', afterEmit: false },
  { name: "status='online' UPDATE fails", sql: "SET status = 'online'", afterEmit: false },
  { name: 'workspace lookup fails after device:registered', sql: 'SELECT workspace_id FROM devices', afterEmit: true },
];

for (const c of CASES) {
  test(`reclaim error: ${c.name} -> no ghost device, socket closed, clean retry`, async () => {
    const id = crypto.randomUUID();
    const fp = `fp-err-${randTag()}`;
    await seedDevice(id, fp);
    const srv = await startServer({
      name: 'fingerprint-reclaim-errors',
      nodeArgs: ['--require', HELPER],
      env: { FAIL_QUERY_SQL: c.sql, FAIL_QUERY_ID: id },
    });
    const sockets = [];
    try {
      const code = rnd();
      const r = await attempt(srv.base, { pairing_code: code, fingerprint: fp }); // no device_id -> reclaim path
      sockets.push(r.sock);
      assert.match(srv.output(), /\[fail-query\] failing /, 'the injected failure fired');

      // No ghost: the failed reclaim must not fall through to the new-device pairing path.
      const ghost = await db.prepare('SELECT id FROM devices WHERE pairing_code = ?').all(code);
      assert.deepEqual(ghost, [], 'no devices row for the attempt\'s pairing_code');
      assert.doesNotMatch(srv.output(), /New device registered/, 'no "New device registered" line');

      // The device is only ever told its OWN identity.
      for (const reg of r.registered) assert.equal(reg.device_id, id, 'device:registered never carries a different device_id');
      assert.equal(r.registered.length, c.afterEmit ? 1 : 0, c.afterEmit ? 'registered once (before the failure)' : 'never registered');

      // The server closes the socket (server:error first, like protectSocket).
      assert.equal(r.disconnectReason, 'io server disconnect', 'the server closed the socket');
      assert.equal(r.serverErrors.length, 1, 'one server:error notice');

      // Immediate retry: cases 1-2 reclaim again with a fresh pairing code; case 3 already
      // holds its id + token, so it reconnects through the normal device_id path.
      const retryPayload = c.afterEmit
        ? { device_id: id, device_token: r.registered[0].device_token, device_info: {} }
        : { pairing_code: rnd(), fingerprint: fp };
      const retry = await attempt(srv.base, retryPayload, { keep: true });
      sockets.push(retry.sock);
      assert.deepEqual(retry.authErrors, [], 'retry is not refused (no "recently active" deferral)');
      assert.equal(retry.registered.length, 1, 'retry registers');
      assert.equal(retry.registered[0].device_id, id, 'retry gets the SAME device id');
      assert.doesNotMatch(srv.output(), new RegExp(`reclaim deferred for ${id}`), 'no deferral logged');

      const row = await db.prepare('SELECT status FROM devices WHERE id = ?').get(id);
      assert.equal(row.status, 'online', 'the seeded row ends up online');
    } finally {
      for (const s of sockets) { try { s.close(); } catch { /* */ } }
      await srv.stop();
    }
  });
}
