'use strict';

// Ref 8: unit tests for routes/scim.js internals that can't be driven safely over
// HTTP against the shared real database - chiefly the "last active platform admin"
// lockout guard (the real DB always has other active platform admins, so the
// refusing branch is unreachable there). Uses the in-memory SQLite db mock via
// require.cache, same technique as test/entra-token-integration.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const sqlite = new Database(':memory:');
sqlite.exec(`
  CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, role TEXT, deactivated_at INTEGER);
  CREATE TABLE activity_log (id INTEGER PRIMARY KEY);
`);
// Thin async shim matching db/database.js's .prepare().get/.all/.run shape.
const db = {
  prepare(sql) {
    const st = sqlite.prepare(sql);
    return { get: async (...p) => st.get(...p), all: async (...p) => st.all(...p), run: async (...p) => st.run(...p) };
  },
};
const dbModulePath = require.resolve('../db/database');
require.cache[dbModulePath] = { id: dbModulePath, filename: dbModulePath, loaded: true, exports: { db } };

const { _internal } = require('../routes/scim');
const { compileFilter, readPatchBody, parseActive, splitAnd, assertNotLastPlatformAdmin } = _internal;

test('assertNotLastPlatformAdmin: refuses to deactivate the only active platform admin; allows it once another exists', async () => {
  sqlite.exec("DELETE FROM users; INSERT INTO users VALUES ('a1','a1@x','platform_admin',NULL), ('u1','u1@x','user',NULL), ('a2','a2@x','platform_admin',123)");
  const a1 = { id: 'a1', role: 'platform_admin', deactivated_at: null };
  await assert.rejects(() => assertNotLastPlatformAdmin(a1), (e) => e.status === 403 && /last active platform admin/.test(e.message));
  // a deactivated admin (a2) doesn't count as "another"
  sqlite.exec("UPDATE users SET deactivated_at = NULL WHERE id = 'a2'");
  await assertNotLastPlatformAdmin(a1);
  // ordinary users and already-deactivated admins are never blocked
  await assertNotLastPlatformAdmin({ id: 'u1', role: 'user', deactivated_at: null });
  await assertNotLastPlatformAdmin({ id: 'a1', role: 'platform_admin', deactivated_at: 5 });
});

test('parseActive: booleans and Entra\'s default string form ("False"/"True", any case); anything else throws', () => {
  assert.equal(parseActive(false), false);
  assert.equal(parseActive('False'), false);
  assert.equal(parseActive('TRUE'), true);
  for (const v of ['no', 0, 1, null, 'f']) assert.throws(() => parseActive(v));
});

test('splitAnd: splits on top-level "and" only (not inside quotes or [] value filters)', () => {
  assert.deepEqual(splitAnd('userName eq "a and b" and active eq true'), ['userName eq "a and b"', 'active eq true']);
  assert.deepEqual(splitAnd('emails[type eq "work" and primary eq true].value eq "x"'), ['emails[type eq "work" and primary eq true].value eq "x"']);
});

test('compileFilter: lowercases userName, keeps externalId exact, rejects or/other operators', () => {
  assert.deepEqual(compileFilter('userName eq "Bob@X.com"'), { where: ['u.email = ?'], params: ['bob@x.com'] });
  assert.deepEqual(compileFilter('externalId eq JYoung'), { where: ['u.scim_external_id = ?'], params: ['JYoung'] });
  assert.throws(() => compileFilter('userName sw "b"'), (e) => e.scimType === 'invalidFilter');
  assert.throws(() => compileFilter('userName eq "a" or userName eq "b"'), (e) => e.scimType === 'invalidFilter');
});

test('readPatchBody: op case-insensitive; path-less object form; unknown attrs ignored', () => {
  assert.deepEqual(
    readPatchBody({ Operations: [{ op: 'Replace', path: 'active', value: 'False' }, { op: 'ADD', path: 'nickName', value: 'Babs' }] }),
    { active: false },
  );
  assert.deepEqual(
    readPatchBody({ Operations: [{ op: 'replace', value: { displayName: 'X', 'name.givenName': 'Y', externalId: 'e' } }] }),
    { displayName: 'X', externalId: 'e' },
  );
  assert.deepEqual(readPatchBody({ Operations: [{ op: 'remove', path: 'externalId' }] }), { externalId: null });
});
