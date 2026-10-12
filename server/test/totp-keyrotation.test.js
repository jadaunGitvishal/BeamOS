'use strict';

// #100 key-rotation robustness: secretbox derives its key from JWT_SECRET, so an enrolled
// user's totp_secret_enc is bound to it. If the key changes (redeploy with a different
// JWT_SECRET, or a non-persisted .jwt_secret regenerated on a fresh Docker boot), the
// stored TOTP secret becomes undecryptable. Requirement: the user must NOT be hard-locked
// out - recovery codes (hashed, key-independent) must still work, and a TOTP attempt must
// fail CLEANLY (401), never 500. Boots under key A (enroll), reboots under key B (verify).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { authenticator } = require('otplib');
const { startServer } = require('./helpers/spawn-server');

// Both boots share this DATA_DIR (passed explicitly; caller env wins over the helper's
// fresh one) - only JWT_SECRET differs between them. Removed in the test's finally.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'st-totp-rot-'));
let BASE;

async function bootServer(jwtSecret) {
  const srv = await startServer({ name: 'totp-keyrotation', env: { DATA_DIR, JWT_SECRET: jwtSecret } });
  BASE = srv.base;
  return srv;
}
async function jfetch(p, opts = {}) {
  const res = await fetch(BASE + p, opts);
  let body = null; try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
}
const post = (o) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o || {}) });
const postAuth = (tok, o) => ({ method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify(o || {}) });

test('#100 key rotation does NOT brick TOTP: recovery survives; TOTP fails cleanly (no 500)', async () => {
  let srv;
  try {
    srv = await bootServer('keyA-' + crypto.randomBytes(8).toString('hex'));
    const email = 'rot' + crypto.randomBytes(4).toString('hex') + '@x.local';
    const tok = (await jfetch('/api/auth/register', post({ email, password: 'Passw0rd123' }))).body.token;
    const secret = (await jfetch('/api/auth/totp/setup', postAuth(tok, {}))).body.secret;
    const recovery = (await jfetch('/api/auth/totp/enable', postAuth(tok, { code: authenticator.generate(secret) }))).body.recovery_codes;
    assert.equal(recovery.length, 10, 'enrolled under key A');

    await srv.stop();

    // Reboot with a DIFFERENT key (same DATA_DIR) -> totp_secret_enc is now undecryptable.
    srv = await bootServer('keyB-' + crypto.randomBytes(8).toString('hex'));

    // password login still issues an MFA challenge
    const l1 = await jfetch('/api/auth/login', post({ email, password: 'Passw0rd123' }));
    assert.equal(l1.body.mfa_required, true, 'still challenged after the key change');

    // a TOTP code can't be verified (secret undecryptable) -> CLEAN 401, NEVER 500
    const totpTry = await jfetch('/api/auth/totp/verify', post({ mfa_token: l1.body.mfa_token, code: authenticator.generate(secret) }));
    assert.equal(totpTry.status, 401, 'TOTP fails cleanly when the secret cannot be decrypted (not 500)');

    // a RECOVERY code STILL works (hashed, key-independent) -> the user is not bricked
    const l2 = await jfetch('/api/auth/login', post({ email, password: 'Passw0rd123' }));
    const rec = await jfetch('/api/auth/totp/verify', post({ mfa_token: l2.body.mfa_token, code: recovery[0] }));
    assert.ok(rec.body.token, 'recovery code survives the key change -> NOT hard-locked-out');
  } finally {
    if (srv) await srv.stop();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
});
