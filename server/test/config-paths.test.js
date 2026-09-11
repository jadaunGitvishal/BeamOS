// Hard backward-compat guarantee for the filesystem paths that are still
// genuinely real post-MySQL-migration (uploadsDir/contentDir/screenshotsDir/
// certsDir): with DATA_DIR (and the per-path overrides) UNSET, config must
// resolve to exactly the legacy in-repo locations, so existing installs -
// including production - see zero behavior change. Also verifies DATA_DIR/
// UPLOADS_DIR/CERTS_DIR still relocate state (the Docker /data case).
//
// Ref 45 Stage 3 (test-infrastructure cleanup): this file used to also assert
// on `config.dbPath`/DB_PATH, a flat-file SQLite path that config.js no longer
// exports at all - that contract was fully removed in the MySQL migration
// (~2026-07-21), replaced by the MYSQL_* connection settings asserted below.
// Asserting on a property that doesn't exist isn't a "legacy path bug" fixable
// by pointing at a different database; it needed rewriting to the CURRENT
// contract, which is what this file now does.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

// Every env var config.js reads for either concern (filesystem relocation,
// MySQL connection) - cleared before each loadConfig() call so a real .env
// (or a real MYSQL_* value already in this process's environment, since
// `npm test` now loads server/.env - see the "Fix npm test..." commit) can
// never leak into an "UNSET" test case and silently mask what the DEFAULT
// actually is.
const CLEARED_ENV = [
  'DATA_DIR', 'UPLOADS_DIR', 'CERTS_DIR',
  'MYSQL_HOST', 'MYSQL_PORT', 'MYSQL_USER', 'MYSQL_PASSWORD', 'MYSQL_DATABASE',
  'MYSQL_SOCKET_PATH', 'MYSQL_POOL_SIZE',
];
const serverDir = path.join(__dirname, '..'); // config.js lives in server/

function loadConfig(overrides) {
  CLEARED_ENV.forEach((k) => delete process.env[k]);
  process.env.JWT_SECRET = 'test-secret'; // short-circuits the secret-file-writing IIFE (no FS side effects)
  Object.assign(process.env, overrides || {});
  delete require.cache[require.resolve('../config')];
  return require('../config');
}

test('UNSET -> exactly the legacy in-repo paths (zero change for existing installs)', () => {
  const c = loadConfig();
  assert.strictEqual(c.dataDir, serverDir);
  assert.strictEqual(c.uploadsDir, path.join(serverDir, 'uploads'));
  assert.strictEqual(c.contentDir, path.join(serverDir, 'uploads', 'content'));
  assert.strictEqual(c.screenshotsDir, path.join(serverDir, 'uploads', 'screenshots'));
  assert.strictEqual(c.certsDir, path.join(serverDir, 'certs'));
});

test('DATA_DIR relocates uploads / certs onto the volume', () => {
  const c = loadConfig({ DATA_DIR: '/data' });
  assert.strictEqual(c.uploadsDir, path.join('/data', 'uploads'));
  assert.strictEqual(c.contentDir, path.join('/data', 'uploads', 'content'));
  assert.strictEqual(c.screenshotsDir, path.join('/data', 'uploads', 'screenshots'));
  assert.strictEqual(c.certsDir, path.join('/data', 'certs'));
});

test('individual overrides (UPLOADS_DIR / CERTS_DIR) win over DATA_DIR', () => {
  const c = loadConfig({ DATA_DIR: '/data', UPLOADS_DIR: '/media', CERTS_DIR: '/pki' });
  assert.strictEqual(c.uploadsDir, '/media');
  assert.strictEqual(c.contentDir, path.join('/media', 'content'));
  assert.strictEqual(c.certsDir, '/pki');
});

// The real, current post-migration contract: MySQL connection settings,
// read straight from env with the same defaults db/database.js's pool
// actually connects with (config.js is the only source of truth for these -
// verified against config.js directly, not re-derived here).
test('MYSQL_* UNSET -> the real connection defaults (host/port/user/database/pool)', () => {
  const c = loadConfig();
  assert.strictEqual(c.mysqlHost, 'localhost');
  assert.strictEqual(c.mysqlPort, 3306);
  assert.strictEqual(c.mysqlUser, 'beamos_user');
  assert.strictEqual(c.mysqlPassword, '');
  assert.strictEqual(c.mysqlDatabase, 'beamos');
  assert.strictEqual(c.mysqlSocketPath, '');
  assert.strictEqual(c.mysqlPoolSize, 10);
});

test('MYSQL_* env vars are read correctly when set (self-hosted custom DB)', () => {
  const c = loadConfig({
    MYSQL_HOST: 'db.internal', MYSQL_PORT: '3307', MYSQL_USER: 'custom_user',
    MYSQL_PASSWORD: 'sekrit', MYSQL_DATABASE: 'custom_db', MYSQL_POOL_SIZE: '25',
  });
  assert.strictEqual(c.mysqlHost, 'db.internal');
  assert.strictEqual(c.mysqlPort, 3307, 'MYSQL_PORT is parsed to a number, not left as a string');
  assert.strictEqual(c.mysqlUser, 'custom_user');
  assert.strictEqual(c.mysqlPassword, 'sekrit');
  assert.strictEqual(c.mysqlDatabase, 'custom_db');
  assert.strictEqual(c.mysqlPoolSize, 25, 'MYSQL_POOL_SIZE is parsed to a number, not left as a string');
});

// MYSQL_SOCKET_PATH is the managed-MySQL-install alternative to host/port
// (mysql2 accepts socketPath instead in that case, per db/database.js).
test('MYSQL_SOCKET_PATH is read correctly when set (managed-MySQL Unix socket case)', () => {
  const c = loadConfig({ MYSQL_SOCKET_PATH: '/var/run/mysqld/mysqld.sock' });
  assert.strictEqual(c.mysqlSocketPath, '/var/run/mysqld/mysqld.sock');
});
