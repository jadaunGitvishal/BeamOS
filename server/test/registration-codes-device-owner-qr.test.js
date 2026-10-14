'use strict';

// Ref 35 Stage B: GET /api/provisioning/registration-codes/:id/qr-device-owner.
// Separate file from registration-codes.test.js so it can control DATA_DIR (and
// therefore what lib/apk-cache.js resolves as "the APK") without disturbing that
// file's tests, which never touch apkCache.
//
// Covers what's REALLY provable in an automated test: the endpoint reuses the
// same code row / admin-RBAC gate as the simple QR, the PNG actually decodes (a
// real QR reader, not a byte-compare) to the exact JSON payload Android's own
// documented device-owner QR provisioning schema expects, with the real computed
// signing-certificate checksum embedded. It does NOT and CANNOT prove a real
// device accepts this payload during actual factory-reset provisioning - see
// this Ref's verification notes for what still needs real hardware.
//
// The REAL router (helpers/inprocess-app.js: /api/provisioning, requireAuth only)
// against the REAL MySQL test DB (beamos_test via npm test). Fixtures are test-owned
// (rq- prefix, generated ids) and removed afterwards (this file's codes first:
// registration_codes.created_by has no ON DELETE action), and so is the temp DATA_DIR.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-do-qr-' + crypto.randomBytes(4).toString('hex'));

const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const jsQR = require('jsqr');
const archiver = require('archiver');
const { db } = require('../db/database');
const { generateToken } = require('../middleware/auth');
const { startInProcessApp } = require('./helpers/inprocess-app');
const { randTag, cleanupUsers } = require('./helpers/disposable');
const apkCache = require('../lib/apk-cache');

const FIXTURE_PKCS7_B64 =
  'MIIDhAYJKoZIhvcNAQcCoIIDdTCCA3ECAQExADALBgkqhkiG9w0BBwGgggNZMIIDVTCCAj2gAwIBAgIU' +
  'QsRy8BTLtHFNY/aD6tVWiQ/c0WUwDQYJKoZIhvcNAQELBQAwOjEcMBoGA1UEAwwTQmVhbU9TIFRlc3Qg' +
  'Rml4dHVyZTENMAsGA1UECgwEVGVzdDELMAkGA1UEBhMCVVMwHhcNMjYwOTA1MTExOTMyWhcNMzYwOTAy' +
  'MTExOTMyWjA6MRwwGgYDVQQDDBNCZWFtT1MgVGVzdCBGaXh0dXJlMQ0wCwYDVQQKDARUZXN0MQswCQYD' +
  'VQQGEwJVUzCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAIw67GSWG9P41+DkbKUNq3lMMOFL' +
  'qAESFYsYkdFF16rmPVyG6OMD+Yawr3fqqjs8uUiGpZTJ+ER34IVg386SexCr530SGMC6A7YceuSGgJ8T' +
  '5Fut6Qj12QZTpIIfHpf9UIyTVMiEvWgWWQe/qZWcTjSSDxC7rHfFe7fDdPaauDELY8DksYvAIzG9FUho' +
  'jIo/i4Wwn0MisLvCT4LJh+WySngQjafDm0ZSEA6B8SDbI0s3AsogV7597x+kXpZrJjLAXbZwX0QoDgBU' +
  'F1apsxu9h7deuO/aY2UQ0DlT1d+GmvGgGa/h0iPlrrTacCRMPq24O01ZFTKM0M6vZo5UuWIShE8CAwEA' +
  'AaNTMFEwHQYDVR0OBBYEFIKz66I0bXa+xVg+QlCnVeiIasJFMB8GA1UdIwQYMBaAFIKz66I0bXa+xVg+' +
  'QlCnVeiIasJFMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAAYvlSTmjnVmiARITbDm' +
  'I85EBWcBXv2mIe/Nywr4db810plm9kEnv2N5Yp00NDIZMdlWp0FtkHv2SMxImbxySyM5dRODFmrXjwZc' +
  '5/3Iajv2m9aFKQUdMIrbtERrs5s6X1oZsg3a3UxByAE+OTakAkXKFo8WAiBo2u4D9JbLVVJ9qgEC5F0O' +
  'n5IXHe3cTDdjtUeODfEXs+taF3+4R03VhbSsJv9Lzh7X487qTZF10WrhrFILpnmvHKPnPNA57+EeG8tR' +
  'znJwr3FdN3X5TYkiqv4BbkpQ84e/NS8jotN3ufkpoSUyGuKqDtvjVLIjGEr93kikNjQAjUpOOa7SpyFw' +
  'aIMxAA==';
const EXPECTED_CHECKSUM = 'Dq_1_1HDwDRj6zaZtUd5uUjKaarOrU_FImU2SW-x_CY';

const P = `rq-${randTag()}`;
const id = (name) => `${P}-${name}`;
const ID = { admin: id('admin'), viewer: id('viewer'), orgA: id('org-a'), wsA: id('ws-a') };
const tok = {};
let app;

const authed = (token) => ({ headers: { Authorization: `Bearer ${token}` } });
const postJson = (token, body) => ({
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function writeFixtureApk(apkPath) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(apkPath), { recursive: true });
    const output = fs.createWriteStream(apkPath);
    const archive = archiver('zip');
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    archive.append(Buffer.from(FIXTURE_PKCS7_B64, 'base64'), { name: 'META-INF/CERT.RSA' });
    archive.finalize();
  });
}

test.before(async () => {
  app = await startInProcessApp({ only: ['/api/provisioning'] });
  const run = (sql, ...p) => app.db.prepare(sql).run(...p);
  const user = "INSERT INTO users (id, email, name, password_hash, auth_provider, role) VALUES (?, ?, ?, NULL, 'local', 'user')";
  await run(user, ID.admin, `${ID.admin}@t.test`, ID.admin);
  await run(user, ID.viewer, `${ID.viewer}@t.test`, ID.viewer);
  await run("INSERT INTO organizations (id, name, owner_user_id, plan_id, subscription_status) VALUES (?, ?, ?, 'enterprise', 'active')", ID.orgA, `${P} Org A`, ID.admin);
  await run('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)', ID.wsA, ID.orgA, 'Workspace A');
  await run("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin')", ID.wsA, ID.admin);
  await run("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_viewer')", ID.wsA, ID.viewer);
  tok.admin = generateToken({ id: ID.admin, email: `${ID.admin}@t.test`, role: 'user' }, ID.wsA);
  tok.viewer = generateToken({ id: ID.viewer, email: `${ID.viewer}@t.test`, role: 'user' }, ID.wsA);

  await writeFixtureApk(path.join(process.env.DATA_DIR, 'BeamOS.apk'));
  apkCache.refresh();
  for (let i = 0; i < 40 && apkCache.get().sigChecksum === null; i++) await sleep(25);
});

test.after(async () => {
  try {
    if (app) {
      await app.db.prepare('DELETE FROM registration_codes WHERE workspace_id = ?').run(ID.wsA);
      await cleanupUsers(app.db, [ID.viewer, ID.admin]);
    }
  } finally {
    try {
      if (app) await app.stop(); else await db.close();
    } finally {
      fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
    }
  }
});

async function decodeQrJson(pngBuffer) {
  const { data, info } = await sharp(pngBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const res = jsQR(new Uint8ClampedArray(data), info.width, info.height);
  return res ? JSON.parse(res.data) : null;
}

test('device-owner QR: precondition - apk-cache resolved the fixture APK and computed its checksum', () => {
  const apk = apkCache.get();
  assert.equal(apk.exists, true);
  assert.equal(apk.sigChecksum, EXPECTED_CHECKSUM);
});

test('device-owner QR: reuses the same code row, encodes the documented Android provisioning JSON schema', async () => {
  const mkRes = await fetch(`${app.base}/api/provisioning/registration-codes`,
    postJson(tok.admin, { workspace_id: ID.wsA, planned_device_name: 'Lobby kiosk' }));
  const { id, code } = await mkRes.json();

  const qrRes = await fetch(`${app.base}/api/provisioning/registration-codes/${id}/qr-device-owner`, authed(tok.admin));
  assert.equal(qrRes.status, 200);
  assert.equal(qrRes.headers.get('content-type'), 'image/png');
  const buf = Buffer.from(await qrRes.arrayBuffer());

  const payload = await decodeQrJson(buf);
  assert.ok(payload, 'QR image decodes to a payload');

  assert.equal(
    payload['android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME'],
    'com.remotedisplay.player/.service.DeviceAdminReceiver',
  );
  assert.equal(
    payload['android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION'],
    `${app.base}/download/apk`,
  );
  assert.equal(
    payload['android.app.extra.PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM'],
    EXPECTED_CHECKSUM,
    'the REAL computed signing-certificate checksum, not a placeholder',
  );

  const extras = payload['android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE'];
  assert.equal(typeof extras, 'object', 'ADMIN_EXTRAS_BUNDLE is a nested object, not a string');
  assert.equal(extras['com.remotedisplay.player.EXTRA_REGISTRATION_CODE'], code, 'carries OUR actual registration code');
  assert.equal(extras['com.remotedisplay.player.EXTRA_SERVER_URL'], app.base);
});

test('device-owner QR: unknown code id -> 404', async () => {
  const res = await fetch(`${app.base}/api/provisioning/registration-codes/does-not-exist/qr-device-owner`, authed(tok.admin));
  assert.equal(res.status, 404);
});

test('device-owner QR: a non-admin of the code\'s workspace is denied (403)', async () => {
  const mkRes = await fetch(`${app.base}/api/provisioning/registration-codes`, postJson(tok.admin, { workspace_id: ID.wsA }));
  const { id } = await mkRes.json();
  const res = await fetch(`${app.base}/api/provisioning/registration-codes/${id}/qr-device-owner`, authed(tok.viewer));
  assert.equal(res.status, 403);
});

test('device-owner QR: 503 when the APK is not available', async () => {
  const mkRes = await fetch(`${app.base}/api/provisioning/registration-codes`, postJson(tok.admin, { workspace_id: ID.wsA }));
  const { id } = await mkRes.json();

  const realGet = apkCache.get;
  apkCache.get = () => ({ path: null, exists: false, size: 0, mtime: 0, sigChecksum: null });
  try {
    const res = await fetch(`${app.base}/api/provisioning/registration-codes/${id}/qr-device-owner`, authed(tok.admin));
    assert.equal(res.status, 503);
  } finally {
    apkCache.get = realGet;
  }
});
