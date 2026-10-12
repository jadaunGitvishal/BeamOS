'use strict';

// #37: verifyAndRepairSchema - repairs missing repairable columns, and reports
// (fail-fast hook) anything still missing. We inject onMissing so the fail path
// doesn't call process.exit during tests.
//
// Runs against a throwaway MySQL database (created and dropped here, so the shared
// test schema is never damaged), built from the real db/schema.sql - i.e. exactly
// what a fresh install has. The tests run in order on it: healthy check, then a
// dropped repairable column, then a dropped required table.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');

const config = require('../config');
const mysqlTls = require('../lib/mysql-tls');
const { assertSafeTestDb, isAllowedTestDbName } = require('../lib/test-db-guard');
const { verifyAndRepairSchema } = require('../lib/schema-check');

const DB_NAME = `beamos_test_schema_check_${crypto.randomBytes(4).toString('hex')}`;
let pool;
let db;

function baseOptions() {
  const o = { host: config.mysqlHost, port: config.mysqlPort, user: config.mysqlUser, password: config.mysqlPassword };
  if (config.mysqlSocketPath) o.socketPath = config.mysqlSocketPath;
  const ssl = mysqlTls.mysqlSslOptions(config);
  if (ssl) o.ssl = ssl;
  return o;
}

// Same { prepare().get/all/run, exec } shape as db/database.js.
function makeHandle(q) {
  return {
    prepare(sql) {
      return {
        async get(...p) { return (await q.query(sql, p))[0][0]; },
        async all(...p) { return (await q.query(sql, p))[0]; },
        async run(...p) { const [r] = await q.query(sql, p); return { changes: r.affectedRows, lastInsertRowid: r.insertId }; },
      };
    },
    async exec(sql) { await q.query(sql); },
  };
}

// db/schema.sql statement by statement - same comment stripping / ';' split as
// db/database.js splitSqlStatements().
function schemaStatements() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  return sql.split('\n').map((line) => { const i = line.indexOf('--'); return i === -1 ? line : line.slice(0, i); })
    .join('\n').split(';').map((s) => s.trim()).filter(Boolean);
}

const hasCol = async (t, c) => !!(await db.prepare(
  'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?'
).get(t, c));

test.before(async () => {
  assertSafeTestDb({ database: DB_NAME, user: config.mysqlUser });
  const admin = await mysql.createConnection(baseOptions());
  await admin.query(`CREATE DATABASE \`${DB_NAME}\``);
  await admin.end();
  pool = mysql.createPool({ ...baseOptions(), database: DB_NAME, connectionLimit: 2 });
  db = makeHandle(pool);
  // Same tolerance as db/database.js applySchema() (its BENIGN_DDL_ERRORS).
  const BENIGN = new Set(['ER_DUP_FIELDNAME', 'ER_TABLE_EXISTS_ERROR', 'ER_DUP_KEYNAME']);
  for (const stmt of schemaStatements()) {
    try { await db.exec(stmt); } catch (e) { if (!BENIGN.has(e.code)) throw e; }
  }
});

test.after(async () => {
  if (!pool) return;
  try {
    if (!(isAllowedTestDbName(DB_NAME) && DB_NAME.startsWith('beamos_test_'))) throw new Error(`refusing to drop non-scratch database ${DB_NAME}`);
    await pool.query(`DROP DATABASE \`${DB_NAME}\``);
  } finally { await pool.end(); }
});

test('healthy schema: nothing missing, onMissing not called', async () => {
  let called = false;
  const missing = await verifyAndRepairSchema(db, { onMissing: () => { called = true; } });
  assert.deepEqual(missing, []);
  assert.equal(called, false);
});

test('missing repairable column (must_change_password) is auto-repaired - no fail', async () => {
  await db.exec('ALTER TABLE users DROP COLUMN must_change_password');
  assert.equal(await hasCol('users', 'must_change_password'), false, 'precondition: column absent');
  let called = false;
  const missing = await verifyAndRepairSchema(db, { onMissing: () => { called = true; } });
  assert.deepEqual(missing, [], 'no residual missing after repair');
  assert.equal(called, false, 'onMissing not called when repair succeeds');
  assert.equal(await hasCol('users', 'must_change_password'), true, 'column was added');
});

test('missing required table -> reported to onMissing (fail-fast hook fires)', async () => {
  await db.exec('DROP TABLE activity_log');
  let got = null;
  await verifyAndRepairSchema(db, { onMissing: (m) => { got = m; } });
  assert.ok(got && got.some(x => /activity_log/.test(x)), 'reported the missing table');
});
