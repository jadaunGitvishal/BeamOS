'use strict';

// #146 — /api/status: always-on live-fleet gauge (devices_connected, from the WS
// connection map) + admin-toggleable debug block. Booted server + JWT + DB access.
//
// Spawns a REAL server.js subprocess (genuine socket.io connection-map state - not
// fakeable in-process) against the real MySQL database, with disposable-ID +
// cleanup discipline (test/helpers/disposable.js) plus explicit snapshot/restore
// of the real, GLOBAL status_debug_enabled app_settings row this file toggles -
// unlike a disposable row, that setting isn't owned by this test and must be put
// back exactly as found, not just deleted or assumed to start ON (a prior
// interrupted run - or any other admin action against the shared database - can
// leave it OFF, which would otherwise silently break this file's own "present by
// default" assertion for a reason unrelated to anything it's testing).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const ioClient = require('socket.io-client');
const { db } = require('../db/database');
const { cleanupUsers, cleanupDevices } = require('./helpers/disposable');

const PORT = 3998;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = path.join(os.tmpdir(), 'st-statusdbg-' + crypto.randomBytes(4).toString('hex'));
const LOG = path.join(os.tmpdir(), 'st-statusdbg-' + crypto.randomBytes(4).toString('hex') + '.log');
let proc;
let priorDebugSetting;
const created = { userIds: [], deviceIds: [] };

before(async () => {
  const existing = await db.prepare("SELECT value FROM app_settings WHERE `key` = 'status_debug_enabled'").get();
  priorDebugSetting = existing ? existing.value : null;
  // This file's own tests exercise BOTH states (default-on assertion, then the
  // admin toggle) - start from a known baseline (ON) rather than whatever a
  // previous run left behind.
  await db.prepare("INSERT INTO app_settings (`key`, value) VALUES ('status_debug_enabled', 'true') ON DUPLICATE KEY UPDATE value = 'true'").run();

  const logFd = fs.openSync(LOG, 'w');
  proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 80; i++) { try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ } await new Promise(r => setTimeout(r, 250)); }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));
});
after(async () => {
  try { proc.kill('SIGKILL'); } catch { /* */ }
  for (const f of [DATA_DIR, LOG]) { try { fs.rmSync(f, { recursive: true, force: true }); } catch { /* */ } }
  if (priorDebugSetting === null) await db.prepare("DELETE FROM app_settings WHERE `key` = 'status_debug_enabled'").run();
  else await db.prepare("UPDATE app_settings SET value = ? WHERE `key` = 'status_debug_enabled'").run(priorDebugSetting);
  await cleanupDevices(db, created.deviceIds);
  await cleanupUsers(db, created.userIds);
  await db.close();
});

const status = async () => (await fetch(BASE + '/api/status')).json();
const reg = (o) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });
const put = (tok, o) => ({ method: 'PUT', headers: tok ? { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });

test('devices_connected is always present, numeric, and reflects the LIVE socket map', async () => {
  const b = await status();
  assert.equal(typeof b.devices_connected, 'number', 'devices_connected always present + numeric');
  const before = b.devices_connected;

  // open a real device socket -> the connection map (and the count) must move
  const s = ioClient(`${BASE}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
  const registeredId = await new Promise((resolve) => {
    let id = null;
    s.on('connect', () => s.emit('device:register', { pairing_code: String(crypto.randomInt(100000, 1000000)) }));
    s.on('device:registered', (d) => { id = d.device_id; resolve(id); });
    setTimeout(() => resolve(id), 3000);
  });
  if (registeredId) created.deviceIds.push(registeredId);
  await new Promise(r => setTimeout(r, 150));
  const during = (await status()).devices_connected;
  assert.ok(during >= before + 1, `devices_connected rose with a live socket (${before} -> ${during})`);
  try { s.close(); } catch { /* */ }
});

test('debug block: present by default (env), and gated by the admin flag', async () => {
  // default (no env override, and this file's own before() forced the row to
  // 'true' as a known baseline) -> ON
  let b = await status();
  assert.ok(b.debug, 'debug present by default');
  assert.equal(typeof b.debug.flap.buckets, 'number');

  // register an admin + a normal user; promote the admin in the DB (role read from DB).
  const adminEmail = `statusdbg-ad-${crypto.randomBytes(4).toString('hex')}@x.local`;
  const userEmail = `statusdbg-u-${crypto.randomBytes(4).toString('hex')}@x.local`;
  const adminReg = await (await fetch(BASE + '/api/auth/register', reg({ email: adminEmail, password: 'Passw0rd123' }))).json();
  const userReg = await (await fetch(BASE + '/api/auth/register', reg({ email: userEmail, password: 'Passw0rd123' }))).json();
  created.userIds.push(adminReg.user.id, userReg.user.id);
  const adminTok = adminReg.token, userTok = userReg.token;
  await db.prepare("UPDATE users SET role = 'platform_admin' WHERE email = ?").run(adminEmail);

  // non-admin cannot flip it
  assert.equal((await fetch(BASE + '/api/admin/status-debug', put(userTok, { enabled: false }))).status, 403, 'non-admin denied');
  // unauthenticated cannot flip it
  assert.equal((await fetch(BASE + '/api/admin/status-debug', put(null, { enabled: false }))).status, 401, 'anon denied');

  // admin flips OFF -> debug omitted; loop_lag + devices_connected remain
  const off = await fetch(BASE + '/api/admin/status-debug', put(adminTok, { enabled: false }));
  assert.equal(off.status, 200);
  b = await status();
  assert.equal('debug' in b, false, 'debug key omitted entirely when off');
  assert.ok(b.loop_lag, 'loop_lag still present when debug off');
  assert.equal(typeof b.devices_connected, 'number', 'devices_connected still present when debug off');

  // admin flips ON -> debug back, no restart
  assert.equal((await fetch(BASE + '/api/admin/status-debug', put(adminTok, { enabled: true }))).status, 200);
  b = await status();
  assert.ok(b.debug, 'debug back on after re-enable, no restart');
});
