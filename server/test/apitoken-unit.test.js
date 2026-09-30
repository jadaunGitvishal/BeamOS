'use strict';

// Unit tests for apiTokenAuth branches that are awkward to assert against the subprocess
// integration server (cross-process SQLite/WAL visibility is unreliable mid-run): the
// must_change_password gate, plus a sanity check that a normal token passes with the
// platform role stripped. Uses the project's in-memory-DB injection pattern (inject
// ../db/database into the require cache BEFORE requiring the middleware).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-apitoken-unit';

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE users (
    id TEXT PRIMARY KEY, email TEXT, name TEXT, role TEXT DEFAULT 'user',
    auth_provider TEXT, avatar_url TEXT, plan_id TEXT, email_alerts INTEGER,
    must_change_password INTEGER NOT NULL DEFAULT 0, deactivated_at INTEGER
  );
  CREATE TABLE api_tokens (
    id TEXT PRIMARY KEY, token_hash TEXT, prefix TEXT, name TEXT, user_id TEXT,
    workspace_id TEXT, scope TEXT, created_at INTEGER, last_used_at INTEGER, revoked_at INTEGER
  );
  -- Ref 34: apiTokenAuth joins token -> workspace -> organization for the lifetime cap.
  CREATE TABLE workspaces (id TEXT PRIMARY KEY, organization_id TEXT);
  CREATE TABLE organizations (id TEXT PRIMARY KEY, max_token_lifetime_days INTEGER);
  INSERT INTO workspaces (id, organization_id) VALUES ('ws-x', 'org-x');
  INSERT INTO organizations (id, max_token_lifetime_days) VALUES ('org-x', NULL);
`);
require.cache[require.resolve('../db/database')] = { id: require.resolve('../db/database'), loaded: true, exports: { db } };
const { apiTokenAuth, hashToken } = require('../middleware/apiToken');

function seedToken({ mustChange, createdAt = Math.floor(Date.now() / 1000) }) {
  const uid = crypto.randomUUID();
  db.prepare('INSERT INTO users (id, email, must_change_password) VALUES (?, ?, ?)').run(uid, uid + '@t.local', mustChange ? 1 : 0);
  const secret = 'st_' + crypto.randomBytes(16).toString('hex');
  db.prepare('INSERT INTO api_tokens (id, token_hash, prefix, name, user_id, workspace_id, scope, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(crypto.randomUUID(), hashToken(secret), secret.slice(0, 11), 'n', uid, 'ws-x', 'read', createdAt);
  return secret;
}
function runAuth(secret) {
  return new Promise((resolve) => {
    const req = { headers: { authorization: 'Bearer ' + secret }, query: {} };
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(body) { resolve({ outcome: 'response', status: this.statusCode, body }); } };
    apiTokenAuth(req, res, () => resolve({ outcome: 'next', viaToken: req.viaToken, role: req.user && req.user.role }));
  });
}

test('apiTokenAuth: a must_change_password owner is blocked with 403', async () => {
  const r = await runAuth(seedToken({ mustChange: true }));
  assert.equal(r.outcome, 'response');
  assert.equal(r.status, 403);
});
test('apiTokenAuth: a normal owner passes (next; viaToken set; platform role stripped to user)', async () => {
  const r = await runAuth(seedToken({ mustChange: false }));
  assert.equal(r.outcome, 'next');
  assert.equal(r.viaToken, true);
  assert.equal(r.role, 'user');
});

// Ref 34: org-level max token lifetime, checked against token AGE at auth time.
const setCap = (days) => db.prepare("UPDATE organizations SET max_token_lifetime_days = ? WHERE id = 'org-x'").run(days);
const DAY = 86400;

test('Ref 34: a token minted BEFORE any cap is refused as soon as a cap it already exceeds is set (retroactive)', async () => {
  setCap(null);
  const secret = seedToken({ mustChange: false, createdAt: Math.floor(Date.now() / 1000) - 40 * DAY });
  assert.equal((await runAuth(secret)).outcome, 'next'); // works while uncapped
  setCap(30);
  try {
    const r = await runAuth(secret);
    assert.equal(r.status, 401);
    assert.deepEqual(r.body, { error: 'Invalid or expired API token' }); // same 401 { error } shape as revoked
  } finally { setCap(null); }
  assert.equal((await runAuth(secret)).outcome, 'next'); // age-expiry is policy, not revocation
});
test('Ref 34: a token younger than the cap still authenticates', async () => {
  setCap(30);
  try {
    const r = await runAuth(seedToken({ mustChange: false, createdAt: Math.floor(Date.now() / 1000) - 29 * DAY }));
    assert.equal(r.outcome, 'next');
  } finally { setCap(null); }
});
test('Ref 34: no cap (NULL, the default) never expires a token, however old', async () => {
  setCap(null);
  const r = await runAuth(seedToken({ mustChange: false, createdAt: 1 })); // 1970
  assert.equal(r.outcome, 'next');
});
