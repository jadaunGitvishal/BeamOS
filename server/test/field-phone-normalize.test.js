'use strict';

// Ref 43 — phone canonicalization (lib/field-phone.js) + the write path
// (auth.js PUT /me) + the login lookup (field-auth.js) all agreeing on one
// stored E.164 form. Closes the India-format gap found in Stage B1 live testing:
// a bare 10-digit number never matched the stored "+91…" value.
//
// In-memory sqlite, real routers mounted as server.js mounts them.

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

process.env.JWT_SECRET = 'test-secret-field-phone';
process.env.FIELD_AUTH_DEFAULT_CC = '91';

// ---------------- pure unit: normalizePhone ----------------
const { normalizePhone } = require('../lib/field-phone');

test('all 5 real-world Indian formats canonicalize to the identical E.164', () => {
  const forms = ['+919876543210', '919876543210', '9876543210', '+91 98765 43210', '09876543210'];
  for (const f of forms) {
    assert.equal(normalizePhone(f), '+919876543210', `"${f}" should normalize to +919876543210`);
  }
});

test('an explicit "+" international number keeps its own country code (never gets 91 prepended)', () => {
  assert.equal(normalizePhone('+447911123456'), '+447911123456');
  assert.equal(normalizePhone('+44 7911 123456'), '+447911123456');
  assert.equal(normalizePhone('+15551230000'), '+15551230000');
  assert.equal(normalizePhone('+1 (555) 123-0000'), '+15551230000');
});

test('a bare 10-digit number that merely STARTS with the CC digits still gets the CC prepended', () => {
  // "9198765432" is a valid 10-digit Indian mobile that begins 91 — must NOT be
  // read as country-code 91 + an 8-digit national number.
  assert.equal(normalizePhone('9198765432'), '+919198765432');
});

test('leading zeros / international access code are handled', () => {
  assert.equal(normalizePhone('09876543210'), '+919876543210');
  assert.equal(normalizePhone('00919876543210'), '+919876543210');
});

test('garbage / too-short input is rejected (null)', () => {
  assert.equal(normalizePhone('not-a-phone'), null);
  assert.equal(normalizePhone(''), null);
  assert.equal(normalizePhone('   '), null);
  assert.equal(normalizePhone('12345'), null);
  assert.equal(normalizePhone(null), null);
  assert.equal(normalizePhone(undefined), null);
});

test('the CC is configurable per call', () => {
  assert.equal(normalizePhone('5551234567', '1'), '+15551234567');
  assert.equal(normalizePhone('+447911123456', '1'), '+447911123456'); // explicit + wins
});

// ---------------- integration: write path + login lookup ----------------
const db = new Database(':memory:');
db.function('UNIX_TIMESTAMP', () => Math.floor(Date.now() / 1000));
db.exec(`
  CREATE TABLE users (
    id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT DEFAULT '',
    password_hash TEXT, auth_provider TEXT NOT NULL DEFAULT 'local', avatar_url TEXT,
    role TEXT NOT NULL DEFAULT 'user', plan_id TEXT DEFAULT 'free', email_alerts INTEGER DEFAULT 1,
    must_change_password INTEGER NOT NULL DEFAULT 0, phone TEXT UNIQUE, last_login INTEGER,
    updated_at INTEGER DEFAULT 0
  );
  CREATE TABLE workspace_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT, user_id TEXT, role TEXT, joined_at INTEGER DEFAULT 0
  );
  CREATE TABLE organization_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT, organization_id TEXT, user_id TEXT, role TEXT
  );
`);
const dbModulePath = require.resolve('../db/database');
require.cache[dbModulePath] = { id: dbModulePath, filename: dbModulePath, loaded: true, exports: { db } };

const express = require('express');
const { generateToken, requireAuth } = require('../middleware/auth');

db.prepare("INSERT INTO users (id,email,role) VALUES ('u-tech','tech@t.test','user')").run();
db.prepare("INSERT INTO users (id,email,role,phone) VALUES ('u-other','other@t.test','user','+919999900000')").run();

const app = express();
app.use(express.json());
app.use('/api/auth', require('../routes/auth'));
app.use('/api/field-auth', require('../routes/field-auth'));
app.use((err, req, res, _next) => { res.status(500).json({ error: err.message }); });
const server = app.listen(0);
let base;
test.before(async () => {
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); db.close(); });

const call = (method, path, token, body) =>
  fetch(base + path, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const techTok = generateToken({ id: 'u-tech', email: 'tech@t.test', role: 'user' }, null);

test('write path: PUT /api/auth/me stores the phone CANONICALIZED, not as typed', async () => {
  const r = await call('PUT', '/api/auth/me', techTok, { phone: '09876543210' }); // messy input
  assert.equal(r.status, 200);
  assert.equal((await r.json()).phone, '+919876543210');
  assert.equal(db.prepare("SELECT phone FROM users WHERE id='u-tech'").get().phone, '+919876543210');
});

test('login then works with EVERY format, because both sides canonicalized', async () => {
  for (const fmt of ['+919876543210', '919876543210', '9876543210', '+91 98765 43210', '09876543210']) {
    const v = await call('POST', '/api/field-auth/verify-otp', null, { phone: fmt, code: '123456' });
    assert.equal(v.status, 200, `login with "${fmt}" should succeed`);
    assert.equal((await v.json()).user.id, 'u-tech');
  }
});

test('write path: a bad phone is rejected 400; a collision is rejected 409', async () => {
  assert.equal((await call('PUT', '/api/auth/me', techTok, { phone: 'xyz' })).status, 400);
  assert.equal((await call('PUT', '/api/auth/me', techTok, { phone: '9999900000' })).status, 409); // u-other has +919999900000
});

test('write path: "" clears the phone', async () => {
  assert.equal((await call('PUT', '/api/auth/me', techTok, { phone: '' })).status, 200);
  assert.equal(db.prepare("SELECT phone FROM users WHERE id='u-tech'").get().phone, null);
});
