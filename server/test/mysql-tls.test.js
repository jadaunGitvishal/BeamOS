'use strict';

// Ref 2: lib/mysql-tls.js - optional, verified TLS to MySQL.
//
// Part 1 (no DB): option shapes, mysqldump args per client flavour, the
// refusal cases, the local-host test, version-string parsing.
//
// Part 2 (integration, real local MySQL over real TLS): needs the local
// server's CA PEM at BEAMOS_TEST_MYSQL_CA (on Windows the MySQL data dir's
// ca.pem is admin-only, so copy it somewhere readable - never into the repo).
// Skipped with a message when that variable is unset or MySQL is unreachable,
// so CI and other machines don't fail. Proves:
//   (a) verify-ca with the server's CA connects, Ssl_cipher non-empty;
//   (b) verify-full against the auto-generated cert is REFUSED on the
//       hostname, for both 127.0.0.1 and localhost - i.e. hostname checking
//       really happens (verify-full is not a no-op);
//   (c) a wrong CA fails to connect;
//   (d) off connects exactly as before (no TLS).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mysqlTls = require('../lib/mysql-tls');
const {
  validateMysqlTls, mysqlSslOptions, mysqldumpTlsArgs, parseMysqldumpFlavour,
  detectMysqldumpFlavour, resolveMysqldumpTlsArgs, isLocalMysqlHost,
  plaintextRemoteWarning, assertMysqlTlsActive, _resetFlavourCache,
} = mysqlTls;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mysql-tls-test-'));
const CA = path.join(tmp, 'ca.pem');
fs.writeFileSync(CA, '-----BEGIN CERTIFICATE-----\nnot-a-real-cert\n-----END CERTIFICATE-----\n');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function cfg(over) {
  return {
    mysqlSsl: 'off', mysqlSslCa: '', mysqlHost: 'localhost', mysqlPort: 3306,
    mysqlSocketPath: '', ...over,
  };
}

// ---------------------------------------------------------------- mysqlSslOptions

test('mysqlSslOptions: off -> undefined (pool config untouched)', () => {
  assert.equal(mysqlSslOptions(cfg()), undefined);
  assert.equal(mysqlSslOptions(cfg({ mysqlSslCa: CA })), undefined, 'a CA alone does not turn TLS on');
});

test('mysqlSslOptions: verify-ca -> exact shape, reads the CA file, NO verifyIdentity', () => {
  const o = mysqlSslOptions(cfg({ mysqlSsl: 'verify-ca', mysqlSslCa: CA }));
  assert.deepEqual(Object.keys(o).sort(), ['ca', 'minVersion', 'rejectUnauthorized']);
  assert.deepEqual(o.ca, fs.readFileSync(CA));
  assert.equal(o.rejectUnauthorized, true);
  assert.equal(o.minVersion, 'TLSv1.2');
  assert.equal('verifyIdentity' in o, false, 'verify-ca must not set verifyIdentity (mysql2 would check the hostname)');
  assert.equal('checkServerIdentity' in o, false, 'mysql2 ignores a passed checkServerIdentity - never rely on it');
});

test('mysqlSslOptions: verify-full -> same plus verifyIdentity: true', () => {
  const o = mysqlSslOptions(cfg({ mysqlSsl: 'verify-full', mysqlSslCa: CA, mysqlHost: 'db.example.com' }));
  assert.deepEqual(o, { ca: fs.readFileSync(CA), rejectUnauthorized: true, minVersion: 'TLSv1.2', verifyIdentity: true });
  assert.equal('checkServerIdentity' in o, false);
});

// --------------------------------------------------------------- mysqldumpTlsArgs

test('mysqldumpTlsArgs: off -> [] for either flavour', () => {
  assert.deepEqual(mysqldumpTlsArgs(cfg(), 'mysql'), []);
  assert.deepEqual(mysqldumpTlsArgs(cfg(), 'mariadb'), []);
});

test('mysqldumpTlsArgs: MySQL client', () => {
  assert.deepEqual(mysqldumpTlsArgs(cfg({ mysqlSsl: 'verify-ca', mysqlSslCa: CA }), 'mysql'),
    ['--ssl-mode=VERIFY_CA', `--ssl-ca=${CA}`]);
  assert.deepEqual(mysqldumpTlsArgs(cfg({ mysqlSsl: 'verify-full', mysqlSslCa: CA }), 'mysql'),
    ['--ssl-mode=VERIFY_IDENTITY', `--ssl-ca=${CA}`]);
});

test('mysqldumpTlsArgs: MariaDB client - verify-full maps, verify-ca refuses (never downgrades)', () => {
  assert.deepEqual(mysqldumpTlsArgs(cfg({ mysqlSsl: 'verify-full', mysqlSslCa: CA }), 'mariadb'),
    ['--ssl', `--ssl-ca=${CA}`, '--ssl-verify-server-cert']);
  assert.throws(() => mysqldumpTlsArgs(cfg({ mysqlSsl: 'verify-ca', mysqlSslCa: CA }), 'mariadb'),
    /verify-ca is not supported with the MariaDB mysqldump client/);
});

// --------------------------------------------------------------- validateMysqlTls

test('validateMysqlTls: invalid MYSQL_SSL value refused', () => {
  for (const bad of ['on', 'true', 'required', 'verify_ca', '']) {
    assert.throws(() => validateMysqlTls(cfg({ mysqlSsl: bad })), /Invalid MYSQL_SSL value/, bad);
  }
});

test('validateMysqlTls: missing CA (unset, or file not found) refused', () => {
  assert.throws(() => validateMysqlTls(cfg({ mysqlSsl: 'verify-ca' })), /requires MYSQL_SSL_CA/);
  assert.throws(() => validateMysqlTls(cfg({ mysqlSsl: 'verify-ca', mysqlSslCa: path.join(tmp, 'nope.pem') })),
    /MYSQL_SSL_CA ".*nope\.pem": file not found/);
});

test('validateMysqlTls: unreadable CA refused', () => {
  // A directory is unreadable as a file on every OS (chmod 000 doesn't apply on Windows).
  assert.throws(() => validateMysqlTls(cfg({ mysqlSsl: 'verify-ca', mysqlSslCa: tmp })), /MYSQL_SSL_CA ".*": not readable/);
});

test('validateMysqlTls: TLS + MYSQL_SOCKET_PATH refused, telling them to unset one', () => {
  assert.throws(
    () => validateMysqlTls(cfg({ mysqlSsl: 'verify-ca', mysqlSslCa: CA, mysqlSocketPath: '/var/run/mysqld/mysqld.sock' })),
    /cannot be combined with MYSQL_SOCKET_PATH.*Unset MYSQL_SOCKET_PATH.*MYSQL_SSL=off/s,
  );
});

test('validateMysqlTls: verify-full with an IP-literal host refused (mysql2 would check "localhost")', () => {
  for (const ip of ['127.0.0.1', '10.0.0.5', '::1']) {
    assert.throws(() => validateMysqlTls(cfg({ mysqlSsl: 'verify-full', mysqlSslCa: CA, mysqlHost: ip })),
      /verify-full needs MYSQL_HOST to be the DNS name/, ip);
  }
  // verify-ca doesn't check the name, so an IP is fine there.
  validateMysqlTls(cfg({ mysqlSsl: 'verify-ca', mysqlSslCa: CA, mysqlHost: '10.0.0.5' }));
});

test('validateMysqlTls: valid cases pass', () => {
  validateMysqlTls(cfg());
  validateMysqlTls(cfg({ mysqlSocketPath: '/var/run/mysqld/mysqld.sock' })); // off + socket: unchanged
  validateMysqlTls(cfg({ mysqlSsl: 'verify-ca', mysqlSslCa: CA }));
  validateMysqlTls(cfg({ mysqlSsl: 'verify-full', mysqlSslCa: CA, mysqlHost: 'mydb.mysql.database.azure.com' }));
});

test('error messages never include the CA contents', () => {
  const secretish = path.join(tmp, 'marker.pem');
  fs.writeFileSync(secretish, 'MARKER-CONTENTS');
  try {
    validateMysqlTls(cfg({ mysqlSsl: 'verify-full', mysqlSslCa: secretish, mysqlHost: '10.0.0.5' }));
    assert.fail('expected a throw');
  } catch (e) {
    assert.doesNotMatch(e.message, /MARKER-CONTENTS/);
  }
});

// ----------------------------------------------------- isLocalMysqlHost / warning

test('isLocalMysqlHost', () => {
  assert.equal(isLocalMysqlHost('localhost'), true);
  assert.equal(isLocalMysqlHost('LocalHost '), true);
  assert.equal(isLocalMysqlHost('127.0.0.1'), true);
  assert.equal(isLocalMysqlHost('::1'), true);
  assert.equal(isLocalMysqlHost(''), true, 'empty defaults to localhost in mysql2');
  assert.equal(isLocalMysqlHost(undefined), true);
  assert.equal(isLocalMysqlHost('db.internal'), false);
  assert.equal(isLocalMysqlHost('10.0.0.5'), false);
  assert.equal(isLocalMysqlHost('mydb.mysql.database.azure.com'), false);
});

test('plaintextRemoteWarning: only for off + TCP + remote host', () => {
  assert.equal(plaintextRemoteWarning(cfg()), null);
  assert.equal(plaintextRemoteWarning(cfg({ mysqlHost: '127.0.0.1' })), null);
  assert.equal(plaintextRemoteWarning(cfg({ mysqlHost: 'db.internal', mysqlSocketPath: '/s.sock' })), null);
  assert.equal(plaintextRemoteWarning(cfg({ mysqlHost: 'db.internal', mysqlSsl: 'verify-ca', mysqlSslCa: CA })), null);
  const w = plaintextRemoteWarning(cfg({ mysqlHost: 'db.internal', mysqlPort: 3307 }));
  assert.match(w, /WARNING: MySQL traffic to db\.internal:3307 is UNENCRYPTED \(MYSQL_SSL=off\)/);
});

// ------------------------------------------------------------ flavour detection

const MYSQL_VER = 'mysqldump  Ver 8.0.36 for Win64 on x86_64 (MySQL Community Server - GPL)\n';
const MARIADB_VER = 'mysqldump  Ver 10.19 Distrib 10.11.6-MariaDB, for debian-linux-gnu (x86_64)\n';
const MARIADB11_VER = 'mysqldump from 11.4.2-MariaDB, client 10.19 for Linux (x86_64)\n';

test('parseMysqldumpFlavour: MySQL vs MariaDB version strings', () => {
  assert.equal(parseMysqldumpFlavour(MYSQL_VER), 'mysql');
  assert.equal(parseMysqldumpFlavour('mysqldump  Ver 8.4.2 for Linux on x86_64 (MySQL Community Server - GPL)'), 'mysql');
  assert.equal(parseMysqldumpFlavour(MARIADB_VER), 'mariadb');
  assert.equal(parseMysqldumpFlavour(MARIADB11_VER), 'mariadb');
});

test('detectMysqldumpFlavour: runs once (cached); a failure is not cached', async () => {
  _resetFlavourCache();
  let calls = 0;
  const run = async () => { calls++; return MARIADB_VER; };
  assert.equal(await detectMysqldumpFlavour({ run }), 'mariadb');
  assert.equal(await detectMysqldumpFlavour({ run }), 'mariadb');
  assert.equal(calls, 1);

  _resetFlavourCache();
  let n = 0;
  const flaky = async () => { if (n++ === 0) throw new Error('boom'); return MYSQL_VER; };
  await assert.rejects(detectMysqldumpFlavour({ run: flaky }), /boom/);
  assert.equal(await detectMysqldumpFlavour({ run: flaky }), 'mysql');
  _resetFlavourCache();
});

test('resolveMysqldumpTlsArgs: off never runs mysqldump --version; on maps by flavour', async () => {
  _resetFlavourCache();
  let calls = 0;
  const run = async () => { calls++; return MYSQL_VER; };
  assert.deepEqual(await resolveMysqldumpTlsArgs(cfg(), { run }), []);
  assert.equal(calls, 0);
  assert.deepEqual(await resolveMysqldumpTlsArgs(cfg({ mysqlSsl: 'verify-ca', mysqlSslCa: CA }), { run }),
    ['--ssl-mode=VERIFY_CA', `--ssl-ca=${CA}`]);
  _resetFlavourCache();
  await assert.rejects(
    resolveMysqldumpTlsArgs(cfg({ mysqlSsl: 'verify-ca', mysqlSslCa: CA }), { run: async () => MARIADB_VER }),
    /MariaDB/,
  );
  _resetFlavourCache();
});

test('assertMysqlTlsActive: null when off; cipher when present; refuses an empty cipher', async () => {
  const fake = (value) => ({ query: async () => [[{ Variable_name: 'Ssl_cipher', Value: value }]] });
  assert.equal(await assertMysqlTlsActive({ query: () => assert.fail('must not query when off') }, cfg()), null);
  const on = cfg({ mysqlSsl: 'verify-ca', mysqlSslCa: CA });
  assert.equal(await assertMysqlTlsActive(fake('TLS_AES_256_GCM_SHA384'), on), 'TLS_AES_256_GCM_SHA384');
  await assert.rejects(assertMysqlTlsActive(fake(''), on), /NOT encrypted \(Ssl_cipher is empty\)/);
});

// ==================================================== integration (real MySQL)

const REAL_CA = process.env.BEAMOS_TEST_MYSQL_CA || '';
const DB = {
  port: parseInt(process.env.MYSQL_PORT) || 3306,
  user: process.env.MYSQL_USER || 'beamos_user',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || 'beamos',
};
const LOCAL_HOST = process.env.MYSQL_HOST || 'localhost';

let skipReason = null;
if (!REAL_CA) skipReason = 'BEAMOS_TEST_MYSQL_CA is not set (path to the local MySQL server\'s CA PEM)';
else if (!fs.existsSync(REAL_CA)) skipReason = `BEAMOS_TEST_MYSQL_CA "${REAL_CA}" does not exist`;
if (skipReason) console.log(`# [mysql-tls] integration tests SKIPPED: ${skipReason}`);

async function connect(host, sslCfg) {
  const mysql = require('mysql2/promise');
  return mysql.createConnection({ ...DB, host, ssl: mysqlSslOptions(sslCfg), connectTimeout: 5000 });
}
// For the must-fail cases: if the connection unexpectedly OPENS, close it before
// failing - a leaked connection would otherwise keep the test process alive.
async function connectExpectingRefusal(host, sslCfg) {
  const c = await connect(host, sslCfg);
  await c.end();
  return c;
}
async function cipherOf(conn) {
  const [rows] = await conn.query("SHOW SESSION STATUS LIKE 'Ssl_cipher'");
  return rows[0] ? rows[0].Value : '';
}

test('integration', { skip: skipReason || false }, async (t) => {
  const vca = cfg({ mysqlSsl: 'verify-ca', mysqlSslCa: REAL_CA, mysqlHost: LOCAL_HOST });

  // Reachability probe first (plain): if MySQL is down, skip rather than fail.
  try {
    const c = await connect(LOCAL_HOST, cfg());
    await c.end();
  } catch (e) {
    t.skip(`local MySQL unreachable: ${e.message}`);
    return;
  }

  await t.test('(a) verify-ca with the server CA connects over TLS', async () => {
    validateMysqlTls(vca);
    const c = await connect(LOCAL_HOST, vca);
    try {
      const cipher = await assertMysqlTlsActive(c, vca);
      assert.ok(cipher, 'Ssl_cipher must be non-empty');
      const [v] = await c.query("SHOW SESSION STATUS LIKE 'Ssl_version'");
      assert.match(v[0].Value, /^TLSv1\.[23]$/);
      t.diagnostic(`verify-ca: ${cipher} / ${v[0].Value}`);
    } finally { await c.end(); }
  });

  for (const host of ['127.0.0.1', 'localhost']) {
    await t.test(`(b) verify-full against ${host} with the auto-generated cert is REFUSED on the hostname`, async () => {
      const vfull = cfg({ mysqlSsl: 'verify-full', mysqlSslCa: REAL_CA, mysqlHost: host });
      if (host === '127.0.0.1') {
        // Refused at config validation (boot never gets as far as connecting)...
        assert.throws(() => validateMysqlTls(vfull), /verify-full needs MYSQL_HOST to be the DNS name/);
      } else {
        validateMysqlTls(vfull);
      }
      // ...and, independently, the TLS layer itself refuses with these options.
      const tls = require('node:tls');
      const orig = tls.checkServerIdentity;
      const seen = [];
      tls.checkServerIdentity = (h, cert) => { seen.push(h); return orig(h, cert); };
      try {
        await assert.rejects(connectExpectingRefusal(host, vfull), (e) => {
          assert.match(e.message, /does not match certificate's altnames|is not in the cert's list|is not cert's CN/);
          t.diagnostic(`verify-full ${host}: ${e.code} ${e.message} (identity checked as: ${JSON.stringify(seen)})`);
          return true;
        });
      } finally { tls.checkServerIdentity = orig; }
    });
  }

  await t.test('(c) a wrong CA fails to connect', async () => {
    // A real, valid cert that did NOT sign the MySQL server cert (tls-policy's fixture).
    const wrongCa = path.join(__dirname, 'fixtures', 'tls', 'cert.pem');
    const bad = cfg({ mysqlSsl: 'verify-ca', mysqlSslCa: wrongCa, mysqlHost: LOCAL_HOST });
    await assert.rejects(connectExpectingRefusal(LOCAL_HOST, bad), (e) => {
      t.diagnostic(`wrong CA: ${e.code} ${e.message}`);
      return /self[- ]signed|unable to (get|verify)|certificate/i.test(e.message);
    });
  });

  await t.test('(d) off connects exactly as before (no TLS)', async () => {
    const c = await connect(LOCAL_HOST, cfg({ mysqlHost: LOCAL_HOST }));
    try {
      assert.equal(await cipherOf(c), '');
      assert.equal(await assertMysqlTlsActive(c, cfg()), null);
    } finally { await c.end(); }
  });
});
