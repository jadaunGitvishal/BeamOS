'use strict';

// Ref 31: pure normalization for the one-time device hardware identity payload.
// No DB, no Android - just "what the device sent -> what we store". The two
// write paths (ws/deviceSocket.js device:register UPDATE, routes/registration-
// codes.js claim INSERT) both route through this, so a bug here shows up
// identically in both flows.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeHardware,
  hardwareInsertParts,
  persistHardwareInfo,
  HARDWARE_COLUMNS,
} = require('../lib/device-hardware');

test('no payload -> nothing to store (null / empty splice)', () => {
  assert.equal(normalizeHardware(null), null);
  assert.equal(normalizeHardware(undefined), null);
  assert.equal(normalizeHardware('nope'), null);
  assert.deepEqual(hardwareInsertParts(undefined), { columns: [], values: [] });
});

test('honest marker strings are stored verbatim, never blanked', () => {
  const n = normalizeHardware({
    manufacturer: 'Amlogic',
    model: 'S905X4',
    mac_address: 'unavailable (requires Device Owner)',
    serial_number: 'unavailable (requires Device Owner)',
    sim_iccid: 'no SIM hardware',
    sim_provider: 'no SIM hardware',
    sim_network_status: 'NO_TELEPHONY',
  });
  assert.equal(n.manufacturer, 'Amlogic');
  assert.equal(n.mac_address, 'unavailable (requires Device Owner)');
  assert.equal(n.sim_network_status, 'NO_TELEPHONY');
});

test('strings are trimmed; empty -> null; over-width -> truncated', () => {
  const n = normalizeHardware({
    manufacturer: '  Sony  ',
    sim_provider: '   ',
    model: 'M'.repeat(400),
  });
  assert.equal(n.manufacturer, 'Sony');
  assert.equal(n.sim_provider, null, 'whitespace-only -> null');
  assert.equal(n.model.length, 120, 'capped to the column width');
});

test('is_device_owner: real booleans -> 1/0, anything else -> null (never coerced to false)', () => {
  assert.equal(normalizeHardware({ is_device_owner: true }).is_device_owner, 1);
  assert.equal(normalizeHardware({ is_device_owner: false }).is_device_owner, 0);
  assert.equal(normalizeHardware({}).is_device_owner, null, 'absent (old APK) -> null, not false');
  assert.equal(normalizeHardware({ is_device_owner: 'true' }).is_device_owner, null, 'string is not a real boolean');
  assert.equal(normalizeHardware({ is_device_owner: 1 }).is_device_owner, null, 'number is not a real boolean');
});

test('display_size_inches: sane number kept & rounded, impossible values -> null', () => {
  assert.equal(normalizeHardware({ display_size_inches: 54.63 }).display_size_inches, 54.6);
  assert.equal(normalizeHardware({ display_size_inches: '43' }).display_size_inches, 43);
  assert.equal(normalizeHardware({ display_size_inches: 0.4 }).display_size_inches, null);
  assert.equal(normalizeHardware({ display_size_inches: 5000 }).display_size_inches, null);
  assert.equal(normalizeHardware({ display_size_inches: 'huge' }).display_size_inches, null);
  assert.equal(normalizeHardware({ display_size_inches: null }).display_size_inches, null);
});

test('hardwareInsertParts appends columns + a capture timestamp when usable', () => {
  const parts = hardwareInsertParts({ manufacturer: 'LG', model: 'WebOS box' });
  assert.deepEqual(parts.columns, [...HARDWARE_COLUMNS, 'hardware_captured_at']);
  assert.equal(parts.columns.length, parts.values.length);
  assert.equal(parts.values[0], 'LG');
  assert.ok(parts.values[parts.values.length - 1] > 1_700_000_000, 'trailing capture ts');
});

test('hardwareInsertParts stays empty when every field is null (no-op INSERT)', () => {
  assert.deepEqual(
    hardwareInsertParts({ manufacturer: '', model: null, display_size_inches: 0 }),
    { columns: [], values: [] },
  );
});

test('persistHardwareInfo: UPDATEs only the hardware columns, stamps hardware_captured_at', async () => {
  const calls = [];
  const fakeDb = {
    prepare(sql) {
      return { run: async (...params) => { calls.push({ sql, params }); return { changes: 1 }; } };
    },
  };
  const ok = await persistHardwareInfo(fakeDb, 'dev-1', {
    manufacturer: 'Xiaomi', model: 'MiBox', sim_network_status: 'READY',
  });
  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /UPDATE devices SET .*hardware_captured_at = UNIX_TIMESTAMP\(\) WHERE id = \?/s);
  for (const c of HARDWARE_COLUMNS) assert.match(calls[0].sql, new RegExp(`\\b${c} = \\?`));
  assert.equal(calls[0].params[0], 'Xiaomi');
  assert.equal(calls[0].params[calls[0].params.length - 1], 'dev-1', 'device id is the last bind');
});

test('persistHardwareInfo: no payload / all-null -> no DB write (never wipes a captured row)', async () => {
  let wrote = false;
  const fakeDb = { prepare: () => ({ run: async () => { wrote = true; } }) };
  assert.equal(await persistHardwareInfo(fakeDb, 'dev-1', null), false);
  assert.equal(await persistHardwareInfo(fakeDb, 'dev-1', { manufacturer: '' }), false);
  assert.equal(await persistHardwareInfo(fakeDb, '', { manufacturer: 'Sony' }), false);
  assert.equal(wrote, false);
});
