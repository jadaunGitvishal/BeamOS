'use strict';

// Startup lock timeout: the startup schema statements run on one connection with
// SET SESSION lock_wait_timeout = BOOT_LOCK_WAIT_TIMEOUT_S (default 60), so a DDL waiting
// behind another session's metadata lock fails with ER_LOCK_WAIT_TIMEOUT (1205) and a clear
// message naming the phase - and server.js exits non-zero - instead of waiting MySQL's
// default lock_wait_timeout of one year with no output at all.
//
// Throwaway MySQL database beamos_test_boot_lock_<hex>, built from the real db/schema.sql,
// with users.must_change_password dropped so the startup repair (verifyAndRepairSchema)
// must ALTER TABLE users - which needs an exclusive metadata lock. A second connection
// holds a conflicting one: an open transaction that has read users.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');

const config = require('../config');
const mysqlTls = require('../lib/mysql-tls');
const { assertSafeTestDb, isAllowedTestDbName } = require('../lib/test-db-guard');
const { resolveBootLockWaitTimeout, runStartupSchema } = require('../db/database');
const { startServer } = require('./helpers/spawn-server');

const DB_NAME = `beamos_test_boot_lock_${crypto.randomBytes(4).toString('hex')}`;
const SERVER_DIR = path.join(__dirname, '..');
const MESSAGE = /startup phase (\w+) gave up after 2s waiting for a database lock \(ER_LOCK_WAIT_TIMEOUT \/ 1205: Lock wait timeout exceeded/;
let admin;      // creates / drops the scratch database
let holder;     // holds the conflicting metadata lock
let holding = false;

function baseOptions() {
  const o = { host: config.mysqlHost, port: config.mysqlPort, user: config.mysqlUser, password: config.mysqlPassword };
  if (config.mysqlSocketPath) o.socketPath = config.mysqlSocketPath;
  const ssl = mysqlTls.mysqlSslOptions(config);
  if (ssl) o.ssl = ssl;
  return o;
}

// db/schema.sql statement by statement - same comment stripping / ';' split and benign
// "already exists" tolerance as db/database.js applySchema().
async function buildFromSchema(conn) {
  const sql = fs.readFileSync(path.join(SERVER_DIR, 'db', 'schema.sql'), 'utf8');
  const stmts = sql.split('\n').map((line) => { const i = line.indexOf('--'); return i === -1 ? line : line.slice(0, i); })
    .join('\n').split(';').map((s) => s.trim()).filter(Boolean);
  const BENIGN = new Set(['ER_DUP_FIELDNAME', 'ER_TABLE_EXISTS_ERROR', 'ER_DUP_KEYNAME']);
  for (const s of stmts) { try { await conn.query(s); } catch (e) { if (!BENIGN.has(e.code)) throw e; } }
}

const hasColumn = async (conn) => (await conn.query(
  "SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users' AND COLUMN_NAME = 'must_change_password'", [DB_NAME],
))[0].length > 0;

// Fails (rather than hangs) if `p` doesn't settle within ms.
function within(p, ms, what) {
  let t;
  return Promise.race([p, new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`${what} did not finish within ${ms}ms`)), ms); })])
    .finally(() => clearTimeout(t));
}

test.before(async () => {
  assertSafeTestDb({ database: DB_NAME, user: config.mysqlUser });
  admin = await mysql.createConnection(baseOptions());
  await admin.query(`CREATE DATABASE \`${DB_NAME}\``);
  const build = await mysql.createConnection({ ...baseOptions(), database: DB_NAME });
  try {
    await buildFromSchema(build);
    await build.query('ALTER TABLE users DROP COLUMN must_change_password');
  } finally { await build.end(); }

  // The conflicting metadata lock: an open transaction that has read users. Held until
  // the "released" test (or after()), so the startup ALTER TABLE users must wait.
  holder = await mysql.createConnection({ ...baseOptions(), database: DB_NAME });
  await holder.query('START TRANSACTION');
  await holder.query('SELECT COUNT(*) FROM users');
  holding = true;
});

test.after(async () => {
  try {
    if (holder) {
      try { if (holding) await holder.query('ROLLBACK'); } finally { holding = false; await holder.end(); }
    }
  } finally {
    if (admin) {
      try {
        if (!(isAllowedTestDbName(DB_NAME) && DB_NAME.startsWith('beamos_test_'))) throw new Error(`refusing to drop non-scratch database ${DB_NAME}`);
        await admin.query(`DROP DATABASE IF EXISTS \`${DB_NAME}\``);
      } finally { await admin.end(); }
    }
  }
});

test('BOOT_LOCK_WAIT_TIMEOUT_S: unset -> 60; whole seconds accepted; 0, -1, "abc" and other non-integers refused', async () => {
  assert.equal(resolveBootLockWaitTimeout(undefined), 60);
  assert.equal(resolveBootLockWaitTimeout(''), 60);
  assert.equal(resolveBootLockWaitTimeout('2'), 2);
  assert.equal(resolveBootLockWaitTimeout(' 30 '), 30);
  for (const bad of ['0', '-1', 'abc', '1.5', '2s', '1e3', '31536001']) {
    assert.throws(() => resolveBootLockWaitTimeout(bad),
      new RegExp(`BOOT_LOCK_WAIT_TIMEOUT_S must be a whole number of seconds from 1 to 31536000 \\(got "${bad.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\)`),
      `"${bad}" is refused`);
  }
});

test('server.js refuses to start with an invalid BOOT_LOCK_WAIT_TIMEOUT_S (non-zero exit, clear message)', async () => {
  for (const bad of ['0', '-1', 'abc']) {
    const r = await startServer({
      name: `boot-lock-invalid-${bad}`, env: { MYSQL_DATABASE: DB_NAME, BOOT_LOCK_WAIT_TIMEOUT_S: bad }, expectExit: true, bootTimeoutMs: 30000,
    });
    assert.notEqual(r.code, 0, `exits non-zero for "${bad}" (code ${r.code}, signal ${r.signal})`);
    assert.match(r.output, /\[boot\] fatal error during startup/, `startup failure reported for "${bad}"`);
    assert.match(r.output, new RegExp(`BOOT_LOCK_WAIT_TIMEOUT_S must be a whole number of seconds from 1 to 31536000 \\(got "${bad}"\\)`));
  }
});

test('startup schema phase gives up after BOOT_LOCK_WAIT_TIMEOUT_S with ER_LOCK_WAIT_TIMEOUT instead of hanging', async () => {
  const conn = await mysql.createConnection({ ...baseOptions(), database: DB_NAME });
  try {
    const t0 = Date.now();
    const err = await within(runStartupSchema(conn, 2).then(() => null, (e) => e), 30000, 'runStartupSchema');
    const ms = Date.now() - t0;
    assert.ok(err, 'the startup schema phase failed');
    assert.match(err.message, MESSAGE);
    assert.equal(err.message.match(MESSAGE)[1], 'verifyAndRepairSchema', 'names the phase that waited (the users repair)');
    assert.equal(err.cause && err.cause.code, 'ER_LOCK_WAIT_TIMEOUT');
    assert.ok(ms >= 1500 && ms < 10000, `gave up after the 2s lock wait, not hung (${ms}ms)`);
    assert.equal(await hasColumn(admin), false, 'the repair did not happen');
  } finally { await conn.end(); }
});

test('server.js exits non-zero with the lock-wait-timeout message while the lock is held', async () => {
  const t0 = Date.now();
  const r = await startServer({
    name: 'boot-lock-held', env: { MYSQL_DATABASE: DB_NAME, BOOT_LOCK_WAIT_TIMEOUT_S: '2' }, expectExit: true, bootTimeoutMs: 30000,
  });
  assert.notEqual(r.code, 0, `exits non-zero (code ${r.code}, signal ${r.signal})`);
  assert.match(r.output, /\[boot\] fatal error during startup/);
  assert.match(r.output, MESSAGE);
  assert.doesNotMatch(r.output, /missing required schema/, 'reported as a lock wait, not as a broken schema');
  assert.doesNotMatch(r.output, /MySQL ready/, 'never reported ready');
  assert.ok(Date.now() - t0 < 25000, 'gave up instead of hanging');
});

test('once the lock is released, the same startup phase completes and repairs the column', async () => {
  await holder.query('ROLLBACK');
  holding = false;
  const conn = await mysql.createConnection({ ...baseOptions(), database: DB_NAME });
  try {
    await within(runStartupSchema(conn, 2), 30000, 'runStartupSchema');
    assert.equal(await hasColumn(admin), true, 'users.must_change_password repaired');
  } finally { await conn.end(); }
});
