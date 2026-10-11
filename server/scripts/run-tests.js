'use strict';

// `npm test` entry point: runs node:test against a dedicated, freshly reset test
// database as the restricted test account - never the dev database or dev user.
//
//   a. MYSQL_TEST_USER / MYSQL_TEST_PASSWORD set; the test DB name
//      (MYSQL_TEST_DATABASE || 'beamos_test') passes lib/test-db-guard's rule and
//      differs from MYSQL_DATABASE; the test user differs from MYSQL_USER.
//   b. As the test user (no default DB): USE <dev db> must be refused with
//      ER_DBACCESS_DENIED_ERROR, and SHOW GRANTS may only hold USAGE on *.* plus
//      grants on `beamos\_test%`.
//   c. Child env: MYSQL_USER/PASSWORD <- test account, MYSQL_DATABASE <- test DB.
//   d. DROP + CREATE the test DB, initDb() in a child process, insert one
//      placeholder user (so the first user a test registers is not platform_admin).
//   e. node --test --test-concurrency=1 <forwarded args>; exit with its code.
//      With no forwarded args, an explicit sorted list of test/**/*.test.{js,mjs}
//      (minus test/helpers/ and test/fixtures/) is passed instead of relying on
//      node's default discovery, which also matches lib/ and scripts/ files.
//
// Any failed check exits non-zero before anything is created or run.
// Usage: npm test [-- <node --test args / files>]
// Flags must come BEFORE file arguments (node --test treats everything after a file as
// another file): npm test -- --test-name-pattern=X test/file.js

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const mysql = require('mysql2/promise');
const config = require('../config');
const mysqlTls = require('../lib/mysql-tls');
const { isAllowedTestDbName } = require('../lib/test-db-guard');

const SERVER_DIR = path.join(__dirname, '..');
const PLACEHOLDER_USER_ID = 'test-runner-placeholder';
const PLACEHOLDER_EMAIL = 'placeholder@test-runner.local';

function refuse(msg) {
  console.error(`[run-tests] REFUSED: ${msg}`);
  process.exit(1);
}

function connectionOptions(user, password) {
  const o = { host: config.mysqlHost, port: config.mysqlPort, user, password };
  if (config.mysqlSocketPath) o.socketPath = config.mysqlSocketPath;
  const ssl = mysqlTls.mysqlSslOptions(config);
  if (ssl) o.ssl = ssl;
  return o;
}

// Every test/**/*.test.js / *.test.mjs, outside test/helpers/ and test/fixtures/,
// as sorted forward-slash paths relative to SERVER_DIR.
function listTestFiles() {
  const testDir = path.join(SERVER_DIR, 'test');
  const skip = new Set([path.join(testDir, 'helpers'), path.join(testDir, 'fixtures')]);
  const files = [];
  (function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { if (!skip.has(full)) walk(full); }
      else if (/\.test\.m?js$/.test(ent.name)) files.push(path.relative(SERVER_DIR, full).split(path.sep).join('/'));
    }
  })(testDir);
  return files.sort();
}

// One SHOW GRANTS line is acceptable only as USAGE on *.* or a grant on `beamos\_test%`.
function grantProblem(line) {
  const m = /^GRANT (.+?) ON (\S+) TO /.exec(line);
  if (!m) return 'unrecognised grant';
  const [, privs, target] = m;
  if (target === '*.*') return privs === 'USAGE' ? null : 'global privileges';
  if (target.startsWith('`beamos\\_test%`.')) return null;
  return 'grant on a database other than `beamos\\_test%`';
}

async function main() {
  const forwardedArgs = process.argv.slice(2);
  const testUser = process.env.MYSQL_TEST_USER;
  const testPassword = process.env.MYSQL_TEST_PASSWORD;
  const testDb = process.env.MYSQL_TEST_DATABASE || 'beamos_test';
  const devDb = config.mysqlDatabase;
  const devUser = config.mysqlUser;

  // a. configuration
  if (!testUser) refuse('MYSQL_TEST_USER is not set (server/.env).');
  if (!testPassword) refuse('MYSQL_TEST_PASSWORD is not set (server/.env).');
  if (!isAllowedTestDbName(testDb)) refuse(`test database "${testDb}" must be "beamos_test" or start with "beamos_test_".`);
  if (testDb === devDb) refuse(`test database "${testDb}" is the dev database (MYSQL_DATABASE).`);
  if (testUser === devUser) refuse(`MYSQL_TEST_USER "${testUser}" is the dev user (MYSQL_USER).`);

  // b. the test account really is restricted
  let conn;
  try {
    conn = await mysql.createConnection(connectionOptions(testUser, testPassword));
  } catch (e) {
    refuse(`cannot connect as test user "${testUser}": ${e.code || ''} ${e.message}`);
  }
  try {
    let devAccessible = false;
    try {
      await conn.query(`USE \`${devDb}\``);
      devAccessible = true;
    } catch (e) {
      if (e.code !== 'ER_DBACCESS_DENIED_ERROR') refuse(`USE \`${devDb}\` as "${testUser}" failed with ${e.code} (expected ER_DBACCESS_DENIED_ERROR): ${e.message}`);
    }
    if (devAccessible) refuse(`test user "${testUser}" can USE the dev database "${devDb}".`);

    const [grants] = await conn.query('SHOW GRANTS FOR CURRENT_USER()');
    for (const row of grants) {
      const line = Object.values(row)[0];
      const problem = grantProblem(line);
      if (problem) refuse(`test user has a disallowed grant (${problem}): ${line}`);
    }

    // c. child environment
    const env = { ...process.env, MYSQL_USER: testUser, MYSQL_PASSWORD: testPassword, MYSQL_DATABASE: testDb };

    // d. reset the test database
    if (!isAllowedTestDbName(testDb)) refuse(`test database "${testDb}" breaks the name rule.`);
    await conn.query(`DROP DATABASE IF EXISTS \`${testDb}\``);
    await conn.query(`CREATE DATABASE \`${testDb}\``);
    await conn.end();
    conn = null;

    const init = spawnSync(process.execPath, ['-e', `
      require('./lib/test-db-guard').assertSafeTestDb({ database: process.env.MYSQL_DATABASE, user: process.env.MYSQL_USER });
      const { initDb, db } = require('./db/database');
      (async () => {
        try {
          await initDb();
          await db.prepare("INSERT INTO users (id, email, name, role) VALUES (?, ?, 'Test runner placeholder', 'user')")
            .run(${JSON.stringify(PLACEHOLDER_USER_ID)}, ${JSON.stringify(PLACEHOLDER_EMAIL)});
          const { n } = await db.prepare('SELECT COUNT(*) AS n FROM users').get();
          if (Number(n) !== 1) throw new Error('expected exactly 1 user after reset, found ' + n);
        } finally { await db.close(); }
      })().catch((e) => { console.error(e); process.exit(1); });
    `], { cwd: SERVER_DIR, env, stdio: ['ignore', 'ignore', 'inherit'] });
    if (init.status !== 0) refuse(`initDb() on "${testDb}" failed (exit ${init.status}).`);
    console.log(`[run-tests] ${testDb} reset as ${testUser} (schema + 1 placeholder user)`);

    // e. run the tests (forwarded flags are kept; pass flag values as --flag=value)
    const hasFileArgs = forwardedArgs.some((a) => !a.startsWith('-'));
    const runArgs = hasFileArgs ? forwardedArgs : [...forwardedArgs, ...listTestFiles()];
    console.log(`[run-tests] running ${hasFileArgs ? forwardedArgs.filter((a) => !a.startsWith('-')).length : runArgs.length - forwardedArgs.length} test file(s)`);
    const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...runArgs], { cwd: SERVER_DIR, env, stdio: 'inherit' });
    child.on('exit', (code, signal) => process.exit(code === null ? 1 : code));
    for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
  } finally {
    if (conn) await conn.end().catch(() => {});
  }
}

main().catch((e) => refuse(e.stack || e.message));
