'use strict';

// #146 P1.1 — resolveIdentity() runs on EVERY register. It must SHORT-CIRCUIT on
// device_id (the common case) and query device_fingerprints ONLY when device_id is
// absent — zero extra DB lookups for a device that sends its id.

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-ident-' + crypto.randomBytes(4).toString('hex'));

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const { resolveIdentity } = require('../lib/device-identity');

// Test-owned rows on the real test DB (beamos_test via npm test): a device and the
// fingerprint mapping to it (device_fingerprints.device_id has a real FK to devices).
const P = 'IR-' + crypto.randomBytes(4).toString('hex');
const DEV = `${P}-dev-x`;
const FP = `${P}-fp-x`;

// Count device_fingerprints lookups. device-identity prepares that statement ONCE,
// lazily, and memoizes it, so a prepare-spy alone can't see later lookups: this wraps
// db.prepare before the first resolve, and the memoized statement it hands out counts
// every get() it runs for the rest of the file.
let fpLookups = 0;
const realPrepare = db.prepare.bind(db);
db.prepare = (sql) => {
  const st = realPrepare(sql);
  if (!/device_fingerprints/.test(sql)) return st;
  return { ...st, get: async (...a) => { fpLookups++; return st.get(...a); } };
};

after(async () => {
  db.prepare = realPrepare;
  try {
    await db.prepare('DELETE FROM device_fingerprints WHERE fingerprint LIKE ?').run(P + '-%');
    await db.prepare('DELETE FROM devices WHERE id = ?').run(DEV);
  } finally {
    await db.close();
  }
});

test('a device_id-present resolve does ZERO fingerprint lookups', async () => {
  // warm the memoized statement first (a device_id-less resolve does one lookup)
  await resolveIdentity({ fingerprint: `${P}-warm` });
  assert.equal(fpLookups, 1, 'the spy sees the memoized fingerprint statement');
  const before = fpLookups;
  const r = await resolveIdentity({ device_id: 'dev-1', fingerprint: 'fp', device_token: 'tok' });
  assert.equal(r.kind, 'device_id');
  assert.equal(r.deviceId, 'dev-1');
  assert.equal(fpLookups - before, 0, 'no device_fingerprints query when device_id is present');
});

test('a device_id-absent resolve DOES query device_fingerprints (only then)', async () => {
  await db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(DEV, DEV);
  await db.prepare('INSERT INTO device_fingerprints (fingerprint, device_id) VALUES (?, ?)').run(FP, DEV);
  const before = fpLookups;
  const r = await resolveIdentity({ fingerprint: FP });
  assert.equal(r.kind, 'fingerprint->device_id');
  assert.equal(r.deviceId, DEV);
  assert.equal(fpLookups - before, 1, 'exactly one device_fingerprints lookup');
});
