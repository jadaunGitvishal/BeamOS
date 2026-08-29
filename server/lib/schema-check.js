'use strict';

// #37: verify the DB has the schema the running code REQUIRES, after all
// migrations have run. On a partial/stale DB (e.g. a Docker rebuild that missed a
// migration) it repairs missing repairable columns idempotently and logs clearly;
// if anything required is STILL missing it calls onMissing (default: loud log +
// process.exit(1)) so the server fails fast at boot instead of limping along and
// breaking at the first authed request. The #37 lockout was a silently-absent
// users.must_change_password, which the auth middleware gates every request on.

// Tables the request path depends on (schema.sql creates them with CREATE TABLE
// IF NOT EXISTS on every boot; listed so their absence is still caught loudly).
const REQUIRED_TABLES = [
  'users', 'organizations', 'organization_members', 'workspaces', 'workspace_members',
  'devices', 'content', 'playlists', 'activity_log', 'schema_migrations',
];

// [table, column, repairSQL] — columns the code SELECTs / gates on. repairSQL is
// the idempotent ALTER that adds it if missing (null = base column, assert only).
const REQUIRED_COLUMNS = [
  ['users', 'must_change_password', "ALTER TABLE users ADD COLUMN must_change_password TINYINT(1) NOT NULL DEFAULT 0"],
  ['users', 'role', null],
  ['users', 'plan_id', "ALTER TABLE users ADD COLUMN plan_id VARCHAR(64) DEFAULT 'free'"],
  ['play_logs', 'session_id', "ALTER TABLE play_logs ADD COLUMN session_id VARCHAR(64) NULL, ADD UNIQUE KEY uniq_play_logs_session (session_id)"],
  // Ref 32: GPS location on telemetry rows. The heartbeat INSERT (ws/deviceSocket.js)
  // always lists these columns now, so an un-migrated DB would fail every telemetry
  // write until repaired. Nullable, no default - absent lat/long is the norm.
  ['device_telemetry', 'latitude', "ALTER TABLE device_telemetry ADD COLUMN latitude DOUBLE NULL"],
  ['device_telemetry', 'longitude', "ALTER TABLE device_telemetry ADD COLUMN longitude DOUBLE NULL"],
];

function defaultOnMissing(missing) {
  const bar = '='.repeat(72);
  console.error(`\n${bar}`);
  console.error('[schema-check] FATAL: database is missing required schema:');
  for (const m of missing) console.error(`  - ${m}`);
  console.error('Migrations did not make the schema code-complete. The server is');
  console.error('refusing to start to avoid silent runtime failures (e.g. issue #37,');
  console.error('where a missing users.must_change_password failed every login).');
  console.error('Fix: restore the newest MySQL backup, or add the missing');
  console.error('column/table manually, then restart.');
  console.error(`${bar}\n`);
  process.exit(1);
}

// Returns the list of still-missing items (empty when healthy). Calls
// opts.onMissing(missing) when non-empty (default exits the process).
// `db` is the thin async wrapper from db/database.js ({ prepare, exec }).
async function verifyAndRepairSchema(db, opts = {}) {
  const onMissing = opts.onMissing || defaultOnMissing;
  const tableRows = await db
    .prepare("SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()")
    .all();
  const tableSet = new Set(tableRows.map((r) => r.name));
  const columns = async (t) => {
    const rows = await db
      .prepare("SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?")
      .all(t);
    return new Set(rows.map((r) => r.name));
  };

  const missing = [];
  for (const t of REQUIRED_TABLES) if (!tableSet.has(t)) missing.push(`table "${t}"`);

  for (const [t, c, repair] of REQUIRED_COLUMNS) {
    if (!tableSet.has(t)) continue; // table-missing already recorded
    let cols = await columns(t);
    if (cols.has(c)) continue;
    if (repair) {
      try {
        console.warn(`[schema-check] required column ${t}.${c} is missing — applying repair...`);
        await db.exec(repair);
        console.warn(`[schema-check] repaired ${t}.${c}`);
      } catch (e) {
        console.error(`[schema-check] repair of ${t}.${c} FAILED: ${e.message}`);
      }
      cols = await columns(t);
    }
    if (!cols.has(c)) missing.push(`column "${t}.${c}"`);
  }

  if (missing.length) onMissing(missing);
  return missing;
}

module.exports = { verifyAndRepairSchema, REQUIRED_TABLES, REQUIRED_COLUMNS };
