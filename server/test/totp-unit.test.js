'use strict';

// #100 unit tests: the security-critical assertions that don't need a full server.
// The bite-test (#1) uses a real user row (on the test DB, beamos_test via npm test) so
// that REMOVING the mfa_pending rejection in requireAuth makes it go red (the pending
// token would then find the user and call next()).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { authenticator } = require('otplib');

const { db } = require('../db/database');
const { requireAuth, generateMfaPendingToken, generateToken } = require('../middleware/auth');
const totp = require('../lib/totp');
const totpLockout = require('../lib/totp-lockout');

const U1 = 'TU-' + crypto.randomBytes(4).toString('hex') + '-u1';
before(async () => {
  await db.prepare("INSERT INTO users (id, email, name, role, auth_provider) VALUES (?, ?, 'U1', 'user', 'local')").run(U1, `${U1}@test.local`);
});
after(async () => {
  try { await db.prepare('DELETE FROM users WHERE id = ?').run(U1); } finally { await db.close(); }
});

// requireAuth is async (it reads the user row) and its asyncHandler wrapper doesn't
// return the promise, so settle on whichever of res.json() / next() it reaches.
function runRequireAuth(token) {
  return new Promise((resolve) => {
    const req = { headers: { authorization: 'Bearer ' + token }, originalUrl: '/api/devices' };
    let status = 200;
    const res = { status(s) { status = s; return this; }, json() { resolve({ status, nexted: false, err: null, req }); return this; } };
    requireAuth(req, res, (err) => resolve({ status, nexted: !err, err: err || null, req }));
  });
}

test('#100 BITE: requireAuth rejects an mfa_pending token (no password-only session)', async () => {
  const pending = await runRequireAuth(generateMfaPendingToken({ id: U1 }));
  assert.equal(pending.status, 401, 'mfa_pending token must be 401');
  assert.equal(pending.nexted, false, 'must NOT call next() for an mfa_pending token');
  // Contrast: a FULL token for the SAME user passes - so the user EXISTS in the db,
  // which means removing the mfa_pending check would let the pending token through too
  // (next() called). That's what makes this a real bite-test, not a vacuous 401.
  const full = await runRequireAuth(generateToken({ id: U1, email: `${U1}@test.local`, role: 'user' }, null));
  assert.equal(full.err, null, 'requireAuth must not error for a full token');
  assert.equal(full.nexted, true, 'a full token for the same user must pass requireAuth');
  assert.equal(full.req.user.id, U1);
});

test('#100 lockout: locks after MAX_FAILS, lifts after the window, reset clears', () => {
  const k = 'user-' + crypto.randomUUID();
  for (let i = 0; i < totpLockout.MAX_FAILS - 1; i++) totpLockout.recordFailure(k, 1000);
  assert.equal(totpLockout.isLocked(k, 1000), false);
  totpLockout.recordFailure(k, 1000);
  assert.equal(totpLockout.isLocked(k, 1000), true, 'locked at MAX_FAILS');
  assert.equal(totpLockout.isLocked(k, 1000 + totpLockout.LOCKOUT_MS + 1), false, 'lifts after window');
  totpLockout.reset(k);
  assert.equal(totpLockout.isLocked(k, 1000), false, 'reset clears');
});

test('#100 replay: a TOTP code from an already-consumed step is rejected', () => {
  const secret = totp.generateSecret();
  const code = authenticator.generate(secret);
  const step = totp.currentStep();
  assert.equal(totp.verifyCode(code, secret, step - 1), step, 'fresh code accepted, returns the step');
  assert.equal(totp.verifyCode(code, secret, step), null, 'same code at the consumed step is blocked');
});

test('#100 key-mismatch is graceful: decrypt failure -> null (no throw); verifyCode tolerates null', () => {
  // If the secretbox key changes (rotated JWT_SECRET, non-persisted .jwt_secret), the
  // stored TOTP secret becomes undecryptable. That must degrade, not 500.
  assert.equal(totp.decryptSecret('!!!not-decryptable'), null, 'undecryptable -> null, not a throw');
  assert.doesNotThrow(() => totp.verifyCode('123456', null, 0), 'null secret must not throw on the login path');
  assert.equal(totp.verifyCode('123456', null, 0), null, 'null secret -> null (recovery path then handles it)');
});

test('#100 recovery codes: stored hashed, never plaintext; input normalized', () => {
  const { plain, hashes } = totp.generateRecoveryCodes(10);
  assert.equal(plain.length, 10);
  assert.equal(hashes.length, 10);
  assert.match(plain[0], /^[0-9A-F]{10}$/, 'plaintext is 10 hex chars (shown once)');
  assert.match(hashes[0], /^[0-9a-f]{64}$/, 'stored value is a SHA-256 hash');
  assert.notEqual(plain[0], hashes[0], 'the stored value is not the plaintext');
  // typed with stray spaces/hyphens/lowercase still matches the stored hash
  const messy = ' ' + plain[0].toLowerCase().slice(0, 5) + '-' + plain[0].toLowerCase().slice(5) + ' ';
  assert.equal(totp.hashRecoveryCode(messy), hashes[0], 'normalized input matches');
});
