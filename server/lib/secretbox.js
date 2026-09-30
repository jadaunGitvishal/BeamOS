'use strict';

// AES-256-GCM encrypt/decrypt for secrets at rest (e.g. BYOK AI provider keys,
// #41; TOTP secrets, #100). Format: base64(iv[12] | tag[16] | ciphertext).
//
// Key source (Ref 2 Stage 2), resolved ONCE at load:
//   1. DATA_ENCRYPTION_KEY set -> used DIRECTLY as the 32-byte AES-256 key. Accepts
//      64 hex chars or base64/base64url that decodes to exactly 32 bytes; anything
//      else THROWS at load (the server fails to boot) rather than silently falling
//      back - a typo'd key must not quietly encrypt new data under the JWT secret.
//      This is how a deployment connects a KMS/HSM: BeamOS does not call Azure Key
//      Vault / AWS KMS itself; the deployment fetches the key from its KMS into the
//      process env at container start (docs/encryption.md).
//   2. unset -> the ORIGINAL derivation, byte-for-byte unchanged:
//      SHA-256(jwtSecret + ':secretbox-v1'). Existing deployments see no change.
//
// Rotation caveat (unchanged in kind): there is ONE active key and no key ID in the
// ciphertext, so changing the key - rotating DATA_ENCRYPTION_KEY, rotating
// JWT_SECRET while it's unset, OR switching an existing deployment from (2) to (1)
// - makes previously-stored values undecryptable. decrypt() then returns null
// (GCM authentication fails; it never yields garbage plaintext). Stored values are
// re-enterable: AI keys by re-saving, TOTP by recovery codes + re-enrol
// (test/totp-keyrotation.test.js).
const crypto = require('crypto');
const config = require('../config');

function parseDataEncryptionKey(raw) {
  const s = String(raw).trim();
  let buf = null;
  if (/^[0-9a-fA-F]{64}$/.test(s)) buf = Buffer.from(s, 'hex');
  else if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) buf = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (!buf || buf.length !== 32) {
    throw new Error('DATA_ENCRYPTION_KEY must be a 32-byte key encoded as 64 hex characters or base64 (e.g. `openssl rand -base64 32`)');
  }
  return buf;
}

function deriveLegacyKey(jwtSecret) {
  return crypto.createHash('sha256').update(String(jwtSecret) + ':secretbox-v1').digest();
}

function resolveKey(dataEncryptionKey, jwtSecret) {
  if (dataEncryptionKey) return { key: parseDataEncryptionKey(dataEncryptionKey), source: 'DATA_ENCRYPTION_KEY' };
  return { key: deriveLegacyKey(jwtSecret), source: 'jwt-secret-derived' };
}

const { key: KEY, source: KEY_SOURCE } = resolveKey(config.dataEncryptionKey, config.jwtSecret);

function encrypt(plain) {
  if (plain == null || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}

function decrypt(b64) {
  if (!b64) return null;
  try {
    const buf = Buffer.from(b64, 'base64');
    const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), enc = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch { return null; }
}

// KEY_SOURCE is a label only ('DATA_ENCRYPTION_KEY' | 'jwt-secret-derived'), never key material.
module.exports = { encrypt, decrypt, KEY_SOURCE, _internal: { parseDataEncryptionKey, deriveLegacyKey, resolveKey } };
