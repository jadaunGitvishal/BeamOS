'use strict';

// Ref 8: unit tests for routes/scim.js internals that can't be driven safely over
// HTTP against the shared real database - chiefly the "last active platform admin"
// lockout guard (the shared test DB can always hold other active platform admins, so
// the refusing branch is unreachable there).
//
// Isolation: the whole process runs against a SCRATCH MySQL database (real schema,
// real routes/scim.js + db/database.js) created here and dropped in after().
// MYSQL_DATABASE is pointed at it before config / the db module load, so the guard's
// whole-table "other active platform admins" count sees exactly the users this file
// seeds - nothing else. Same technique as audit-prune.test.js.

const crypto = require('node:crypto');
const DB_NAME = `beamos_test_scim_unit_${crypto.randomBytes(4).toString('hex')}`;
process.env.MYSQL_DATABASE = DB_NAME;

const test = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const config = require('../config');
const mysqlTls = require('../lib/mysql-tls');
const { assertSafeTestDb, isAllowedTestDbName } = require('../lib/test-db-guard');
const { initDb, db } = require('../db/database');

const { _internal } = require('../routes/scim');
const { compileFilter, readPatchBody, parseActive, splitAnd, assertNotLastPlatformAdmin } = _internal;

function baseOptions() {
  const o = { host: config.mysqlHost, port: config.mysqlPort, user: config.mysqlUser, password: config.mysqlPassword };
  if (config.mysqlSocketPath) o.socketPath = config.mysqlSocketPath;
  const ssl = mysqlTls.mysqlSslOptions(config);
  if (ssl) o.ssl = ssl;
  return o;
}

test.before(async () => {
  assertSafeTestDb({ database: DB_NAME, user: config.mysqlUser });
  const conn = await mysql.createConnection(baseOptions());
  await conn.query(`CREATE DATABASE \`${DB_NAME}\``);
  await conn.end();
  await initDb(); // the real schema in the empty scratch database
});

test.after(async () => {
  try {
    if (!(isAllowedTestDbName(DB_NAME) && DB_NAME.startsWith('beamos_test_'))) throw new Error(`refusing to drop non-scratch database ${DB_NAME}`);
    await db.exec(`DROP DATABASE \`${DB_NAME}\``);
  } finally {
    await db.close();
  }
});

test('assertNotLastPlatformAdmin: refuses to deactivate the only active platform admin; allows it once another exists', async () => {
  await db.exec('DELETE FROM users');
  const user = "INSERT INTO users (id, email, name, role, deactivated_at) VALUES (?, ?, ?, ?, ?)";
  await db.prepare(user).run('a1', 'a1@x', 'a1', 'platform_admin', null);
  await db.prepare(user).run('u1', 'u1@x', 'u1', 'user', null);
  await db.prepare(user).run('a2', 'a2@x', 'a2', 'platform_admin', 123);
  const a1 = { id: 'a1', role: 'platform_admin', deactivated_at: null };
  await assert.rejects(() => assertNotLastPlatformAdmin(a1), (e) => e.status === 403 && /last active platform admin/.test(e.message));
  // a deactivated admin (a2) doesn't count as "another"
  await db.prepare("UPDATE users SET deactivated_at = NULL WHERE id = 'a2'").run();
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
