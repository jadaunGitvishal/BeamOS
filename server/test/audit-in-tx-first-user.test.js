'use strict';

// Phase 1C batch 3, pre-existing race (security): the FIRST account on an install becomes
// platform_admin. The route used to COUNT users and then INSERT, so concurrent first
// registrations could each see 0 users and ALL become platform_admin. Now the count is
// read under the platform-admins lock (app_locks), in the transaction that inserts the
// user (routes/auth.js createAccountTx): exactly one becomes platform_admin.
//
// That needs a database with no users at all, so - like auth-audit-first-user.test.js -
// this spawns a real server.js on a throwaway, EMPTY database beamos_test_first_race_<hex>
// (server.js builds the schema at boot) and fires 8 registrations at once. Each comes from
// its own forwarded client address (X-Forwarded-For; loopback is a trusted proxy), so the
// per-IP register rate limit (5/min) doesn't refuse any of them. The database is dropped
// afterwards. No JWT is signed here (tokens come from the server).
//
// helpers/slow-query.js (preloaded) holds the OLD route's user count - its exact SQL, run
// on the outer db - for 300ms, so every registration is inside the count-then-insert
// window at once. The fixed route counts on its transaction handle, which the preload never
// touches, after taking the lock.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mysql = require('mysql2/promise');
const config = require('../config');
const mysqlTls = require('../lib/mysql-tls');
const { assertSafeTestDb, isAllowedTestDbName } = require('../lib/test-db-guard');
const path = require('node:path');
const { startServer } = require('./helpers/spawn-server');
const OLD_COUNT_SQL = 'SELECT COUNT(*) as count FROM users';

const DB_NAME = `beamos_test_first_race_${crypto.randomBytes(4).toString('hex')}`;
const PW = 'First-race-pw-1';
let admin;
let srv;

function baseOptions() {
  const o = { host: config.mysqlHost, port: config.mysqlPort, user: config.mysqlUser, password: config.mysqlPassword };
  if (config.mysqlSocketPath) o.socketPath = config.mysqlSocketPath;
  const ssl = mysqlTls.mysqlSslOptions(config);
  if (ssl) o.ssl = ssl;
  return o;
}

test.before(async () => {
  assertSafeTestDb({ database: DB_NAME, user: config.mysqlUser });
  admin = await mysql.createConnection(baseOptions());
  await admin.query(`CREATE DATABASE \`${DB_NAME}\``);
  srv = await startServer({
    name: 'audit-in-tx-first-user',
    nodeArgs: ['--require', path.join(__dirname, 'helpers', 'slow-query.js')],
    env: { MYSQL_DATABASE: DB_NAME, SLOW_QUERY_SQL: OLD_COUNT_SQL, SLOW_QUERY_MS: '300' },
    bootTimeoutMs: 60000,
  });
});

test.after(async () => {
  try {
    if (srv) await srv.stop();
  } finally {
    if (admin) {
      try {
        if (!(isAllowedTestDbName(DB_NAME) && DB_NAME.startsWith('beamos_test_'))) throw new Error(`refusing to drop non-scratch database ${DB_NAME}`);
        await admin.query(`DROP DATABASE IF EXISTS \`${DB_NAME}\``);
      } finally { await admin.end(); }
    }
  }
});

test('8 concurrent first registrations on an empty install -> exactly ONE platform_admin, each audited once', async () => {
  const conn = await mysql.createConnection({ ...baseOptions(), database: DB_NAME });
  try {
    const [[{ n }]] = await conn.query('SELECT COUNT(*) AS n FROM users');
    assert.equal(Number(n), 0, 'the scratch install starts with no users');

    const emails = Array.from({ length: 8 }, (_, i) => `race-${i}-${crypto.randomBytes(3).toString('hex')}@x.local`);
    const results = await Promise.all(emails.map((email, i) => fetch(`${srv.base}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': `203.0.113.${10 + i}` },
      body: JSON.stringify({ email, password: PW, name: `Race ${i}` }),
    }).then(async (r) => ({ status: r.status, body: await r.json() }))));
    assert.deepEqual(results.map((r) => r.status), Array(8).fill(201), JSON.stringify(results.map((r) => r.body)));

    const [roles] = await conn.query('SELECT role, COUNT(*) AS n FROM users GROUP BY role ORDER BY role');
    const byRole = Object.fromEntries(roles.map((r) => [r.role, Number(r.n)]));
    assert.deepEqual(byRole, { platform_admin: 1, user: 7 }, `exactly one platform_admin: ${JSON.stringify(byRole)}`);
    assert.equal(results.filter((r) => r.body.user.role === 'platform_admin').length, 1, 'one response says platform_admin');

    // Every account audited once, and the row's role matches the account's.
    const [rows] = await conn.query("SELECT user_id, details FROM activity_log WHERE action = 'user_registered'");
    assert.equal(rows.length, 8);
    const [users] = await conn.query('SELECT id, email, role FROM users');
    for (const u of users) {
      const mine = rows.filter((r) => r.user_id === u.id);
      assert.equal(mine.length, 1, u.email);
      assert.ok(mine[0].details.startsWith(`email: ${u.email}, role: ${u.role},`), mine[0].details);
    }
  } finally {
    await conn.end();
  }
});
