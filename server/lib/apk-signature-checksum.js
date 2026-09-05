"use strict";
// Ref 35 Stage B: SHA-256 checksum of the APK's SIGNING CERTIFICATE (not a whole-
// file hash) - this is specifically what Android's device-owner provisioning extra
// EXTRA_PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM verifies against. Confirmed
// against Android's own documented provisioning behaviour before writing this: the
// setup wizard downloads the APK, extracts ITS signing certificate, and compares
// the certificate's SHA-256 to this value - a whole-file hash would never match,
// and provisioning would fail on real hardware. (A separate, deprecated extra,
// EXTRA_PROVISIONING_DEVICE_ADMIN_PACKAGE_CHECKSUM, takes a whole-file hash, but
// that is a different key and not what we use here.)
//
// Reads the v1 (JAR) signature block (META-INF/*.RSA|.DSA|.EC) - which this repo's
// release build always carries alongside v2/v3 (see build.gradle.kts's
// resignReleaseV1, forced for MDM/signage compatibility, and conveniently the same
// artifact this needs) - walks its PKCS#7 SignedData ASN.1 structure with a
// minimal DER reader to isolate the first Certificate's raw DER bytes, and SHA-256
// hashes those bytes. No new dependency: `unzipper` (already used elsewhere in
// this server) reads the signature file out of the APK zip; ASN.1 walking is done
// by hand since Node has no built-in PKCS#7 parser.
//
// Verified against a real signed APK: the value this produces matches
// `openssl pkcs7 -print_certs` + `openssl x509 -outform DER | openssl dgst -sha256`
// byte-for-byte, and the isolated certificate bytes parse cleanly via Node's own
// crypto.X509Certificate (a malformed extraction throws there immediately).

const crypto = require("crypto");
const unzipper = require("unzipper");

function readTLV(buf, offset) {
  const tag = buf[offset];
  const lenByte = buf[offset + 1];
  let lenOfLen = 0;
  let length;
  if (lenByte & 0x80) {
    lenOfLen = lenByte & 0x7f;
    length = 0;
    for (let i = 0; i < lenOfLen; i++) length = (length << 8) | buf[offset + 2 + i];
  } else {
    length = lenByte;
  }
  const headerLen = 2 + lenOfLen;
  const contentStart = offset + headerLen;
  return { tag, contentStart, length, totalLen: headerLen + length };
}

// Walk a PKCS#7 SignedData DER blob:
//   ContentInfo ::= SEQUENCE { contentType OID, [0] EXPLICIT SignedData }
//   SignedData  ::= SEQUENCE { version INTEGER, digestAlgorithms SET,
//     contentInfo ContentInfo, certificates [0] IMPLICIT SET OF Certificate, ... }
// and return the raw DER bytes (full TLV) of the first certificate.
function extractFirstCertificateDer(pkcs7Der) {
  const contentInfo = readTLV(pkcs7Der, 0);
  if (contentInfo.tag !== 0x30) throw new Error("not a DER SEQUENCE (ContentInfo)");
  let off = contentInfo.contentStart;
  const oid = readTLV(pkcs7Der, off);
  off = oid.contentStart + oid.length;
  const explicit0 = readTLV(pkcs7Der, off);
  if (explicit0.tag !== 0xa0) throw new Error("expected [0] EXPLICIT after contentType OID");
  const signedData = readTLV(pkcs7Der, explicit0.contentStart);
  if (signedData.tag !== 0x30) throw new Error("expected SignedData SEQUENCE");
  let p = signedData.contentStart;
  const version = readTLV(pkcs7Der, p); p = version.contentStart + version.length;
  const digestAlgos = readTLV(pkcs7Der, p); p = digestAlgos.contentStart + digestAlgos.length;
  const innerContentInfo = readTLV(pkcs7Der, p); p = innerContentInfo.contentStart + innerContentInfo.length;
  const certificates = readTLV(pkcs7Der, p);
  if (certificates.tag !== 0xa0) {
    throw new Error(`expected [0] IMPLICIT certificates SET, got tag 0x${certificates.tag.toString(16)}`);
  }
  const firstCert = readTLV(pkcs7Der, certificates.contentStart);
  if (firstCert.tag !== 0x30) throw new Error("expected Certificate SEQUENCE inside certificates SET");
  return pkcs7Der.subarray(certificates.contentStart, certificates.contentStart + firstCert.totalLen);
}

// -> Promise<string>: the base64url (no padding) SHA-256 of the signing
// certificate's DER bytes - exactly the format
// EXTRA_PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM expects. Throws if the APK
// has no v1 signature file, or its PKCS#7 structure doesn't parse as expected.
async function computeSignatureChecksum(apkPath) {
  const dir = await unzipper.Open.file(apkPath);
  const sigFile = dir.files.find((f) => /^META-INF\/[^/]+\.(RSA|DSA|EC)$/i.test(f.path));
  if (!sigFile) {
    throw new Error("APK has no v1 (JAR) signature file under META-INF/ - cannot derive a signing certificate checksum");
  }
  const pkcs7 = await sigFile.buffer();
  const certDer = extractFirstCertificateDer(pkcs7);
  new crypto.X509Certificate(certDer); // throws if the extracted bytes aren't a real certificate
  return crypto.createHash("sha256").update(certDer).digest("base64url");
}

module.exports = { computeSignatureChecksum, extractFirstCertificateDer };
