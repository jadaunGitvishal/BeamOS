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
  'registration_codes', // Ref 30 Stage 1: advance device registration codes
  'outage_history',     // Ref 51: SLA MTTR reads from this durable rollup
  'device_events',      // Phase 2 Stage A: audit-trail endpoint + device:report-event
  'regions',            // Phase 3 Stage A: per-org regional structure
  'tickets',            // Phase 4 Stage A: operational ticketing
  'campaigns',          // Phase 5 Stage A: campaign wrappers around playlists
  'field_visits',       // Ref 43 Stage A: field-visit inspections
  'field_visit_photos', // Ref 43 Stage A: geotagged inspection photos
  'activity_log_chain', // Ref 17: single-row anchor for the audit-log hash chain
  'device_network_usage', // Ref 44: daily SIM/network data-usage aggregates
  'entra_service_principals', // Ref 9: Entra ID Service Principal client_id -> workspace+scope
  'sim_inventory', // Ref 65: physical SIM stock ledger (in_stock/assigned/active/retired)
  'ticket_escalations', // Ref 58: ticket response-time SLA breach escalation dedup
  'scim_tokens', // Ref 8: SCIM provisioning bearer secrets (hashed)
  'entra_role_mappings', // Ref 7: Entra app role -> org/workspace role (repairable, below)
  'region_viewer_scopes', // Refs 49/67: regional_viewer scopes (repairable, below)
];

// Ref 7: tables the repair below may CREATE when missing (same DDL as schema.sql,
// which normally creates them first). [table, createSQL].
const REPAIRABLE_TABLES = [
  ['entra_role_mappings', `CREATE TABLE IF NOT EXISTS entra_role_mappings (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    organization_id VARCHAR(64) NOT NULL,
    claim_value     VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    workspace_id    VARCHAR(64) NULL,
    role            VARCHAR(50) NOT NULL,
    created_by      VARCHAR(64) NULL,
    created_at      BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    workspace_key   VARCHAR(64) AS (COALESCE(workspace_id, '')) VIRTUAL,
    UNIQUE KEY uniq_entra_role_mapping (organization_id, claim_value, workspace_key),
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],
  // Refs 49/67. Needs regions(organization_id, id) unique - repairRegionTree() runs first.
  ['region_viewer_scopes', `CREATE TABLE IF NOT EXISTS region_viewer_scopes (
    organization_id VARCHAR(64) NOT NULL,
    user_id         VARCHAR(64) NOT NULL,
    region_id       VARCHAR(64) NOT NULL,
    created_by      VARCHAR(64) NULL,
    created_at      BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    PRIMARY KEY (organization_id, user_id, region_id),
    KEY idx_region_viewer_scopes_user (user_id),
    FOREIGN KEY (organization_id, region_id) REFERENCES regions(organization_id, id) ON DELETE CASCADE,
    FOREIGN KEY (organization_id, user_id) REFERENCES organization_members(organization_id, user_id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],
];

// [table, column, repairSQL] — columns the code SELECTs / gates on. repairSQL is
// the idempotent ALTER that adds it if missing (null = base column, assert only).
const REQUIRED_COLUMNS = [
  ['users', 'must_change_password', "ALTER TABLE users ADD COLUMN must_change_password TINYINT(1) NOT NULL DEFAULT 0"],
  ['users', 'role', null],
  // Ref 43: field-technician OTP login looks the user up by this column, so an
  // un-migrated DB would 401 every field login. Nullable; the UNIQUE key rides
  // on the ALTER (MySQL never collides NULLs, so it applies regardless of rows).
  ['users', 'phone', "ALTER TABLE users ADD COLUMN phone VARCHAR(32) NULL, ADD UNIQUE KEY uniq_users_phone (phone)"],
  ['users', 'plan_id', "ALTER TABLE users ADD COLUMN plan_id VARCHAR(64) DEFAULT 'free'"],
  // Ref 5/8: user deactivation. requireAuth SELECTs this on every request (same
  // gate-on-every-request position as must_change_password above), so an
  // un-migrated DB would 500 every authed request. Nullable, no default - NULL =
  // active, so every pre-existing account stays active after the repair.
  ['users', 'deactivated_at', "ALTER TABLE users ADD COLUMN deactivated_at BIGINT NULL"],
  // Ref 8: SCIM round-trip identifiers. routes/scim.js SELECTs/writes both on
  // every SCIM call. Nullable - NULL for any account SCIM never touched.
  ['users', 'scim_external_id', "ALTER TABLE users ADD COLUMN scim_external_id VARCHAR(255) NULL"],
  ['users', 'scim_user_name', "ALTER TABLE users ADD COLUMN scim_user_name VARCHAR(255) NULL"],
  // Ref 34: max programmatic-credential lifetime. apiTokenAuth and scimAuth both
  // SELECT it on every token request, so an un-migrated DB would 500 every API /
  // SCIM call. Nullable, no default - NULL = no cap, i.e. today's behaviour.
  ['organizations', 'max_token_lifetime_days', "ALTER TABLE organizations ADD COLUMN max_token_lifetime_days INT NULL"],
  // Ref 5: SSO-only mode. lib/sso-policy.js reads it on every password / Google
  // login, so an un-migrated DB would 500 every login. Default 0 = every existing
  // org keeps today's behaviour after the repair.
  ['organizations', 'sso_only', "ALTER TABLE organizations ADD COLUMN sso_only TINYINT(1) NOT NULL DEFAULT 0"],
  // Ref 7: membership provenance. NULL = manual (every pre-existing row stays
  // manual after the repair, so the Entra role sync never touches it); 'entra' =
  // managed by lib/entra-role-sync.js. The manual member routes write NULL.
  ['organization_members', 'source', "ALTER TABLE organization_members ADD COLUMN source VARCHAR(16) NULL"],
  ['workspace_members', 'source', "ALTER TABLE workspace_members ADD COLUMN source VARCHAR(16) NULL"],
  // Refs 49/67: region tree. Added (with the rest of the tree shape) by
  // repairRegionTree() below; listed here so their absence is still caught.
  ['regions', 'level', "ALTER TABLE regions ADD COLUMN level VARCHAR(16) NULL"],
  ['regions', 'parent_id', "ALTER TABLE regions ADD COLUMN parent_id VARCHAR(64) NULL"],
  ['play_logs', 'session_id', "ALTER TABLE play_logs ADD COLUMN session_id VARCHAR(64) NULL, ADD UNIQUE KEY uniq_play_logs_session (session_id)"],
  // Ref 32: GPS location on telemetry rows. The heartbeat INSERT (ws/deviceSocket.js)
  // always lists these columns now, so an un-migrated DB would fail every telemetry
  // write until repaired. Nullable, no default - absent lat/long is the norm.
  ['device_telemetry', 'latitude', "ALTER TABLE device_telemetry ADD COLUMN latitude DOUBLE NULL"],
  ['device_telemetry', 'longitude', "ALTER TABLE device_telemetry ADD COLUMN longitude DOUBLE NULL"],
  // Ref 45 Stage A: battery temperature (honest proxy for "internal temperature").
  // The heartbeat INSERT (ws/deviceSocket.js) always lists this column now, so an
  // un-migrated DB would fail every telemetry write until repaired. Nullable, no
  // default - EXTRA_TEMPERATURE is absent on some emulators/hardware.
  ['device_telemetry', 'battery_temperature_c', "ALTER TABLE device_telemetry ADD COLUMN battery_temperature_c DOUBLE NULL"],
  // Ref 30: registration-code TTL. The claim + generate paths both read/write
  // expires_at, so an un-migrated DB (table created before this column existed)
  // needs the repair. Nullable - a pre-TTL row with NULL expires_at never expires.
  ['registration_codes', 'expires_at', "ALTER TABLE registration_codes ADD COLUMN expires_at BIGINT NULL"],
  // Phase 3 Stage A: optional region a workspace belongs to. Nullable; ON DELETE
  // SET NULL so removing a region never force-deletes its workspaces. The
  // `regions` table is created by schema.sql (which runs before this check), so
  // the FK target exists by the time this repair fires on an existing DB.
  ['workspaces', 'region_id', "ALTER TABLE workspaces ADD COLUMN region_id VARCHAR(64) NULL, ADD CONSTRAINT fk_workspaces_region FOREIGN KEY (region_id) REFERENCES regions(id) ON DELETE SET NULL"],
  // Phase 4 Stage B: SLA-breach auto-ticket tracking. `tickets` is created by
  // schema.sql (runs before this check), so on a DB that predates Stage B these
  // add the two columns. The UNIQUE key rides on the source_outage_start ALTER;
  // manual tickets have source_outage_start NULL (MySQL never collides NULLs) so
  // it can be added regardless of existing rows.
  ['tickets', 'auto_source', "ALTER TABLE tickets ADD COLUMN auto_source VARCHAR(50) NULL"],
  ['tickets', 'source_outage_start', "ALTER TABLE tickets ADD COLUMN source_outage_start BIGINT NULL, ADD UNIQUE KEY uq_tickets_source_outage (device_id, source_outage_start)"],
  // Ref 58: proactive/reactive/emergency ticket category label. Both the
  // create route and sla-breach-ticket.js's auto-create INSERT always list
  // this column now, so an un-migrated DB would fail every ticket write until
  // repaired. Defaults to 'reactive' (a human reported it) for any existing
  // row, which is the honest read for tickets created before this column existed.
  ['tickets', 'ticket_category', "ALTER TABLE tickets ADD COLUMN ticket_category VARCHAR(50) NOT NULL DEFAULT 'reactive'"],
  // Step 5 Stage A: per-outage root-cause hint. The recorder
  // (services/outage-history.js) writes it on every new row; NULL means the row
  // predates this column. Nullable, no default.
  ['outage_history', 'likely_cause', "ALTER TABLE outage_history ADD COLUMN likely_cause VARCHAR(50) NULL"],
  // Ref 43: reverse-geocoded place name on a field-visit photo. The photo detail
  // route SELECTs it; the upload route UPDATEs it best-effort. Nullable, no default.
  ['field_visit_photos', 'place_name', "ALTER TABLE field_visit_photos ADD COLUMN place_name VARCHAR(255) NULL"],
  // Ref 17: tamper-evident hash chain on activity_log. appendEntry() writes both
  // on every new row; lib/activity-chain.js backfillChain() fills them for rows
  // that predate this column at boot. Nullable - a NULL entry_hash is an
  // unchained row, which the verifier reports as a failure.
  ['activity_log', 'prev_hash', "ALTER TABLE activity_log ADD COLUMN prev_hash CHAR(64) NULL"],
  ['activity_log', 'entry_hash', "ALTER TABLE activity_log ADD COLUMN entry_hash CHAR(64) NULL"],
  // Audit retention pruning checkpoint (lib/activity-chain.js pruneChain). The
  // verifier and backfillChain() read all three at boot / on every check. An
  // existing chain row gets NULL anchors and pruned_count 0 = "never pruned",
  // which verifies exactly as before.
  ['activity_log_chain', 'anchor_id', "ALTER TABLE activity_log_chain ADD COLUMN anchor_id BIGINT NULL"],
  ['activity_log_chain', 'anchor_hash', "ALTER TABLE activity_log_chain ADD COLUMN anchor_hash CHAR(64) NULL"],
  ['activity_log_chain', 'pruned_count', "ALTER TABLE activity_log_chain ADD COLUMN pruned_count BIGINT NOT NULL DEFAULT 0"],
  // Ref 31: one-time device hardware identity. The device:register handler
  // (ws/deviceSocket.js) and the activation-code claim (routes/registration-codes.js)
  // both write these now, so an un-migrated DB would fail every register/claim until
  // repaired. All nullable, no default - NULL = "not captured yet".
  ['devices', 'manufacturer', "ALTER TABLE devices ADD COLUMN manufacturer VARCHAR(100) NULL"],
  ['devices', 'model', "ALTER TABLE devices ADD COLUMN model VARCHAR(120) NULL"],
  ['devices', 'display_size_inches', "ALTER TABLE devices ADD COLUMN display_size_inches DOUBLE NULL"],
  ['devices', 'mac_address', "ALTER TABLE devices ADD COLUMN mac_address VARCHAR(64) NULL"],
  ['devices', 'serial_number', "ALTER TABLE devices ADD COLUMN serial_number VARCHAR(128) NULL"],
  ['devices', 'sim_iccid', "ALTER TABLE devices ADD COLUMN sim_iccid VARCHAR(64) NULL"],
  ['devices', 'sim_provider', "ALTER TABLE devices ADD COLUMN sim_provider VARCHAR(100) NULL"],
  ['devices', 'sim_network_status', "ALTER TABLE devices ADD COLUMN sim_network_status VARCHAR(50) NULL"],
  ['devices', 'hardware_captured_at', "ALTER TABLE devices ADD COLUMN hardware_captured_at BIGINT NULL"],
  // Ref 44: whether the app currently holds Device Owner, re-sent alongside the
  // rest of the hardware block. device:register writes it now, so an un-migrated
  // DB would fail every register until repaired. Nullable - NULL means "not
  // reported" (old APK), distinct from the real false.
  ['devices', 'is_device_owner', "ALTER TABLE devices ADD COLUMN is_device_owner TINYINT(1) NULL"],
  // Ref 43: technician-set date of physical installation ('YYYY-MM-DD'). The
  // field-visit PATCH route writes this now, so an un-migrated DB would fail
  // every visit-completion update that includes it until repaired. Nullable -
  // NULL = not yet recorded by a technician.
  ['devices', 'installed_at', "ALTER TABLE devices ADD COLUMN installed_at VARCHAR(10) NULL"],
  // Ref 52: technician-set warranty expiry date ('YYYY-MM-DD'). The field-visit
  // PATCH route writes this now, so an un-migrated DB would fail every
  // visit-completion update that includes it until repaired. Nullable - NULL =
  // not yet recorded by a technician.
  ['devices', 'warranty_expiry_date', "ALTER TABLE devices ADD COLUMN warranty_expiry_date VARCHAR(10) NULL"],
];

// Audit-chain fix (Refs 17/20): activity_log rows must keep user_id /
// acting_user_id after the user is deleted - user_id is part of each row's hash,
// so nulling it breaks the chain. schema.sql no longer declares these FKs; this
// drops them from DBs created before that. Found by lookup (MySQL's generated
// names, e.g. activity_log_ibfk_1, aren't guaranteed), never hard-coded. Indexes
// are left in place. Idempotent: a no-op once none remain. `table` is a
// parameter only so tests can run it on a scratch table. Returns dropped names.
async function dropUserForeignKeys(db, table = 'activity_log') {
  if (!/^[A-Za-z0-9_]+$/.test(table)) throw new Error(`dropUserForeignKeys: invalid table name "${table}"`);
  const rows = await db
    .prepare(
      `SELECT DISTINCT CONSTRAINT_NAME AS name FROM information_schema.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME = 'users'`,
    )
    .all(table);
  const dropped = [];
  for (const { name } of rows) {
    await db.exec(`ALTER TABLE \`${table}\` DROP FOREIGN KEY \`${String(name).replace(/`/g, '``')}\``);
    console.warn(`[schema-check] dropped foreign key ${table}.${name} -> users (audit rows keep the user id after deletion)`);
    dropped.push(name);
  }
  return dropped;
}

// Refs 49/67: bring a pre-tree `regions` table to the tree shape schema.sql now
// declares. Each step checks first and logs what it changed, so a second run is a
// no-op. Order matters: the per-parent name key is created BEFORE the old
// UNIQUE(organization_id, name) is dropped, so names are never unguarded. Returns
// the list of actions taken.
async function repairRegionTree(db) {
  const actions = [];
  const run = async (label, sql) => {
    await db.exec(sql);
    actions.push(label);
    console.warn(`[schema-check] regions: ${label}`);
  };
  const cols = new Set(
    (await db
      .prepare("SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'regions'")
      .all()).map((r) => r.name),
  );
  if (!cols.has('level')) await run('added column level', 'ALTER TABLE regions ADD COLUMN level VARCHAR(16) NULL');
  if (!cols.has('parent_id')) await run('added column parent_id', 'ALTER TABLE regions ADD COLUMN parent_id VARCHAR(64) NULL');
  const backfilled = await db.prepare("UPDATE regions SET level = 'region' WHERE level IS NULL").run();
  if (backfilled.changes) {
    actions.push(`backfilled level='region' on ${backfilled.changes} row(s)`);
    console.warn(`[schema-check] regions: backfilled level='region' on ${backfilled.changes} existing row(s) (now top-level)`);
  }
  if (!cols.has('parent_key')) {
    // VIRTUAL: MySQL refuses STORED on the base column of a cascading FK.
    await run('added generated column parent_key', "ALTER TABLE regions ADD COLUMN parent_key VARCHAR(64) AS (COALESCE(parent_id, '')) VIRTUAL");
  }
  const indexes = async () => (await db
    .prepare(
      `SELECT INDEX_NAME AS name, MIN(NON_UNIQUE) AS non_unique, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols
       FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'regions'
       GROUP BY INDEX_NAME`,
    )
    .all()).map((r) => ({ name: r.name, unique: Number(r.non_unique) === 0, cols: r.cols }));
  let idx = await indexes();
  const hasUnique = (c) => idx.some((i) => i.unique && i.cols === c);
  if (!hasUnique('organization_id,id')) {
    await run('added UNIQUE (organization_id, id)', 'ALTER TABLE regions ADD UNIQUE KEY uniq_regions_org_id (organization_id, id)');
  }
  if (!hasUnique('organization_id,parent_key,name')) {
    await run('added UNIQUE (organization_id, parent_key, name)', 'ALTER TABLE regions ADD UNIQUE KEY uniq_regions_parent_name (organization_id, parent_key, name)');
  }
  idx = await indexes();
  if (hasUnique('organization_id,parent_key,name')) {
    for (const i of idx.filter((x) => x.unique && x.cols === 'organization_id,name')) {
      await run(`dropped old UNIQUE (organization_id, name) "${i.name}"`, `ALTER TABLE regions DROP INDEX \`${String(i.name).replace(/`/g, '``')}\``);
    }
  }
  const parentFk = await db
    .prepare(
      `SELECT CONSTRAINT_NAME AS name FROM information_schema.REFERENTIAL_CONSTRAINTS
       WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'regions' AND REFERENCED_TABLE_NAME = 'regions'`,
    )
    .get();
  if (!parentFk) {
    await run(
      'added FK (organization_id, parent_id) -> regions(organization_id, id) ON DELETE CASCADE',
      'ALTER TABLE regions ADD CONSTRAINT fk_regions_parent FOREIGN KEY (organization_id, parent_id) REFERENCES regions(organization_id, id) ON DELETE CASCADE',
    );
  }
  return actions;
}

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
  if (tableSet.has('regions')) {
    try {
      await repairRegionTree(db);
    } catch (e) {
      console.error(`[schema-check] region tree repair FAILED: ${e.message}`);
    }
  }
  for (const [t, create] of REPAIRABLE_TABLES) {
    if (tableSet.has(t)) continue;
    try {
      console.warn(`[schema-check] required table ${t} is missing — creating it...`);
      await db.exec(create);
      tableSet.add(t);
      console.warn(`[schema-check] created table ${t}`);
    } catch (e) {
      console.error(`[schema-check] creating table ${t} FAILED: ${e.message}`);
    }
  }
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

  if (tableSet.has('activity_log')) {
    try {
      await dropUserForeignKeys(db);
    } catch (e) {
      console.error(`[schema-check] dropping activity_log -> users foreign keys FAILED: ${e.message}`);
    }
  }

  if (missing.length) onMissing(missing);
  return missing;
}

module.exports = { verifyAndRepairSchema, dropUserForeignKeys, repairRegionTree, REQUIRED_TABLES, REQUIRED_COLUMNS, REPAIRABLE_TABLES };
