'use strict';

// Phase 1B batch 2: the FIRST account on an install becomes platform_admin, and its
// user_registered audit row must say so. That needs a database with no users at all, so
// this spawns a real server.js on a throwaway, EMPTY database beamos_test_first_user_<hex>
// (server.js builds the schema at boot, exactly as on a fresh install), registers once
// and reads the row there. The database is dropped afterwards; the shared beamos_test
// (with the runner's placeholder user) is never touched.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mysql = require('mysql2/promise');
const config = require('../config');
const mysqlTls = require('../lib/mysql-tls');
const { assertSafeTestDb, isAllowedTestDbName } = require('../lib/test-db-guard');
const { startServer } = require('./helpers/spawn-server');

const DB_NAME = `beamos_test_first_user_${crypto.randomBytes(4).toString('hex')}`;
const PW = 'First-user-pw-1';
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
  srv = await startServer({ name: 'auth-audit-first-user', env: { MYSQL_DATABASE: DB_NAME }, bootTimeoutMs: 60000 });
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

test('first registration on an empty install: user_registered records role platform_admin and the org it got', async () => {
  const conn = await mysql.createConnection({ ...baseOptions(), database: DB_NAME });
  try {
    const [[{ n }]] = await conn.query('SELECT COUNT(*) AS n FROM users');
    assert.equal(Number(n), 0, 'the scratch install starts with no users');

    const email = `first-${crypto.randomBytes(3).toString('hex')}@x.local`;
    const r = await fetch(`${srv.base}/api/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW, name: 'First' }),
    });
    const body = await r.json();
    assert.equal(r.status, 201, JSON.stringify(body));
    assert.equal(body.user.role, 'platform_admin');

    // Awaited before the 201, so it is there now.
    const [rows] = await conn.query("SELECT user_id, details, workspace_id, organization_id FROM activity_log WHERE action = 'user_registered'");
    assert.equal(rows.length, 1);
    const [[org]] = await conn.query('SELECT id, name FROM organizations WHERE owner_user_id = ?', [body.user.id]);
    assert.ok(org, 'the first user always gets an org');
    assert.equal(rows[0].user_id, body.user.id);
    assert.equal(rows[0].details, `email: ${email}, role: platform_admin, org_created: true, org: ${org.name} (${org.id})`);
    assert.equal(rows[0].organization_id, org.id);
    assert.equal(rows[0].workspace_id, body.current_workspace_id);

    const [all] = await conn.query('SELECT details FROM activity_log');
    assert.ok(all.every((x) => !String(x.details ?? '').includes(PW)), 'no audit row contains the password');
  } finally {
    await conn.end();
  }
});
