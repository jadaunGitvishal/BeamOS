'use strict';

// Ref 35 Stage B: apk-cache.js exposes a signing-certificate checksum (sigChecksum)
// alongside path/size/mtime, recomputed only when the file's mtime changes - a
// poll/refresh flood (config.otaApkRefreshMs, default 60s) must not re-parse an
// unchanged APK on every tick.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-apkcache-checksum-' + crypto.randomBytes(4).toString('hex'));

const test = require('node:test');
const assert = require('node:assert/strict');
const archiver = require('archiver');
const apkCache = require('../lib/apk-cache');
const { computeSignatureChecksum } = require('../lib/apk-signature-checksum');

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('apk-cache: sigChecksum is computed asynchronously and eventually matches the real value', async () => {
  const apkPath = path.join(process.env.DATA_DIR, 'BeamOS.apk');
  await writeFixtureApk(apkPath);

  const c = apkCache.refresh();
  assert.equal(c.exists, true);
  // Computed off the hot path - not necessarily ready synchronously.
  assert.equal(c.sigChecksum, null, 'not computed yet on the very first refresh() call');

  for (let i = 0; i < 40 && apkCache.get().sigChecksum === null; i++) await sleep(25);
  assert.equal(apkCache.get().sigChecksum, EXPECTED_CHECKSUM);
});

test('apk-cache: does not recompute the checksum when mtime is unchanged', async () => {
  const apkPath = path.join(process.env.DATA_DIR, 'BeamOS.apk');
  // Preceding test already settled sigChecksum for this exact file/mtime.
  for (let i = 0; i < 40 && apkCache.get().sigChecksum === null; i++) await sleep(25);
  assert.equal(apkCache.get().sigChecksum, EXPECTED_CHECKSUM, 'precondition: checksum already settled');

  // apk-signature-checksum.js holds the whole `unzipper` module object (not a
  // destructured copy), so patching this shared, cached module's method is
  // actually observed by it - unlike patching computeSignatureChecksum itself,
  // which apk-cache.js already captured by value at its own require() time.
  const unzipper = require('unzipper');
  const realOpenFile = unzipper.Open.file;
  let calls = 0;
  unzipper.Open.file = (...a) => { calls++; return realOpenFile(...a); };
  try {
    for (let i = 0; i < 5; i++) apkCache.refresh();
    await sleep(50);
    assert.equal(calls, 0, 'unchanged mtime must not trigger a recompute (no re-read of the zip)');
    assert.equal(apkCache.get().sigChecksum, EXPECTED_CHECKSUM, 'cached value is preserved');
  } finally {
    unzipper.Open.file = realOpenFile;
  }
});
