'use strict';

// Ref 7: the lib/schema-check.js startup repair for entra_role_mappings and the
// organization_members / workspace_members `source` columns, run TWICE against a
// throwaway MySQL database (created and dropped here, so the shared dev schema
// is never altered). The scratch DB holds the pre-Ref-7 shape of the tables the
// new DDL references. Run 1 must create/add and log; run 2 must be a no-op.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mysql = require('mysql2/promise');

const config = require('../config');
const mysqlTls = require('../lib/mysql-tls');
const { verifyAndRepairSchema } = require('../lib/schema-check');

const DB_NAME = `beamos_ref7_repair_${crypto.randomBytes(4).toString('hex')}`;
let pool;
let handle;

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

test.before(async () => {
  const admin = await mysql.createConnection(baseOptions());
  await admin.query(`CREATE DATABASE \`${DB_NAME}\``);
  await admin.end();
  pool = mysql.createPool({ ...baseOptions(), database: DB_NAME, connectionLimit: 2 });
  handle = makeHandle(pool);
  // Pre-Ref-7 shape (only the columns the new DDL and repairs touch).
  for (const ddl of [
    'CREATE TABLE users (id VARCHAR(64) PRIMARY KEY) ENGINE=InnoDB',
    'CREATE TABLE organizations (id VARCHAR(64) PRIMARY KEY) ENGINE=InnoDB',
    'CREATE TABLE workspaces (id VARCHAR(64) PRIMARY KEY, organization_id VARCHAR(64) NOT NULL) ENGINE=InnoDB',
    "CREATE TABLE organization_members (id INT AUTO_INCREMENT PRIMARY KEY, organization_id VARCHAR(64) NOT NULL, user_id VARCHAR(64) NOT NULL, role VARCHAR(50) NOT NULL DEFAULT 'org_admin') ENGINE=InnoDB",
    "CREATE TABLE workspace_members (id INT AUTO_INCREMENT PRIMARY KEY, workspace_id VARCHAR(64) NOT NULL, user_id VARCHAR(64) NOT NULL, role VARCHAR(50) NOT NULL DEFAULT 'workspace_viewer') ENGINE=InnoDB",
  ]) await handle.exec(ddl);
  await handle.exec("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('w', 'u', 'workspace_admin')");
});

test.after(async () => {
  try { await pool.query(`DROP DATABASE \`${DB_NAME}\``); } finally { await pool.end(); }
});

async function runCapturingLogs() {
  const logs = [];
  const warn = console.warn;
  const error = console.error;
  console.warn = (...a) => logs.push(a.join(' '));
  console.error = (...a) => logs.push(`ERROR ${a.join(' ')}`);
  let missing;
  try {
    // The scratch DB lacks most REQUIRED_TABLES on purpose; collect, don't exit.
    missing = await verifyAndRepairSchema(handle, { onMissing: () => {} });
  } finally {
    console.warn = warn;
    console.error = error;
  }
  // Only Ref 7's lines (incl. any ERROR about them): the scratch DB also triggers
  // unrelated repairs/failures for tables it doesn't have (e.g. regions).
  return { logs: logs.filter((l) => /entra_role_mappings|\.source\b/.test(l)), missing };
}

const columnExists = async (t, c) =>
  !!(await handle.prepare('SELECT 1 AS x FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?').get(t, c));

test('startup repair: run 1 creates entra_role_mappings and adds both source columns (logged); run 2 is a no-op', async () => {
  assert.equal(await columnExists('organization_members', 'source'), false);
  assert.equal(await columnExists('workspace_members', 'source'), false);

  const run1 = await runCapturingLogs();
  assert.deepEqual(run1.logs, [
    '[schema-check] required table entra_role_mappings is missing — creating it...',
    '[schema-check] created table entra_role_mappings',
    '[schema-check] required column organization_members.source is missing — applying repair...',
    '[schema-check] repaired organization_members.source',
    '[schema-check] required column workspace_members.source is missing — applying repair...',
    '[schema-check] repaired workspace_members.source',
  ]);
  assert.ok(!run1.missing.some((m) => /entra_role_mappings|\.source/.test(m)), JSON.stringify(run1.missing));
  assert.equal(await columnExists('organization_members', 'source'), true);
  assert.equal(await columnExists('workspace_members', 'source'), true);
  assert.equal(await columnExists('entra_role_mappings', 'workspace_key'), true);
  const existing = await handle.prepare('SELECT role, source FROM workspace_members').all();
  assert.deepEqual(existing.map((r) => ({ ...r })), [{ role: 'workspace_admin', source: null }], 'existing rows stay manual');

  const ddl = (await handle.prepare('SHOW CREATE TABLE entra_role_mappings').get())['Create Table'];
  assert.match(ddl, /UNIQUE KEY `uniq_entra_role_mapping` \(`organization_id`,`claim_value`,`workspace_key`\)/);
  assert.match(ddl, /FOREIGN KEY \(`created_by`\) REFERENCES `users` \(`id`\) ON DELETE SET NULL/);
  assert.match(ddl, /FOREIGN KEY \(`workspace_id`\) REFERENCES `workspaces` \(`id`\) ON DELETE CASCADE/);
  assert.match(ddl, /FOREIGN KEY \(`organization_id`\) REFERENCES `organizations` \(`id`\) ON DELETE CASCADE/);

  const run2 = await runCapturingLogs();
  assert.deepEqual(run2.logs, [], 'second run changes nothing');
  assert.deepEqual(run2.missing, run1.missing);
});
