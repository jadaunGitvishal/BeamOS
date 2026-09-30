'use strict';

// Ref 2 Stage 3: devices.device_token at rest.
//
// device_token is each screen's long-lived bearer credential (presented on every
// socket reconnect, ws/deviceSocket.js). It was stored in PLAINTEXT, so anyone
// with read access to the database or a backup could impersonate any display.
// It is only ever VERIFIED (the server never needs its own copy back - on
// reconnect it echoes the token the device just presented), so the right at-rest
// form is a one-way SHA-256 hash, same as api_tokens / scim_tokens - NOT
// reversible secretbox encryption. The raw token is 256 random bits, so a plain
// (unsalted, fast) SHA-256 is the standard choice; a slow KDF is for low-entropy
// passwords.
//
// Stored form: 'sha256:' + hex. The prefix is what tells a hashed row from a
// legacy plaintext one - both would otherwise be 64 hex characters.
//
// Transition: verification accepts BOTH forms, so no device is locked out and no
// client changes. New tokens (first pairing, activation-code claim, fingerprint
// reclaim) are stored hashed from now on; existing plaintext rows are converted
// ONLY by scripts/hash-device-tokens.js (dry-run by default, --yes to write) -
// there is deliberately no silent upgrade-on-auth, so deploying this doesn't by
// itself rewrite the fleet. ROLLBACK CAVEAT: code older than this commit compares
// plaintext and cannot verify a hashed row, so after a device's row is hashed a
// downgrade locks that device out (#143 made an invalid token a lockout, not a
// re-provision) until it is re-paired. Hashing is one-way by design.

const crypto = require('crypto');

const HASH_PREFIX = 'sha256:';

function generateDeviceToken() {
  return crypto.randomBytes(32).toString('hex');
}

function hashDeviceToken(token) {
  return HASH_PREFIX + crypto.createHash('sha256').update(String(token)).digest('hex');
}

function isHashed(stored) {
  return typeof stored === 'string' && stored.startsWith(HASH_PREFIX);
}

function safeEqual(a, b) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Constant-time check of a presented token against the stored value (hashed or
// legacy plaintext). False for a missing stored value or a missing/empty token.
function verifyDeviceToken(stored, presented) {
  if (!stored || !presented || typeof presented !== 'string') return false;
  if (isHashed(stored)) return safeEqual(stored, hashDeviceToken(presented));
  return safeEqual(stored, presented); // legacy plaintext row (pre-backfill)
}

module.exports = { generateDeviceToken, hashDeviceToken, verifyDeviceToken, isHashed, HASH_PREFIX };
