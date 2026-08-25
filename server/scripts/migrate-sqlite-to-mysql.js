#!/usr/bin/env node
// One-time data migration: copy every row from the old SQLite database into the
// live MySQL database, preserving IDs (including AUTO_INCREMENT integer ids) and
// therefore every FK relationship between rows. This does NOT touch schema - MySQL's
// schema.sql (via initDb()) is the schema source of truth and is applied first.
//
// Usage:
//   node server/scripts/migrate-sqlite-to-mysql.js --dry-run
//     Preview only: prints per-table row counts and any column drift between the
//     SQLite source and the MySQL target. Writes nothing.
//
//   node server/scripts/migrate-sqlite-to-mysql.js --yes
//     Runs for real. Takes a mysqldump snapshot of the MySQL target first (same
//     backup mechanism database.js uses before a schema migration), then copies
//     every table.
//
//   Options:
//     --sqlite-path <path>   Defaults to server/db/remote_display.db
//     --skip <a,b,c>         Comma-separated table names to skip entirely
//     --include-schema-migrations
//                             Also copy the schema_migrations bookkeeping table
//                             (excluded by default - it's SQLite-migration-runner
//                             bookkeeping with no MySQL equivalent meaning; nothing
//                             in the app reads its row contents, only checks the
//                             table exists - see lib/schema-check.js)
//     --yes                  Required to actually write (no interactive prompt in
//                             non-TTY contexts, e.g. CI or a piped shell)
//
// Safe to re-run: every table is copied with
//   INSERT INTO t (...) VALUES (...) ON DUPLICATE KEY UPDATE col = VALUES(col), ...
// so a second run re-syncs any row whose source values changed and no-ops on rows
// that already match, rather than erroring on duplicate keys (SQLite is treated as
// the authoritative source on every column for every re-run).
//
// FOREIGN_KEY_CHECKS is disabled for the whole copy (same discipline schema.sql
// itself uses) so table order doesn't need to be a strict topological sort - it's
// still copied roughly parent-first (matching schema.sql's declaration order) for
// readable progress output.

const path = require('path');
const { execFile } = require('child_process');
const fs = require('fs');
const Database = require('better-sqlite3');
const mysql = require('mysql2/promise');
const config = require('../config');
const { initDb } = require('../db/database');

function parseArgs(argv) {
  const args = { skip: new Set(), dryRun: false, yes: false, includeSchemaMigrations: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--yes') args.yes = true;
    else if (a === '--include-schema-migrations') args.includeSchemaMigrations = true;
    else if (a === '--sqlite-path') args.sqlitePath = argv[++i];
    else if (a === '--skip') String(argv[++i] || '').split(',').map(s => s.trim()).filter(Boolean).forEach(t => args.skip.add(t));
    else if (a === '--help' || a === '-h') args.help = true;
  }
  if (!args.sqlitePath) args.sqlitePath = path.join(__dirname, '..', 'db', 'remote_display.db');
  return args;
}

// Declaration order from server/db/schema.sql (roughly parents-first; FK_CHECKS=0
// makes exact ordering non-load-bearing for correctness, this is just for log
// readability). AUTO_INCREMENT integer-id tables are flagged so their MySQL
// auto_increment counter gets bumped past the migrated max after copying.
const TABLES = [
  { name: 'plans' },
  { name: 'users' },
  { name: 'totp_recovery_codes' },
  { name: 'organizations' },
  { name: 'organization_members', autoIncrement: true },
  { name: 'workspaces' },
  { name: 'workspace_members', autoIncrement: true },
  { name: 'workspace_invites' },
  { name: 'devices' },
  { name: 'device_telemetry', autoIncrement: true },
  { name: 'content' },
  { name: 'assignments', autoIncrement: true },
  { name: 'screenshots', autoIncrement: true },
  { name: 'layouts' },
  { name: 'layout_zones' },
  { name: 'widgets' },
  { name: 'schedules' },
  { name: 'video_walls' },
  { name: 'video_wall_devices', autoIncrement: true },
  { name: 'teams' },
  { name: 'team_members', autoIncrement: true },
  { name: 'team_invites' },
  { name: 'play_logs', autoIncrement: true },
  { name: 'device_groups' },
  { name: 'device_group_members' },
  { name: 'playlists' },
  { name: 'playlist_items', autoIncrement: true },
  { name: 'playlist_item_schedules' },
  { name: 'content_folders' },
  { name: 'activity_log', autoIncrement: true },
  { name: 'white_labels' },
  { name: 'ai_settings' },
  { name: 'kiosk_pages' },
  { name: 'device_status_log', autoIncrement: true },
  { name: 'event_loop_lag', autoIncrement: true },
  { name: 'device_fingerprints' },
  { name: 'alert_configs' },
  { name: 'player_debug_logs', autoIncrement: true },
  { name: 'api_tokens' },
  { name: 'api_token_targets' },
  { name: 'agency_notifications', autoIncrement: true },
  { name: 'app_settings' },
  { name: 'device_usage_daily' },
  { name: 'schema_migrations', excludedByDefault: true },
];

function getSqliteColumns(sqliteDb, table) {
  const exists = sqliteDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(table);
  if (!exists) return null;
  return sqliteDb.prepare(`PRAGMA table_info("${table}")`).all().map(c => c.name);
}

async function getMysqlColumns(conn, table) {
  const [rows] = await conn.query(
    'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
    [config.mysqlDatabase, table],
  );
  if (rows.length === 0) return null;
  return rows.map(r => r.COLUMN_NAME);
}

function toMysqlValue(v) {
  // schema.sql has no binary-typed columns - better-sqlite3 only returns a Buffer
  // for BLOB-affinity columns, which shouldn't occur here, but normalize defensively
  // so a stray one doesn't insert as raw binary into a TEXT/VARCHAR column.
  if (Buffer.isBuffer(v)) return v.toString('utf8');
  return v;
}

const BATCH_SIZE = 500;

async function migrateTable(sqliteDb, conn, tableName, { dryRun }) {
  const sqliteCols = getSqliteColumns(sqliteDb, tableName);
  if (!sqliteCols) {
    console.log(`  [skip] ${tableName}: not present in source SQLite database`);
    return { table: tableName, sourceRows: 0, copied: 0 };
  }
  const mysqlCols = await getMysqlColumns(conn, tableName);
  if (!mysqlCols) {
    console.log(`  [skip] ${tableName}: not present in MySQL schema (unexpected - is schema.sql out of date?)`);
    return { table: tableName, sourceRows: 0, copied: 0 };
  }

  const mysqlColSet = new Set(mysqlCols);
  const sqliteColSet = new Set(sqliteCols);
  const commonCols = mysqlCols.filter(c => mysqlColSet.has(c) && sqliteColSet.has(c));
  const droppedCols = sqliteCols.filter(c => !mysqlColSet.has(c));
  const defaultedCols = mysqlCols.filter(c => !sqliteColSet.has(c));

  const rows = sqliteDb.prepare(`SELECT ${commonCols.map(c => `"${c}"`).join(', ')} FROM "${tableName}"`).all();

  console.log(`  ${tableName}: ${rows.length} row(s)` +
    (droppedCols.length ? `, dropping column(s) not in MySQL: ${droppedCols.join(', ')}` : '') +
    (defaultedCols.length ? `, MySQL-only column(s) left at DEFAULT: ${defaultedCols.join(', ')}` : ''));

  if (dryRun || rows.length === 0) return { table: tableName, sourceRows: rows.length, copied: 0 };

  const colList = commonCols.map(c => `\`${c}\``).join(', ');
  const updateClause = commonCols.map(c => `\`${c}\` = VALUES(\`${c}\`)`).join(', ');
  const sql = `INSERT INTO \`${tableName}\` (${colList}) VALUES ? ON DUPLICATE KEY UPDATE ${updateClause}`;

  let copied = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE).map(row => commonCols.map(c => toMysqlValue(row[c])));
    await conn.query(sql, [batch]);
    copied += batch.length;
  }
  return { table: tableName, sourceRows: rows.length, copied };
}

async function bumpAutoIncrement(conn, tableName) {
  const [rows] = await conn.query(`SELECT MAX(id) as maxId FROM \`${tableName}\``);
  const maxId = rows[0]?.maxId;
  if (maxId == null) return;
  await conn.query(`ALTER TABLE \`${tableName}\` AUTO_INCREMENT = ?`, [maxId + 1]);
}

// Same mysqldump-based snapshot mechanism as db/database.js's snapshotDatabase(),
// duplicated here (kept self-contained rather than exporting an internal function
// from database.js for a one-time script's sake).
async function snapshotTarget(label) {
  const dir = path.join(__dirname, '..', 'db', 'backups');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(dir, `${config.mysqlDatabase}.${label}-${ts}.sql`);
  const args = [
    `--host=${config.mysqlHost}`,
    `--port=${config.mysqlPort}`,
    `--user=${config.mysqlUser}`,
    `--result-file=${outPath}`,
    '--single-transaction',
    '--routines',
    '--triggers',
    config.mysqlDatabase,
  ];
  await new Promise((resolve, reject) => {
    execFile('mysqldump', args, { env: { ...process.env, MYSQL_PWD: config.mysqlPassword } }, (err) => {
      if (err) return reject(new Error(`mysqldump failed: ${err.message}`));
      console.log(`[snapshot] pre-migration MySQL backup written: ${outPath}`);
      resolve();
    });
  });
}

function confirm(question) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) return resolve(false);
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => { rl.close(); resolve(/^y(es)?$/i.test(answer.trim())); });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').filter(l => l.startsWith('//')).map(l => l.slice(3)).join('\n'));
    return 0;
  }

  if (!fs.existsSync(args.sqlitePath)) {
    console.error(`ERROR: SQLite source not found at ${args.sqlitePath}`);
    return 1;
  }

  console.log(`Source (SQLite): ${args.sqlitePath}`);
  console.log(`Target (MySQL):  ${config.mysqlHost}:${config.mysqlPort}/${config.mysqlDatabase}`);
  console.log(args.dryRun ? 'Mode: DRY RUN (no writes)\n' : 'Mode: LIVE (will write to MySQL)\n');

  if (!args.dryRun && !args.yes) {
    const ok = await confirm(`This will write to MySQL database "${config.mysqlDatabase}" on ${config.mysqlHost}. Continue? [y/N] `);
    if (!ok) {
      console.error('Aborted. Re-run with --yes to skip this prompt (e.g. in a non-interactive shell), or --dry-run to preview first.');
      return 1;
    }
  }

  // Make sure the target schema exists/is current before copying any rows.
  await initDb();

  if (!args.dryRun) {
    await snapshotTarget('pre-sqlite-migration');
  }

  const sqliteDb = new Database(args.sqlitePath, { readonly: true });
  const conn = await mysql.createConnection({
    host: config.mysqlHost,
    port: config.mysqlPort,
    user: config.mysqlUser,
    password: config.mysqlPassword,
    database: config.mysqlDatabase,
    socketPath: config.mysqlSocketPath || undefined,
    decimalNumbers: true,
  });

  try {
    if (!args.dryRun) await conn.query('SET FOREIGN_KEY_CHECKS = 0');

    const results = [];
    for (const t of TABLES) {
      if (args.skip.has(t.name)) { console.log(`  [skip] ${t.name}: excluded via --skip`); continue; }
      if (t.excludedByDefault && !args.includeSchemaMigrations) {
        console.log(`  [skip] ${t.name}: excluded by default (pass --include-schema-migrations to copy it)`);
        continue;
      }
      const result = await migrateTable(sqliteDb, conn, t.name, { dryRun: args.dryRun });
      results.push(result);
      if (!args.dryRun && t.autoIncrement && result.copied > 0) {
        await bumpAutoIncrement(conn, t.name);
      }
    }

    if (!args.dryRun) await conn.query('SET FOREIGN_KEY_CHECKS = 1');

    const totalSource = results.reduce((s, r) => s + r.sourceRows, 0);
    const totalCopied = results.reduce((s, r) => s + r.copied, 0);
    console.log(`\n${args.dryRun ? 'Would copy' : 'Copied'} ${args.dryRun ? totalSource : totalCopied} row(s) across ${results.filter(r => r.sourceRows > 0).length} non-empty table(s).`);
    if (args.dryRun) console.log('Dry run complete - no changes were made. Re-run with --yes to perform the migration.');
  } finally {
    sqliteDb.close();
    await conn.end();
  }

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => { console.error('FATAL:', e); process.exit(1); });
