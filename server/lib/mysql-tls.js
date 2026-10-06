'use strict';

// Ref 2: optional, VERIFIED TLS for every app-to-MySQL connection (the pool in
// db/database.js, scripts/migrate-sqlite-to-mysql.js's direct connection) and
// for every mysqldump the app runs (pre-migration snapshot, /api/status/backup,
// both scripts' snapshots).
//
// MYSQL_SSL (config.mysqlSsl):
//   off          (default) no TLS - behaviour identical to before this option.
//   verify-ca    TLS >= 1.2; the server cert must chain to MYSQL_SSL_CA; the
//                hostname is NOT checked. For self-hosted MySQL, whose
//                auto-generated cert names "MySQL_Server_<ver>_Auto_Generated_
//                Server_Certificate" rather than the host.
//   verify-full  verify-ca + the hostname must match the cert. For managed DBs
//                (Azure Database for MySQL Flexible Server, RDS, ...).
// There is deliberately no encrypt-only/unverified mode: TLS without
// verification doesn't stop an active man-in-the-middle.
//
// MYSQL_SSL_CA (config.mysqlSslCa): path to the CA PEM. Required unless off.
//
// HOW mysql2 CHECKS THE HOSTNAME (node_modules/mysql2/lib/base/connection.js,
// startTLS(), mysql2 3.24.2): it builds tls.connect()'s options ITSELF -
// checkServerIdentity is `verifyIdentity ? tls.checkServerIdentity : () => undefined`,
// and a checkServerIdentity passed in the ssl options is never forwarded. So the
// hostname is checked ONLY when ssl.verifyIdentity === true; rejectUnauthorized
// alone checks the chain but not the name. That is why verify-full sets
// verifyIdentity and verify-ca simply omits it.
//
// IP-literal hosts: for an IP MYSQL_HOST mysql2 passes no servername, and a
// socket connected by IP has no _host, so Node's tls.connect falls back to
// checking the cert against "localhost" - not against the IP. verify-full would
// then accept any CA-signed cert that names localhost, for ANY IP. So
// verify-full refuses an IP-literal host (use the DNS name on the certificate,
// or verify-ca).
//
// Never log the CA contents or passwords; error messages carry the path only.

const fs = require('fs');
const net = require('net');
const { execFile } = require('child_process');

const MYSQL_SSL_MODES = ['off', 'verify-ca', 'verify-full'];
const MIN_TLS_VERSION = 'TLSv1.2';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function isTlsOn(config) {
  return config.mysqlSsl !== 'off';
}

// Throws a clear Error for every configuration the server must refuse to start
// with. A no-op for MYSQL_SSL=off (the default) whatever the other settings are.
function validateMysqlTls(config) {
  const mode = config.mysqlSsl;
  if (!MYSQL_SSL_MODES.includes(mode)) {
    throw new Error(
      `Invalid MYSQL_SSL value "${mode}". Expected one of: ${MYSQL_SSL_MODES.join(', ')}.`,
    );
  }
  if (mode === 'off') return;
  if (config.mysqlSocketPath) {
    throw new Error(
      `MYSQL_SSL=${mode} cannot be combined with MYSQL_SOCKET_PATH: TLS over a local socket is meaningless. ` +
        'Unset MYSQL_SOCKET_PATH to connect over TCP with TLS, or set MYSQL_SSL=off to keep using the socket.',
    );
  }
  if (!config.mysqlSslCa) {
    throw new Error(`MYSQL_SSL=${mode} requires MYSQL_SSL_CA (path to the CA certificate PEM file).`);
  }
  try {
    fs.readFileSync(config.mysqlSslCa);
  } catch (e) {
    const why = e.code === 'ENOENT' ? 'file not found' : `not readable (${e.code || e.message})`;
    throw new Error(`MYSQL_SSL_CA "${config.mysqlSslCa}": ${why}.`);
  }
  if (mode === 'verify-full' && net.isIP(config.mysqlHost)) {
    throw new Error(
      `MYSQL_SSL=verify-full needs MYSQL_HOST to be the DNS name on the server certificate, not an IP address ("${config.mysqlHost}"): ` +
        'the MySQL driver cannot verify a certificate against an IP. Use the hostname, or MYSQL_SSL=verify-ca.',
    );
  }
}

// mysql2 `ssl` option. undefined when off (so the pool config is untouched).
function mysqlSslOptions(config) {
  if (!isTlsOn(config)) return undefined;
  const opts = {
    ca: fs.readFileSync(config.mysqlSslCa),
    rejectUnauthorized: true,
    minVersion: MIN_TLS_VERSION,
  };
  if (config.mysqlSsl === 'verify-full') opts.verifyIdentity = true;
  return opts;
}

// Extra mysqldump arguments for the configured mode and the installed client's
// flavour. [] when off.
function mysqldumpTlsArgs(config, flavour) {
  if (!isTlsOn(config)) return [];
  const caArg = `--ssl-ca=${config.mysqlSslCa}`;
  if (flavour === 'mysql') {
    return [config.mysqlSsl === 'verify-full' ? '--ssl-mode=VERIFY_IDENTITY' : '--ssl-mode=VERIFY_CA', caArg];
  }
  if (flavour === 'mariadb') {
    if (config.mysqlSsl === 'verify-full') return ['--ssl', caArg, '--ssl-verify-server-cert'];
    // The MariaDB client can only verify the CA together with the hostname
    // (--ssl-verify-server-cert); --ssl alone would encrypt WITHOUT verifying.
    // Never silently downgrade.
    throw new Error(
      'MYSQL_SSL=verify-ca is not supported with the MariaDB mysqldump client (it cannot verify the CA without also checking the hostname). ' +
        'Install the MySQL client tools, or use MYSQL_SSL=verify-full.',
    );
  }
  throw new Error(`Unknown mysqldump flavour "${flavour}".`);
}

function parseMysqldumpFlavour(versionOutput) {
  return /MariaDB/i.test(String(versionOutput || '')) ? 'mariadb' : 'mysql';
}

// Runs `mysqldump --version` once per process (cached; a failure is not cached
// so a later dump can retry). `run` is injectable for tests.
let _flavourPromise = null;
function runMysqldumpVersion() {
  return new Promise((resolve, reject) => {
    execFile('mysqldump', ['--version'], (err, stdout) => {
      if (err) return reject(new Error(`could not run "mysqldump --version": ${err.message}`));
      resolve(stdout);
    });
  });
}
function detectMysqldumpFlavour({ run = runMysqldumpVersion } = {}) {
  if (!_flavourPromise) {
    _flavourPromise = Promise.resolve()
      .then(run)
      .then(parseMysqldumpFlavour)
      .catch((e) => {
        _flavourPromise = null;
        throw e;
      });
  }
  return _flavourPromise;
}
function _resetFlavourCache() {
  _flavourPromise = null;
}

// What the dump call sites use: [] when off (mysqldump --version never runs),
// otherwise detects the client flavour and returns its TLS args. Throws (with a
// clear reason) when the dump can't be done over verified TLS.
async function resolveMysqldumpTlsArgs(config, opts) {
  if (!isTlsOn(config)) return [];
  return mysqldumpTlsArgs(config, await detectMysqldumpFlavour(opts));
}

function isLocalMysqlHost(host) {
  const h = String(host || '').trim().toLowerCase();
  // mysql2 (and the mysql CLI) default an empty host to localhost.
  return h === '' || LOCAL_HOSTS.has(h);
}

// The start-up warning text for unencrypted DB traffic leaving the host, or
// null when there's nothing to warn about (TLS on, a socket, or a local host).
function plaintextRemoteWarning(config) {
  if (isTlsOn(config) || config.mysqlSocketPath || isLocalMysqlHost(config.mysqlHost)) return null;
  return (
    `[db] WARNING: MySQL traffic to ${config.mysqlHost}:${config.mysqlPort} is UNENCRYPTED (MYSQL_SSL=off). ` +
    'Set MYSQL_SSL=verify-full (managed DB) or verify-ca (self-hosted) with MYSQL_SSL_CA - see docs/encryption.md.'
  );
}

// Start-up proof that TLS is really in use: asks the server for this pooled
// session's cipher. Returns the cipher, or null when off. Throws when TLS is
// configured but the session isn't encrypted.
async function assertMysqlTlsActive(queryable, config) {
  if (!isTlsOn(config)) return null;
  const [rows] = await queryable.query("SHOW SESSION STATUS LIKE 'Ssl_cipher'");
  const cipher = rows && rows[0] ? String(rows[0].Value || '') : '';
  if (!cipher) {
    throw new Error(`MYSQL_SSL=${config.mysqlSsl} is set but the MySQL session is NOT encrypted (Ssl_cipher is empty). Refusing to start.`);
  }
  return cipher;
}

module.exports = {
  MYSQL_SSL_MODES,
  MIN_TLS_VERSION,
  validateMysqlTls,
  mysqlSslOptions,
  mysqldumpTlsArgs,
  parseMysqldumpFlavour,
  detectMysqldumpFlavour,
  resolveMysqldumpTlsArgs,
  isLocalMysqlHost,
  plaintextRemoteWarning,
  assertMysqlTlsActive,
  _resetFlavourCache,
};
