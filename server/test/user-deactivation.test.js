'use strict';

// Ref 5/8 prerequisite: users.deactivated_at with INSTANT, per-request revocation.
//
// Runs the REAL auth routes + REAL routers + REAL middleware in-process
// (helpers/inprocess-app.js) against the REAL MySQL database, after running the
// real initDb() so lib/schema-check.js's ALTER-if-missing repair adds the new
// column exactly as it will on an existing production database. Every fixture is
// a disposable, randomly-suffixed account removed in after().
//
// The single most important assertion in this Ref is the first test: a session
// JWT issued BEFORE deactivation - still cryptographically valid, still unexpired -
// is refused on the very next request, not at next login.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { PassThrough } = require('node:stream');
const { Server } = require('socket.io');
const ioClient = require('socket.io-client');

const config = require('../config');
const { initDb } = require('../db/database');
const { startInProcessApp } = require('./helpers/inprocess-app');
const { randTag, cleanupUsers } = require('./helpers/disposable');
const { setUserDeactivated } = require('../lib/user-deactivation');
const { generateToken: generateApiToken, hashToken, displayPrefix } = require('../middleware/apiToken');

let app;
const created = [];
// PMI: the placeholder OTP route is off unless FIELD_OTP_ENABLED (dev/test only).
const savedFieldOtp = config.fieldOtpEnabled;

test.before(async () => {
  await initDb(); // applies schema.sql + schema-check repair (adds users.deactivated_at on an existing DB)
  config.fieldOtpEnabled = true;
  app = await startInProcessApp({ only: ['/api/devices'] });
  // field-tech OTP login isn't in the helper's mount list (server.js mounts it
  // directly) - mount the real router here the same way.
  app.app.use('/api/field-auth', require('../routes/field-auth'));
});
test.after(async () => {
  config.fieldOtpEnabled = savedFieldOtp;
  await cleanupUsers(app.db, created);
  await app.stop();
});

const PASSWORD = 'correct-horse-9';
async function register() {
  const email = `deact-${randTag()}@deact.local`;
  const res = await fetch(`${app.base}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, name: 'Deact Test', createOrg: true }),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  created.push(body.user.id);
  return { id: body.user.id, email, token: body.token, workspaceId: body.current_workspace_id };
}
const get = (path, token) => fetch(`${app.base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
const post = (path, body) => fetch(`${app.base}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

test('schema: users.deactivated_at exists after initDb (schema-check repair path) and defaults to NULL', async () => {
  const col = await app.db.prepare(
    "SELECT IS_NULLABLE, COLUMN_DEFAULT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'deactivated_at'",
  ).get();
  assert.ok(col, 'column present');
  assert.equal(col.IS_NULLABLE, 'YES');
  const u = await register();
  const row = await app.db.prepare('SELECT deactivated_at FROM users WHERE id = ?').get(u.id);
  assert.equal(row.deactivated_at, null);
});

test('THE RFP REQUIREMENT: an existing, still-valid session JWT is rejected on the VERY NEXT request after deactivation', async () => {
  const u = await register();
  // The session works - on a JWT-only surface AND a public (bearerAuth) router.
  assert.equal((await get('/api/auth/me', u.token)).status, 200);
  assert.equal((await get('/api/devices', u.token)).status, 200);

  await setUserDeactivated(app.db, u.id, true, { via: 'test' });

  // Same token, no re-login, no expiry elapsed.
  const me = await get('/api/auth/me', u.token);
  assert.equal(me.status, 401);
  assert.deepEqual(await me.json(), { error: 'account_deactivated' });
  assert.equal((await get('/api/devices', u.token)).status, 401);

  // Reactivation restores the SAME session (non-destructive).
  await setUserDeactivated(app.db, u.id, false, { via: 'test' });
  assert.equal((await get('/api/auth/me', u.token)).status, 200);
});

test('setUserDeactivated: idempotent (keeps the original timestamp) and audited once per real change', async () => {
  const u = await register();
  const first = await setUserDeactivated(app.db, u.id, true, { via: 'test' });
  assert.equal(first.changed, true);
  assert.ok(first.deactivated_at > 0);
  const again = await setUserDeactivated(app.db, u.id, true, { via: 'test' });
  assert.equal(again.changed, false);
  assert.equal(again.deactivated_at, first.deactivated_at);
  const logs = await app.db.prepare(
    "SELECT COUNT(*) AS n FROM activity_log WHERE action = 'user:deactivated' AND details LIKE ?",
  ).get(`${u.email}%`);
  assert.equal(Number(logs.n), 1);
  assert.equal((await setUserDeactivated(app.db, 'no-such-user', true)).notFound, true);
});

test('password login: refused with a clear 403 AFTER a correct password; a wrong password still gets the generic 401 (no oracle)', async () => {
  const u = await register();
  await setUserDeactivated(app.db, u.id, true, { via: 'test' });
  const ok = await post('/api/auth/login', { email: u.email, password: PASSWORD });
  assert.equal(ok.status, 403);
  assert.match((await ok.json()).error, /deactivated/);
  const bad = await post('/api/auth/login', { email: u.email, password: 'wrong-password-1' });
  assert.equal(bad.status, 401);
  assert.equal((await bad.json()).error, 'Invalid email or password');
});

test('API token (st_): acts AS its owner, so it dies with the owner\'s deactivation', async () => {
  const u = await register();
  const secret = generateApiToken();
  await app.db.prepare(
    'INSERT INTO api_tokens (id, token_hash, prefix, name, user_id, workspace_id, scope, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, UNIX_TIMESTAMP())',
  ).run(crypto.randomUUID(), hashToken(secret), displayPrefix(secret), 'deact test', u.id, u.workspaceId, 'read');
  assert.equal((await get('/api/devices', secret)).status, 200);
  await setUserDeactivated(app.db, u.id, true, { via: 'test' });
  const res = await get('/api/devices', secret);
  assert.equal(res.status, 401);
  assert.match((await res.json()).error, /deactivated/);
});

test('field-tech OTP login: a deactivated technician gets 403 (after the code check), not a session', async () => {
  const u = await register();
  const phone = `+9199${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
  await app.db.prepare('UPDATE users SET phone = ? WHERE id = ?').run(phone, u.id);
  // PMI: field OTP is technician-only - turn the registered owner into one (the org
  // row keeps owner_user_id, so cleanupUsers still cascades it).
  await app.db.prepare('DELETE FROM workspace_members WHERE user_id = ?').run(u.id);
  await app.db.prepare("UPDATE organization_members SET role = 'field_technician' WHERE user_id = ?").run(u.id);
  await setUserDeactivated(app.db, u.id, true, { via: 'test' });
  const ok = await post('/api/field-auth/verify-otp', { phone, code: '000999' });
  assert.equal(ok.status, 403);
  assert.match((await ok.json()).error, /deactivated/);
  const wrong = await post('/api/field-auth/verify-otp', { phone, code: '123123' });
  assert.equal(wrong.status, 401, 'wrong code is still the uniform 401');
});

test('Microsoft login (tenant-unset Graph path): a deactivated account is refused and NOT mutated', async () => {
  const u = await register();
  // Make it an SSO-shaped account (no password) so the provider-link branch would run.
  await app.db.prepare("UPDATE users SET password_hash = NULL, auth_provider = 'google' WHERE id = ?").run(u.id);
  await setUserDeactivated(app.db, u.id, true, { via: 'test' });

  const savedTenant = config.ssoTenantId;
  const realGet = https.get;
  config.ssoTenantId = '';
  https.get = function (options, cb) {
    if (options && options.hostname === 'graph.microsoft.com') {
      const resp = new PassThrough();
      process.nextTick(() => { cb(resp); resp.end(JSON.stringify({ id: 'g-1', mail: u.email, displayName: 'X' })); });
      return { on() { return this; } };
    }
    return realGet.apply(this, arguments);
  };
  try {
    const res = await post('/api/auth/microsoft', { access_token: 'x' });
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /deactivated/);
    const row = await app.db.prepare('SELECT auth_provider, provider_id FROM users WHERE id = ?').get(u.id);
    assert.equal(row.auth_provider, 'google', 'provider was not re-linked by a refused login');
  } finally {
    https.get = realGet;
    config.ssoTenantId = savedTenant;
  }
});

test('dashboard socket: an OPEN socket is closed at deactivation, and a new handshake is refused', async () => {
  const u = await register();
  const httpServer = http.createServer();
  const io = new Server(httpServer);
  require('../ws/dashboardSocket')(io);
  await new Promise((r) => httpServer.listen(0, r));
  const base = `http://127.0.0.1:${httpServer.address().port}/dashboard`;
  const connect = () => ioClient(base, { auth: { token: u.token }, transports: ['websocket'], reconnection: false, forceNew: true });
  try {
    const sock = connect();
    await new Promise((resolve, reject) => { sock.on('connect', resolve); sock.on('connect_error', reject); });
    const disconnected = new Promise((r) => sock.on('disconnect', r));

    await setUserDeactivated(app.db, u.id, true, { io, via: 'test' });
    assert.equal(await disconnected, 'io server disconnect');

    const again = connect();
    const err = await new Promise((resolve) => {
      again.on('connect', () => resolve(null));
      again.on('connect_error', resolve);
    });
    again.close();
    assert.ok(err, 'handshake refused');
  } finally {
    await new Promise((r) => io.close(r));
  }
});
