'use strict';

// Ref 31: one-time device hardware identity (make/model, display size, MAC,
// serial, SIM). Shared by BOTH device-onboarding paths so a device row is
// populated identically however it paired:
//   - ws/deviceSocket.js  device:register  -> persistHardwareInfo (UPDATE)
//   - routes/registration-codes.js claim   -> hardwareInsertColumns/Values (INSERT)
//
// The Android side (telemetry/DeviceInfo.kt getHardwareInfo) always sends a
// concrete string for every field it attempts - a real value, or an honest
// marker like "unavailable (requires Device Owner)" / "no SIM hardware" - never
// a blank. So on the server side there is nothing to invent: we just store what
// arrived. A NULL column means an older APK that predates this feature and never
// sent a `hardware` block at all.

// The 8 hardware columns + the capture timestamp, in a stable order the INSERT
// path can splice into its column list.
const HARDWARE_COLUMNS = [
  'manufacturer',
  'model',
  'display_size_inches',
  'mac_address',
  'serial_number',
  'sim_iccid',
  'sim_provider',
  'sim_network_status',
];

// Coerce one incoming value: trim strings, cap to the column width, keep null.
function clean(value, maxLen) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const s = String(value).trim();
  if (!s) return null;
  return maxLen && s.length > maxLen ? s.slice(0, maxLen) : s;
}

// display_size_inches is the only numeric field; clamp to a sane physical range
// so a bogus DisplayMetrics reading (common on cheap TV boxes) lands as NULL,
// not "0.3 inches".
function cleanInches(value) {
  const n = typeof value === 'number' ? value : parseFloat(value);
  if (!Number.isFinite(n) || n <= 1 || n > 200) return null;
  return Math.round(n * 10) / 10;
}

// Normalize a `hardware` payload object -> { column: value } for all 8 columns.
// Returns null when there is nothing usable (no payload / not an object).
function normalizeHardware(hw) {
  if (!hw || typeof hw !== 'object') return null;
  return {
    manufacturer: clean(hw.manufacturer, 100),
    model: clean(hw.model, 120),
    display_size_inches: cleanInches(hw.display_size_inches),
    mac_address: clean(hw.mac_address, 64),
    serial_number: clean(hw.serial_number, 128),
    sim_iccid: clean(hw.sim_iccid, 64),
    sim_provider: clean(hw.sim_provider, 100),
    sim_network_status: clean(hw.sim_network_status, 50),
  };
}

// UPDATE path (device:register). No-op when the payload is absent (old APK) or
// carries nothing usable, so it never wipes a previously-captured row.
async function persistHardwareInfo(db, deviceId, hw) {
  const norm = normalizeHardware(hw);
  if (!norm || !deviceId) return false;
  if (HARDWARE_COLUMNS.every((c) => norm[c] === null)) return false;
  const setSql = HARDWARE_COLUMNS.map((c) => `${c} = ?`).join(', ');
  await db
    .prepare(
      `UPDATE devices SET ${setSql}, hardware_captured_at = UNIX_TIMESTAMP() WHERE id = ?`,
    )
    .run(...HARDWARE_COLUMNS.map((c) => norm[c]), deviceId);
  return true;
}

// INSERT path (activation-code claim, which creates the row in one statement).
// Returns { columns, values } to splice into that INSERT; when there is no
// hardware payload it returns empty arrays so the INSERT is unchanged.
function hardwareInsertParts(hw) {
  const norm = normalizeHardware(hw);
  if (!norm) return { columns: [], values: [] };
  const usable = HARDWARE_COLUMNS.some((c) => norm[c] !== null);
  if (!usable) return { columns: [], values: [] };
  return {
    columns: [...HARDWARE_COLUMNS, 'hardware_captured_at'],
    values: [...HARDWARE_COLUMNS.map((c) => norm[c]), Math.floor(Date.now() / 1000)],
  };
}

module.exports = {
  HARDWARE_COLUMNS,
  normalizeHardware,
  persistHardwareInfo,
  hardwareInsertParts,
};
