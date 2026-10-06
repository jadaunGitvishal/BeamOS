#!/usr/bin/env node
// Ref 2 Stage 3: one-time backfill - convert legacy PLAINTEXT devices.device_token
// values to their one-way 'sha256:<hex>' form (lib/device-token.js). Devices keep
// working throughout and need no change: they keep presenting the same raw token,
// and the server verifies BOTH forms. New tokens are already stored hashed; this
// only converts rows minted before that change.
//
// Usage:
//   node server/scripts/hash-device-tokens.js --dry-run
//     Preview only: counts hashed / plaintext / empty rows. Writes nothing.
//
//   node server/scripts/hash-device-tokens.js --yes
//     Runs for real. Takes a mysqldump snapshot of the `devices` table first, then
//     hashes every plaintext token.
//
//   Options:
//     --no-snapshot   Skip the snapshot (e.g. you have your own fresh backup).
//     --yes           Required to write (no interactive prompt in non-TTY contexts).
//
// READ BEFORE --yes:
//   - IRREVERSIBLE. A hash can't be turned back into the token. The snapshot is
//     the only way back to plaintext, and code older than the Ref 2 Stage 3
//     commit can't verify hashed rows - a downgrade after this runs locks those
//     devices out until the snapshot is restored or they are re-paired.
//   - The snapshot CONTAINS THE PLAINTEXT TOKENS (it is the pre-migration table).
//     It lands in server/db/backups/ (gitignored). Once the rollout is confirmed,
//     delete it or move it to secured storage - leaving it on disk keeps exactly
//     the exposure this migration removes.
//   - Safe to re-run: already-hashed rows are skipped, and each UPDATE is
//     compare-and-set on the old value, so a token rotated concurrently (e.g. a
//     fingerprint reclaim mid-run) is never overwritten.

const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { hashDeviceToken, isHashed } = require('../lib/device-token');
const mysqlTls = require('../lib/mysql-tls');

// Pure core, exported for tests. `db` is db/database.js's { prepare } wrapper.
async function backfillDeviceTokens(db, { dryRun }) {
  const rows = await db.prepare('SELECT id, device_token FROM devices').all();
  const counts = { total: rows.length, alreadyHashed: 0, empty: 0, plaintext: 0, converted: 0, changedConcurrently: 0 };
  const update = db.prepare('UPDATE devices SET device_token = ? WHERE id = ? AND device_token = ?');
  for (const r of rows) {
    if (!r.device_token) { counts.empty++; continue; }
    if (isHashed(r.device_token)) { counts.alreadyHashed++; continue; }
    counts.plaintext++;
    if (dryRun) continue;
    const res = await update.run(hashDeviceToken(r.device_token), r.id, r.device_token);
    if (res && res.changes === 0) counts.changedConcurrently++;
    else counts.converted++;
  }
  return counts;
}

// Table-scoped variant of db/database.js's mysqldump snapshot (same approach as
// scripts/migrate-sqlite-to-mysql.js's snapshotTarget, limited to `devices`).
async function snapshotDevices(config) {
  const dir = path.join(__dirname, '..', 'db', 'backups');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(dir, `${config.mysqlDatabase}.devices.pre-device-token-hash-${ts}.sql`);
  // Ref 2: verified TLS when MYSQL_SSL is on ([] when off).
  let tlsArgs;
  try {
    tlsArgs = await mysqlTls.resolveMysqldumpTlsArgs(config);
  } catch (e) {
    throw new Error(`mysqldump failed: ${e.message} (use --no-snapshot only if you have your own backup)`);
  }
  const args = [
    `--host=${config.mysqlHost}`, `--port=${config.mysqlPort}`, `--user=${config.mysqlUser}`, ...tlsArgs,
    `--result-file=${outPath}`, '--single-transaction', config.mysqlDatabase, 'devices',
  ];
  await new Promise((resolve, reject) => {
    execFile('mysqldump', args, { env: { ...process.env, MYSQL_PWD: config.mysqlPassword } }, (err) => {
      if (err) return reject(new Error(`mysqldump failed: ${err.message} (use --no-snapshot only if you have your own backup)`));
      resolve();
    });
  });
  return outPath;
}

function confirm(question) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) return resolve(false);
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => { rl.close(); resolve(/^y(es)?$/i.test(answer.trim())); });
  });
}

async function main(argv) {
  const args = { dryRun: argv.includes('--dry-run'), yes: argv.includes('--yes'), snapshot: !argv.includes('--no-snapshot') };
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
    return 0;
  }
  const config = require('../config');
  // Ref 2: refuse an invalid MYSQL_SSL setup before anything connects.
  try {
    mysqlTls.validateMysqlTls(config);
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    return 1;
  }
  const { initDb, db } = require('../db/database');
  console.log(`Target (MySQL): ${config.mysqlHost}:${config.mysqlPort}/${config.mysqlDatabase}`);
  console.log(args.dryRun ? 'Mode: DRY RUN (no writes)\n' : 'Mode: LIVE (will hash plaintext device tokens - irreversible)\n');

  if (!args.dryRun && !args.yes) {
    const ok = await confirm(`Hash every plaintext devices.device_token in "${config.mysqlDatabase}"? This cannot be undone except from the snapshot. [y/N] `);
    if (!ok) {
      console.error('Aborted. Re-run with --yes to skip this prompt, or --dry-run to preview first.');
      return 1;
    }
  }

  await initDb();
  try {
    if (!args.dryRun && args.snapshot) {
      const out = await snapshotDevices(config);
      console.log(`[snapshot] devices table written: ${out}`);
      console.log('[snapshot] WARNING: this file contains the PLAINTEXT device tokens. Delete it or move it to secured storage once the rollout is confirmed.\n');
    }
    const c = await backfillDeviceTokens(db, { dryRun: args.dryRun });
    console.log(`devices: ${c.total} total, ${c.alreadyHashed} already hashed, ${c.empty} without a token, ${c.plaintext} plaintext`);
    if (args.dryRun) console.log(`Dry run complete - ${c.plaintext} row(s) would be hashed. Re-run with --yes to perform the backfill.`);
    else console.log(`Hashed ${c.converted} row(s)${c.changedConcurrently ? `; ${c.changedConcurrently} skipped because the token changed mid-run (already re-issued hashed)` : ''}.`);
  } finally {
    await db.close();
  }
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
}

module.exports = { backfillDeviceTokens };
