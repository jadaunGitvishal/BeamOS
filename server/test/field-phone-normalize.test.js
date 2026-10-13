'use strict';

// Ref 43 — phone canonicalization (lib/field-phone.js) + the write path
// (auth.js PUT /me) + the login lookup (field-auth.js) all agreeing on one
// stored E.164 form. Closes the India-format gap found in Stage B1 live testing:
// a bare 10-digit number never matched the stored "+91…" value.
//
// The integration half runs the REAL routers in-process (helpers/inprocess-app.js:
// /api/auth, plus /api/field-auth mounted as server.js mounts it) against the REAL
// MySQL test DB (beamos_test via npm test). Fixtures are test-owned (fpn- prefix) and
// removed afterwards. Phone numbers are random per run (so no collision with other
// files' rows) but go through exactly the same five real-world formats.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.FIELD_AUTH_DEFAULT_CC = '91';
// PMI: the placeholder OTP route is off unless FIELD_OTP_ENABLED (dev/test only).
process.env.FIELD_OTP_ENABLED = 'true';

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
const config = require('../config');
const { db } = require('../db/database');
const { generateToken } = require('../middleware/auth');
const { startInProcessApp } = require('./helpers/inprocess-app');
const { randTag, cleanupUsers } = require('./helpers/disposable');

const P = `fpn-${randTag()}`;
// A random 10-digit Indian mobile (national significant number) per run, and the
// five ways a person might type it.
const nsn = () => `9${String(crypto.randomInt(0, 1e9)).padStart(9, '0')}`;
const TECH_NSN = nsn();
let OTHER_NSN = nsn();
while (OTHER_NSN === TECH_NSN) OTHER_NSN = nsn();
const E164 = `+91${TECH_NSN}`;
const FORMATS = [E164, `91${TECH_NSN}`, TECH_NSN, `+91 ${TECH_NSN.slice(0, 5)} ${TECH_NSN.slice(5)}`, `0${TECH_NSN}`];

let app;
let tech;
let techTok;
const userIds = [];
const savedFlag = config.fieldOtpEnabled;

async function mkUser(suffix, phone = null) {
  const id = `${P}-${suffix}`;
  const email = `${id}@t.test`;
  await app.db.prepare("INSERT INTO users (id, email, name, password_hash, auth_provider, role, phone) VALUES (?, ?, ?, NULL, 'local', 'user', ?)")
    .run(id, email, id, phone);
  userIds.push(id);
  return { id, email };
}

test.before(async () => {
  app = await startInProcessApp({ only: [] }); // /api/auth
  app.app.use('/api/field-auth', require('../routes/field-auth'));
  config.fieldOtpEnabled = true;
  // Precondition: nobody else in the shared test DB holds these numbers.
  const taken = await app.db.prepare('SELECT COUNT(*) AS n FROM users WHERE phone IN (?, ?)').get(E164, `+91${OTHER_NSN}`);
  assert.equal(Number(taken.n), 0, 'the random test phones are unused');

  // PMI: field OTP is technician-only - the tech holds just an org-wide field_technician row.
  const owner = await mkUser('owner');
  const orgId = crypto.randomUUID();
  await app.db.prepare("INSERT INTO organizations (id, name, owner_user_id, plan_id, subscription_status) VALUES (?, ?, ?, 'enterprise', 'active')")
    .run(orgId, `${P} Org`, owner.id);
  tech = await mkUser('tech');
  await app.db.prepare("INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'field_technician')").run(orgId, tech.id);
  await mkUser('other', `+91${OTHER_NSN}`);
  techTok = generateToken({ id: tech.id, email: tech.email, role: 'user' }, null);
});

test.after(async () => {
  try {
    if (app) {
      config.fieldOtpEnabled = savedFlag;
      // Newest first: the org owner is deletable once the tech's membership is gone.
      await cleanupUsers(app.db, [...userIds].reverse());
    }
  } finally {
    if (app) await app.stop(); else await db.close();
  }
});

const call = (method, path, token, body) =>
  fetch(app.base + path, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const techPhone = async () => (await app.db.prepare('SELECT phone FROM users WHERE id = ?').get(tech.id)).phone;

test('write path: PUT /api/auth/me stores the phone CANONICALIZED, not as typed', async () => {
  const r = await call('PUT', '/api/auth/me', techTok, { phone: `0${TECH_NSN}` }); // messy input
  assert.equal(r.status, 200);
  assert.equal((await r.json()).phone, E164);
  assert.equal(await techPhone(), E164);
});

test('login then works with EVERY format, because both sides canonicalized', async () => {
  for (const fmt of FORMATS) {
    const v = await call('POST', '/api/field-auth/verify-otp', null, { phone: fmt, code: '000999' });
    assert.equal(v.status, 200, `login with "${fmt}" should succeed`);
    assert.equal((await v.json()).user.id, tech.id);
  }
});

test('write path: a bad phone is rejected 400; a collision is rejected 409', async () => {
  assert.equal((await call('PUT', '/api/auth/me', techTok, { phone: 'xyz' })).status, 400);
  assert.equal((await call('PUT', '/api/auth/me', techTok, { phone: OTHER_NSN })).status, 409); // the other user has +91<OTHER_NSN>
});

test('write path: "" clears the phone', async () => {
  assert.equal((await call('PUT', '/api/auth/me', techTok, { phone: '' })).status, 200);
  assert.equal(await techPhone(), null);
});
