const mysql = require("mysql2/promise");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const config = require("../config");
const {
  chunkedDelete,
  yieldTick,
  currentBand,
} = require("../lib/chunked-prune"); // #146 non-blocking sweeps

const poolConfig = {
  host: config.mysqlHost,
  port: config.mysqlPort,
  user: config.mysqlUser,
  password: config.mysqlPassword,
  database: config.mysqlDatabase,
  waitForConnections: true,
  connectionLimit: config.mysqlPoolSize,
  decimalNumbers: true, // return DECIMAL/DOUBLE columns as JS numbers, not strings
};
if (config.mysqlSocketPath) poolConfig.socketPath = config.mysqlSocketPath;

const pool = mysql.createPool(poolConfig);

// Thin wrapper reproducing better-sqlite3's Statement shape (.get/.all/.run) on top of
// mysql2/promise, so the ~800 existing `db.prepare(sql).get(...)`-style call sites across
// the app only need `await` added, not a rewrite. `queryable` is either the pool (ordinary,
// auto-connection-per-call queries) or a single PoolConnection (see transaction() below,
// where every statement in a transaction MUST run on the same connection).
function makeHandle(queryable) {
  return {
    prepare(sql) {
      return {
        async get(...params) {
          const [rows] = await queryable.query(sql, params);
          return rows[0];
        },
        async all(...params) {
          const [rows] = await queryable.query(sql, params);
          return rows;
        },
        async run(...params) {
          const [result] = await queryable.query(sql, params);
          // Field names match better-sqlite3's RunResult so `.changes` / `.lastInsertRowid`
          // call sites keep working unchanged.
          return { changes: result.affectedRows, lastInsertRowid: result.insertId };
        },
      };
    },
    // Raw execute, no params - for DDL and other statements the .prepare() shape doesn't fit.
    async exec(sql) {
      await queryable.query(sql);
    },
  };
}

// better-sqlite3's db.transaction(fn) ran fn's body against the SAME (single, synchronous)
// connection, so callers could freely mix pre-prepared statements bound to the outer `db`.
// With a connection pool that guarantee doesn't hold automatically - every statement in a
// transaction must be pinned to one PoolConnection. So transaction(fn) here returns an async
// function that hands fn a TRANSACTION-SCOPED handle (same .prepare/.exec shape) as its first
// argument; callers MUST use that handle (not the outer `db`) for every statement that needs
// to participate in the transaction. Commits on success, rolls back and rethrows on any error.
function transaction(fn) {
  return async (...args) => {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const tx = makeHandle(conn);
      const result = await fn(tx, ...args);
      await conn.commit();
      return result;
    } catch (e) {
      try {
        await conn.rollback();
      } catch (_) {
        /* connection may already be broken - the original error is what matters */
      }
      throw e;
    } finally {
      conn.release();
    }
  };
}

const db = {
  ...makeHandle(pool),
  transaction,
  async close() {
    await pool.end();
  },
};

// Forward migrations for the LIVE MySQL schema, applied idempotently at every boot. Empty
// at cutover time because server/db/schema.sql already IS the full target shape (every
// historical SQLite ALTER TABLE / CREATE TABLE from the old inline migrations array, and
// from scripts/migrate-multitenancy.js, was folded directly into schema.sql - see that
// file's header). This array - and the apply loop below - exist so the NEXT schema change
// has a ready-made idempotent home; add plain ALTER/CREATE statements here going forward.
const migrations = [];

// MySQL error codes that mean "this DDL already happened" - benign on a re-run, same
// discipline the old SQLite version used for "duplicate column name" / "already exists".
const BENIGN_DDL_ERRORS = new Set([
  "ER_DUP_FIELDNAME", // ALTER TABLE ... ADD COLUMN, column already exists
  "ER_TABLE_EXISTS_ERROR", // CREATE TABLE, table already exists
  "ER_DUP_KEYNAME", // CREATE INDEX, index already exists
]);

async function applyMigrations() {
  if (migrations.length === 0) return;

  // A real (non-empty) migration batch snapshots the DB first - see snapshotDatabase().
  await snapshotDatabase("pre-migration");

  let applied = 0;
  for (const sql of migrations) {
    try {
      await db.exec(sql);
      applied++;
    } catch (e) {
      if (!BENIGN_DDL_ERRORS.has(e.code)) {
        console.error(`[migrate] FAILED: ${sql}\n          -> ${e.message}`);
      }
    }
  }
  if (applied > 0) console.log(`[migrate] applied ${applied} new migration(s)`);
}

// mysqldump-based snapshot, the MySQL equivalent of the old SQLite pre-migration file copy
// (fs.copyFileSync was instant because SQLite IS a file; MySQL has no such free lunch, so
// this shells out to mysqldump - see the "migration safety net" decision in the migration
// plan). Best-effort: a dump failure is logged loudly but does not block boot, since an
// empty `migrations` array (the common case) never calls this at all.
async function snapshotDatabase(label) {
  const dir = path.join(__dirname, "backups");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = path.join(dir, `${config.mysqlDatabase}.${label}-${ts}.sql`);
  const args = [
    `--host=${config.mysqlHost}`,
    `--port=${config.mysqlPort}`,
    `--user=${config.mysqlUser}`,
    `--result-file=${outPath}`,
    "--single-transaction",
    "--routines",
    "--triggers",
    config.mysqlDatabase,
  ];
  await new Promise((resolve) => {
    execFile(
      "mysqldump",
      args,
      { env: { ...process.env, MYSQL_PWD: config.mysqlPassword } },
      (err) => {
        if (err) {
          console.error(`[snapshot] mysqldump failed (continuing anyway): ${err.message}`);
        } else {
          console.log(`[snapshot] pre-migration backup written: ${outPath}`);
        }
        resolve();
      },
    );
  });
}

// Boot-time invariants, re-asserted on EVERY start (not migrations - no schema_migrations
// gating). Ported as-is from the SQLite version's unconditional post-migration UPDATEs.
async function enforceBootInvariants() {
  // BeamOS: force every plan tier to be unlimited on every boot, regardless of what's
  // already in the database (covers existing installs where old limited rows were
  // inserted before this was the default, and any future ones too).
  await db.exec(`
    UPDATE plans SET max_devices = -1, max_storage_mb = -1,
      remote_control = 1, remote_url = 1, priority_support = 1
  `);
  // BeamOS: clear any trial timer on every account, every boot - permanently prevents the
  // (disabled) auto-downgrade logic from ever mattering.
  await db.exec(`UPDATE users SET trial_started = NULL`);
}

// Splits a .sql file into individual executable statements: strips `--` comments
// (full-line and trailing), then splits on `;`. Good enough for OUR schema.sql, which
// we fully control and which contains no semicolons inside string literals - not a
// general-purpose SQL parser.
function splitSqlStatements(sql) {
  const withoutComments = sql
    .split("\n")
    .map((line) => {
      const i = line.indexOf("--");
      return i === -1 ? line : line.slice(0, i);
    })
    .join("\n");
  return withoutComments
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Applies schema.sql statement-by-statement (see BENIGN_DDL_ERRORS / splitSqlStatements
// above) so it can safely re-run on every boot: CREATE TABLE IF NOT EXISTS and INSERT
// IGNORE are natively idempotent, and the standalone CREATE INDEX statements (MySQL has
// no CREATE INDEX IF NOT EXISTS) fall back to swallowing "duplicate key name".
async function applySchema() {
  const schemaSql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  for (const stmt of splitSqlStatements(schemaSql)) {
    try {
      await db.exec(stmt);
    } catch (e) {
      if (!BENIGN_DDL_ERRORS.has(e.code)) {
        console.error(`[schema] FAILED: ${stmt}\n         -> ${e.message}`);
        throw e;
      }
    }
  }
}

let _initialized = false;

// Call once at boot (server.js), BEFORE registering routes/socket handlers. Creates the
// schema (idempotent - safe on every restart), applies any pending forward migrations,
// re-asserts boot invariants, and fails loudly (verifyAndRepairSchema) if the resulting
// schema is still missing something the code requires.
async function initDb() {
  if (_initialized) return db;

  await applySchema();
  await applyMigrations();
  await enforceBootInvariants();

  const { verifyAndRepairSchema } = require("../lib/schema-check");
  await verifyAndRepairSchema(db);

  // Warm the app_settings in-memory cache (lib/app-settings.js) so its get()/getBool()
  // reads - called synchronously inline in the /api/status hot path - never race an
  // empty cache. Required lazily (not at module top) to avoid a require cycle:
  // app-settings.js itself requires this module for `db`.
  const appSettings = require("../lib/app-settings");
  await appSettings.__reload();

  _initialized = true;
  console.log(`[db] MySQL ready (${config.mysqlHost}:${config.mysqlPort}/${config.mysqlDatabase})`);
  return db;
}

// ===================== ONGOING MAINTENANCE (not boot migrations) =====================

// #146 hardening — device_status_log retention sweep. NEVER blocks the loop:
//   - PER DEVICE, walking distinct device_ids via a seek (`WHERE device_id > ? ORDER BY
//     device_id LIMIT 1`);
//   - each device's backlog trims in bounded batches with a yield between batches AND
//     between devices (chunked-prune.js);
//   - async + re-entrancy-guarded so overlapping interval fires don't stack;
//   - band-gated on the INTERVAL (skip while loaded), un-gated at STARTUP so a bloated
//     table self-heals on next deploy without a restart.
// Rides idx_device_status_log_device_ts(device_id, timestamp).
let _statusPruneRunning = false;
let _lastPrune = { deleted: 0, ms: 0, at: 0 }; // #146 P3.8: soak observability
let _sweepsTotal = 0; // #146: prune sweeps completed (confirm it's firing, not stalled)
function getMaintenanceStats() {
  return {
    ..._lastPrune,
    running: _statusPruneRunning,
    sweepsTotal: _sweepsTotal,
  };
}
async function pruneStatusLog(opts = {}) {
  if (_statusPruneRunning) return 0; // re-entrancy: work runs once
  if (
    opts.bandGate &&
    config.maintenanceBandGateEnabled &&
    currentBand() !== "normal"
  )
    return 0;
  _statusPruneRunning = true;
  const _t0 = Date.now();
  try {
    const batch = config.statusLogPruneBatch;
    const cap = config.statusLogMaxRowsPerDevice;
    const cutoff =
      Math.floor(Date.now() / 1000) -
      Math.round(config.statusLogRetentionDays * 86400);
    const nextDevice = db.prepare(
      "SELECT device_id FROM device_status_log WHERE device_id > ? ORDER BY device_id LIMIT 1",
    );
    const delOld = db.prepare(
      "DELETE FROM device_status_log WHERE id IN (SELECT id FROM (SELECT id FROM device_status_log WHERE device_id = ? AND timestamp < ? LIMIT ?) x)",
    );
    const delCap =
      cap > 0
        ? db.prepare(
            "DELETE FROM device_status_log WHERE id IN (SELECT id FROM (SELECT id FROM device_status_log WHERE device_id = ? ORDER BY timestamp DESC, id DESC LIMIT ? OFFSET ?) x)",
          )
        : null;

    let total = 0,
      lastDev = "";
    for (;;) {
      const row = await nextDevice.get(lastDev); // O(log n) index seek to next distinct device_id
      if (!row) break;
      lastDev = row.device_id;
      // 1) retention — drop rows older than the window, in batches
      total += (
        await chunkedDelete(
          async (lim) => (await delOld.run(lastDev, cutoff, lim)).changes,
          { batch },
        )
      ).deleted;
      // 2) cap — drop rows beyond the newest `cap` (OFFSET cap skips the kept rows), in batches
      if (delCap)
        total += (
          await chunkedDelete(
            async (lim) => (await delCap.run(lastDev, lim, cap)).changes,
            { batch },
          )
        ).deleted;
      await yieldTick(); // breathe between devices
    }
    if (total > 0)
      console.log(
        `[status-log] pruned ${total} row(s) (per-device, newest ${cap}/device + ${config.statusLogRetentionDays}d retention, batches of ${batch})`,
      );
    _lastPrune = {
      deleted: total,
      ms: Date.now() - _t0,
      at: Math.floor(Date.now() / 1000),
    };
    _sweepsTotal += 1;
    return total;
  } catch (_) {
    return 0;
  } finally {
    _statusPruneRunning = false;
  }
}

// Prune old telemetry (keep last 24h worth at 15s intervals = ~5760, cap at 6000).
// #146: BOUNDED single statement — delete at most statusLogPruneBatch rows beyond the
// newest 6000 (OFFSET 6000). Runs per-heartbeat (deviceSocket.js), so it keeps up
// incrementally; a post-downtime backlog trims over several heartbeats, never one giant
// DELETE. Rides idx_telemetry_device(device_id, reported_at DESC).
const _delTelemetry = db.prepare(
  "DELETE FROM device_telemetry WHERE id IN (SELECT id FROM (SELECT id FROM device_telemetry WHERE device_id = ? ORDER BY reported_at DESC LIMIT ? OFFSET 6000) x)",
);
async function pruneTelemetry(deviceId) {
  await _delTelemetry.run(deviceId, config.statusLogPruneBatch);
}

// Prune old screenshots (keep only latest per device)
async function pruneScreenshots(deviceId) {
  const old = await db
    .prepare(
      `
    SELECT filepath FROM screenshots
    WHERE device_id = ? AND id NOT IN (
      SELECT id FROM (SELECT id FROM screenshots WHERE device_id = ? ORDER BY captured_at DESC LIMIT 1) x
    )
  `,
    )
    .all(deviceId, deviceId);

  for (const row of old) {
    const fullPath = path.join(config.screenshotsDir, row.filepath);
    if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
  }

  await db
    .prepare(
      `
    DELETE FROM screenshots
    WHERE device_id = ? AND id NOT IN (
      SELECT id FROM (SELECT id FROM screenshots WHERE device_id = ? ORDER BY captured_at DESC LIMIT 1) x
    )
  `,
    )
    .run(deviceId, deviceId);
}

module.exports = {
  db,
  initDb,
  pruneTelemetry,
  pruneScreenshots,
  pruneStatusLog,
  getMaintenanceStats,
};
