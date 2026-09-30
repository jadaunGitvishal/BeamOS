'use strict';

// Ref 2 Stage 2: lib/secretbox.js key sourcing - optional DATA_ENCRYPTION_KEY,
// else the ORIGINAL jwtSecret-derived key. secretbox resolves its key once at
// require time, so every case runs it in a FRESH child process with its own env
// (the only honest way to test "set" vs "unset").
//
// Backward compatibility is checked against KNOWN-ANSWER ciphertexts produced by
// the pre-Stage-2 secretbox.js (captured from the unmodified file at 3de7772/ac4d716
// with JWT_SECRET='kat-legacy-jwt-secret-ref2'), not against the new code's own
// output - so "the fallback is unchanged" is proven, not assumed.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SERVER_DIR = path.join(__dirname, '..');
const LEGACY_JWT = 'kat-legacy-jwt-secret-ref2';
const LEGACY_VECTORS = [
  ['JBSWY3DPEHPK3PXP', 'mUA3+UWKLmWgNW8Mds0NnGwbg1Evfz1oEKdXPzRbPdNIJiBp35/hBjU7G/U='],
  ['sk-ant-legacy-api-key-0123456789', '/PmWqXZM01ZEtaL9AHCJxtQ19Co3JeLoWCpYHCLQ7BGtzcrk6BPStch4dF/D0fUB4egwZO4ClcCxJEDB'],
  ['ünïcødé ✓', 'bYo54KlxQW0eNUOiMc5BvVTyAZN54tosyvNM6QSr48Gds8192HXETGbIJw=='],
];

// Runs `body` (JS using `sb` = require('./lib/secretbox')) in a child with exactly
// these secretbox-relevant env vars; returns its JSON-printed result, or { threw }.
function inChild(env, body) {
  const childEnv = { ...process.env, JWT_SECRET: env.JWT_SECRET, NODE_ENV: 'test' };
  delete childEnv.DATA_ENCRYPTION_KEY;
  if (env.DATA_ENCRYPTION_KEY !== undefined) childEnv.DATA_ENCRYPTION_KEY = env.DATA_ENCRYPTION_KEY;
  const script = `
    let sb; try { sb = require('./lib/secretbox'); } catch (e) { console.log(JSON.stringify({ threw: e.message })); process.exit(0); }
    const input = JSON.parse(process.argv[1]);
    const out = (() => { ${body} })();
    console.log(JSON.stringify(out));`;
  const stdout = execFileSync(process.execPath, ['-e', script, JSON.stringify(env.input ?? null)], { cwd: SERVER_DIR, env: childEnv, encoding: 'utf8' });
  return JSON.parse(stdout.trim().split('\n').pop());
}

const KEY = crypto.randomBytes(32);
const KEY_HEX = KEY.toString('hex');
const KEY_B64 = KEY.toString('base64');
const KEY_B64URL = KEY.toString('base64url');

test('UNSET: decrypts ciphertexts made by the pre-Stage-2 code, byte-for-byte (no migration needed)', () => {
  const r = inChild({ JWT_SECRET: LEGACY_JWT, input: LEGACY_VECTORS },
    'return { source: sb.KEY_SOURCE, plain: input.map(([, c]) => sb.decrypt(c)) };');
  assert.equal(r.source, 'jwt-secret-derived');
  assert.deepEqual(r.plain, LEGACY_VECTORS.map(([p]) => p));
});

test('UNSET: the fallback key is exactly SHA-256(jwtSecret + ":secretbox-v1"), and round-trips', () => {
  const r = inChild({ JWT_SECRET: LEGACY_JWT },
    `const k = sb._internal.deriveLegacyKey(${JSON.stringify(LEGACY_JWT)}).toString('hex');
     const c = sb.encrypt('round-trip'); return { k, back: sb.decrypt(c) };`);
  assert.equal(r.k, crypto.createHash('sha256').update(LEGACY_JWT + ':secretbox-v1').digest('hex'));
  assert.equal(r.back, 'round-trip');
});

test('SET (hex): decrypt(encrypt(x)) round-trips and the source is DATA_ENCRYPTION_KEY', () => {
  const r = inChild({ JWT_SECRET: LEGACY_JWT, DATA_ENCRYPTION_KEY: KEY_HEX, input: ['JBSWY3DPEHPK3PXP', 'sk-ant-x', 'ünïcødé ✓', 'x'.repeat(5000)] },
    'return { source: sb.KEY_SOURCE, back: input.map((p) => sb.decrypt(sb.encrypt(p))), fresh: sb.encrypt("a") !== sb.encrypt("a") };');
  assert.equal(r.source, 'DATA_ENCRYPTION_KEY');
  assert.deepEqual(r.back, ['JBSWY3DPEHPK3PXP', 'sk-ant-x', 'ünïcødé ✓', 'x'.repeat(5000)]);
  assert.equal(r.fresh, true, 'random IV per encryption');
});

test('SET: the key is used DIRECTLY - ciphertext decrypts with plain AES-256-GCM under that exact key', () => {
  const { c } = inChild({ JWT_SECRET: LEGACY_JWT, DATA_ENCRYPTION_KEY: KEY_HEX }, 'return { c: sb.encrypt("kms-sourced") };');
  const buf = Buffer.from(c, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  assert.equal(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8'), 'kms-sourced');
});

test('SET: hex, base64 and base64url encodings of the same key are interchangeable', () => {
  const { c } = inChild({ JWT_SECRET: 'a', DATA_ENCRYPTION_KEY: KEY_HEX }, 'return { c: sb.encrypt("same key") };');
  for (const enc of [KEY_B64, KEY_B64URL, `  ${KEY_B64}\n`]) {
    assert.equal(inChild({ JWT_SECRET: 'b', DATA_ENCRYPTION_KEY: enc, input: c }, 'return sb.decrypt(input);'), 'same key');
  }
});

test('SET: decoupled from JWT_SECRET - rotating JWT_SECRET no longer affects stored secrets', () => {
  const { c } = inChild({ JWT_SECRET: 'jwt-one', DATA_ENCRYPTION_KEY: KEY_HEX }, 'return { c: sb.encrypt("survives") };');
  assert.equal(inChild({ JWT_SECRET: 'jwt-two', DATA_ENCRYPTION_KEY: KEY_HEX, input: c }, 'return sb.decrypt(input);'), 'survives');
});

test('key change (rotation, or switching an existing deployment to DATA_ENCRYPTION_KEY) -> old values decrypt to null, never garbage', () => {
  // legacy-derived values under a newly-set key
  const r = inChild({ JWT_SECRET: LEGACY_JWT, DATA_ENCRYPTION_KEY: KEY_HEX, input: LEGACY_VECTORS },
    'return input.map(([, c]) => sb.decrypt(c));');
  assert.deepEqual(r, [null, null, null]);
  // DATA_ENCRYPTION_KEY rotated A -> B
  const { c } = inChild({ JWT_SECRET: 'j', DATA_ENCRYPTION_KEY: KEY_HEX }, 'return { c: sb.encrypt("under A") };');
  assert.equal(inChild({ JWT_SECRET: 'j', DATA_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'), input: c }, 'return sb.decrypt(input);'), null);
});

test('SET but INVALID -> load throws (server fails to boot) instead of silently falling back', () => {
  const bad = [
    crypto.randomBytes(31).toString('hex'),     // 62 hex chars
    crypto.randomBytes(16).toString('base64'),  // 16 bytes
    crypto.randomBytes(33).toString('base64'),  // 33 bytes
    'correct horse battery staple',             // passphrase, not a key
    'zz'.repeat(32),                            // 64 chars, not hex, not 32 bytes of base64
  ];
  for (const k of bad) {
    const r = inChild({ JWT_SECRET: LEGACY_JWT, DATA_ENCRYPTION_KEY: k }, 'return { loaded: true };');
    assert.match(r.threw || '', /DATA_ENCRYPTION_KEY must be a 32-byte key/, `accepted bad key ${JSON.stringify(k)}`);
    assert.equal(r.threw.includes(k.trim()), false, 'error message must not echo the key');
  }
});

test('EMPTY string DATA_ENCRYPTION_KEY is treated as unset (legacy key), matching config.js `||`', () => {
  const r = inChild({ JWT_SECRET: LEGACY_JWT, DATA_ENCRYPTION_KEY: '', input: LEGACY_VECTORS[0][1] },
    'return { source: sb.KEY_SOURCE, p: sb.decrypt(input) };');
  assert.deepEqual(r, { source: 'jwt-secret-derived', p: LEGACY_VECTORS[0][0] });
});
