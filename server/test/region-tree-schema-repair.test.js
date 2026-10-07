'use strict';

// Refs 49/67: the lib/schema-check.js startup repair that turns a pre-tree
// `regions` table into the tree shape (level + backfill, parent_id, the VIRTUAL
// parent_key, UNIQUE(organization_id, id), per-parent name uniqueness replacing
// UNIQUE(organization_id, name), the same-org parent FK) and creates
// region_viewer_scopes. Run TWICE against a throwaway MySQL database (created and
// dropped here; the shared dev schema is never altered). Run 1 must change and
// log each step; run 2 must be a no-op.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mysql = require('mysql2/promise');

const config = require('../config');
const mysqlTls = require('../lib/mysql-tls');
const { verifyAndRepairSchema } = require('../lib/schema-check');

const DB_NAME = `beamos_ref49_repair_${crypto.randomBytes(4).toString('hex')}`;
let pool;
let handle;

function baseOptions() {
  const o = { host: config.mysqlHost, port: config.mysqlPort, user: config.mysqlUser, password: config.mysqlPassword };
  if (config.mysqlSocketPath) o.socketPath = config.mysqlSocketPath;
  const ssl = mysqlTls.mysqlSslOptions(config);
  if (ssl) o.ssl = ssl;
  return o;
}

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
  // The pre-Refs-49/67 shape of everything the new DDL touches.
  for (const ddl of [
    'CREATE TABLE users (id VARCHAR(64) PRIMARY KEY) ENGINE=InnoDB',
    'CREATE TABLE organizations (id VARCHAR(64) PRIMARY KEY) ENGINE=InnoDB',
    `CREATE TABLE organization_members (id INT AUTO_INCREMENT PRIMARY KEY, organization_id VARCHAR(64) NOT NULL, user_id VARCHAR(64) NOT NULL,
       role VARCHAR(50) NOT NULL, UNIQUE (organization_id, user_id),
       FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
       FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE) ENGINE=InnoDB`,
    `CREATE TABLE regions (id VARCHAR(64) PRIMARY KEY, organization_id VARCHAR(64) NOT NULL, name VARCHAR(255) NOT NULL,
       created_at BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()), updated_at BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
       UNIQUE (organization_id, name), FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE) ENGINE=InnoDB`,
    'CREATE INDEX idx_regions_organization ON regions(organization_id)',
  ]) await handle.exec(ddl);
  await handle.exec("INSERT INTO organizations VALUES ('o1'), ('o2')");
  await handle.exec("INSERT INTO regions (id, organization_id, name) VALUES ('north', 'o1', 'North'), ('south', 'o1', 'South')");
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
    missing = await verifyAndRepairSchema(handle, { onMissing: () => {} });
  } finally {
    console.warn = warn;
    console.error = error;
  }
  return { logs: logs.filter((l) => /regions[:.]|region_viewer_scopes|region tree/.test(l)), missing };
}

const uniqueIndexes = async () => (await handle
  .prepare(
    `SELECT GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'regions' AND NON_UNIQUE = 0 GROUP BY INDEX_NAME`,
  )
  .all()).map((r) => r.cols).sort();

test('repair: run 1 converts regions to the tree shape and creates region_viewer_scopes (logged); run 2 is a no-op', async () => {
  assert.deepEqual(await uniqueIndexes(), ['id', 'organization_id,name']);

  const run1 = await runCapturingLogs();
  assert.deepEqual(run1.logs, [
    '[schema-check] regions: added column level',
    '[schema-check] regions: added column parent_id',
    "[schema-check] regions: backfilled level='region' on 2 existing row(s) (now top-level)",
    '[schema-check] regions: added generated column parent_key',
    '[schema-check] regions: added UNIQUE (organization_id, id)',
    '[schema-check] regions: added UNIQUE (organization_id, parent_key, name)',
    '[schema-check] regions: dropped old UNIQUE (organization_id, name) "organization_id"',
    '[schema-check] regions: added FK (organization_id, parent_id) -> regions(organization_id, id) ON DELETE CASCADE',
    '[schema-check] required table region_viewer_scopes is missing — creating it...',
    '[schema-check] created table region_viewer_scopes',
  ]);
  assert.ok(!run1.missing.some((m) => /regions|region_viewer_scopes/.test(m)), JSON.stringify(run1.missing));
  assert.deepEqual(await uniqueIndexes(), ['id', 'organization_id,id', 'organization_id,parent_key,name']);
  const gen = await handle
    .prepare("SELECT EXTRA AS extra FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'regions' AND COLUMN_NAME = 'parent_key'")
    .get();
  assert.match(gen.extra, /VIRTUAL GENERATED/);
  assert.deepEqual((await handle.prepare('SELECT id, level, parent_id FROM regions ORDER BY id').all()).map((r) => ({ ...r })), [
    { id: 'north', level: 'region', parent_id: null },
    { id: 'south', level: 'region', parent_id: null },
  ]);

  const run2 = await runCapturingLogs();
  assert.deepEqual(run2.logs, [], 'second run changes nothing');
});

test('after the repair: per-parent names, same-org parent FK and the scope FKs all hold', async () => {
  // the same name under different parents is now fine; a top-level duplicate is not
  await handle.exec("INSERT INTO regions (id, organization_id, name, level, parent_id) VALUES ('n-c', 'o1', 'Central', 'cluster', 'north'), ('s-c', 'o1', 'Central', 'cluster', 'south')");
  await assert.rejects(handle.exec("INSERT INTO regions (id, organization_id, name, level) VALUES ('dup', 'o1', 'North', 'region')"), (e) => e.code === 'ER_DUP_ENTRY');
  await assert.rejects(handle.exec("INSERT INTO regions (id, organization_id, name, level, parent_id) VALUES ('x', 'o2', 'X', 'cluster', 'north')"), (e) => e.code === 'ER_NO_REFERENCED_ROW_2');
  await handle.exec("INSERT INTO users (id) VALUES ('u1')"); // the repair also added the usual users columns
  await handle.exec("INSERT INTO organization_members (organization_id, user_id, role) VALUES ('o1', 'u1', 'regional_viewer')");
  await assert.rejects(handle.exec("INSERT INTO region_viewer_scopes (organization_id, user_id, region_id) VALUES ('o2', 'u1', 'north')"), (e) => e.code === 'ER_NO_REFERENCED_ROW_2');
  await handle.exec("INSERT INTO region_viewer_scopes (organization_id, user_id, region_id) VALUES ('o1', 'u1', 'n-c')");
  // deleting the parent cascades the subtree, and the scope on it
  await handle.exec("DELETE FROM regions WHERE id = 'north'");
  assert.equal((await handle.prepare("SELECT COUNT(*) AS n FROM regions WHERE id IN ('north', 'n-c')").get()).n, 0);
  assert.equal((await handle.prepare('SELECT COUNT(*) AS n FROM region_viewer_scopes').get()).n, 0);
});
