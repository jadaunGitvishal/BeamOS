'use strict';

// Ref 35 Stage B: lib/apk-signature-checksum.js computes the SHA-256 of an APK's
// SIGNING CERTIFICATE (not the whole file) - the value Android's device-owner
// provisioning extra EXTRA_PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM verifies
// against. The fixture below is a real PKCS#7 SignedData blob (openssl
// `crl2pkcs7 -nocrl -certfile ... -outform DER`) wrapping a real self-signed test
// certificate - the same structure an APK's META-INF/CERT.RSA carries. The
// EXPECTED constant was computed independently via
// `openssl x509 -outform DER | openssl dgst -sha256` and cross-checked against
// this module's own output before being hardcoded here, so this test catches a
// regression in the ASN.1 walk without depending on any machine-specific
// Android debug keystore.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const archiver = require('archiver');
const { extractFirstCertificateDer, computeSignatureChecksum } = require('../lib/apk-signature-checksum');

// `openssl req -x509 -newkey rsa:2048 -subj "/CN=BeamOS Test Fixture/O=Test/C=US" ...`
// then `openssl crl2pkcs7 -nocrl -certfile test.pem -outform DER`.
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

test('extractFirstCertificateDer: isolates a real X.509 certificate from a PKCS#7 SignedData blob', () => {
  const pkcs7 = Buffer.from(FIXTURE_PKCS7_B64, 'base64');
  const certDer = extractFirstCertificateDer(pkcs7);
  // Must parse cleanly as a real certificate (not just "some bytes").
  const x509 = new crypto.X509Certificate(certDer);
  assert.match(x509.subject, /CN=BeamOS Test Fixture/);
  const checksum = crypto.createHash('sha256').update(certDer).digest('base64url');
  assert.equal(checksum, EXPECTED_CHECKSUM, 'matches the independently-computed openssl ground truth');
});

test('extractFirstCertificateDer: throws on garbage input rather than returning wrong bytes', () => {
  assert.throws(() => extractFirstCertificateDer(Buffer.from('not a der structure at all')));
});

test('computeSignatureChecksum: end-to-end from a real zip file containing META-INF/CERT.RSA', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apk-sig-test-'));
  const apkPath = path.join(dir, 'fake.apk');
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(apkPath);
    const archive = archiver('zip');
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    archive.append(Buffer.from(FIXTURE_PKCS7_B64, 'base64'), { name: 'META-INF/CERT.RSA' });
    archive.append('dummy manifest content', { name: 'META-INF/MANIFEST.MF' });
    archive.finalize();
  });

  const checksum = await computeSignatureChecksum(apkPath);
  assert.equal(checksum, EXPECTED_CHECKSUM);
});

test('computeSignatureChecksum: rejects when the zip has no META-INF signature file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apk-sig-test-'));
  const apkPath = path.join(dir, 'unsigned.apk');
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(apkPath);
    const archive = archiver('zip');
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    archive.append('nothing signed here', { name: 'classes.dex' });
    archive.finalize();
  });

  await assert.rejects(() => computeSignatureChecksum(apkPath), /no v1 \(JAR\) signature file/);
});
