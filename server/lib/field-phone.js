'use strict';

// Ref 43 — canonicalize a technician-typed phone number to ONE E.164 string, so
// the value stored on users.phone and the value looked up at OTP login always
// match regardless of how the digits were typed. This module is the single
// source of truth:
//   - server/routes/field-auth.js       — OTP login lookup (send-otp / verify-otp)
//   - server/routes/auth.js  PUT /me    — the phone-WRITE path (canonicalize before store)
//   - frontend/field-tech-src/src/lib/phone.js  — MIRRORS this logic (keep in
//     sync; the client can't read server env, so it hard-codes the default CC).
//
// The India-format gap this closes (found in Ref 43 Stage B1 live testing — a
// bare 10-digit number never matched the stored "+91…" form):
//   +919876543210      -> +919876543210   already international: trust it
//   +91 98765 43210    -> +919876543210   separators stripped
//   919876543210       -> +919876543210   CC present, just missing the "+"
//   9876543210         -> +919876543210   bare national -> prepend default CC
//   09876543210        -> +919876543210   national trunk "0" stripped, then CC
//   +447911123456      -> +447911123456   different country, explicit "+": untouched

const config = require('../config');

// National significant number length assumed when deciding whether a leading run
// of digits that equals the CC actually IS the country code, vs. just the start
// of a bare local number that happens to begin with those digits (e.g. an Indian
// mobile "91xxxxxxxx"). 10 fits India (the default CC). An operator retargeting
// FIELD_AUTH_DEFAULT_CC to a country with a different NSN length should revisit
// this and the client mirror.
const ASSUMED_NSN_LEN = 10;

/**
 * @returns {string|null} a single canonical "+<digits>" E.164 string, or null
 *   when the input can't be made into a plausible number (7-15 total digits).
 */
function normalizePhone(raw, cc = config.fieldAuthDefaultCC) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/[\s().-]/g, '');
  const CC = String(cc || '').replace(/\D/g, '');

  let e164;
  if (trimmed.startsWith('+')) {
    // Already international — NEVER prepend a CC (a UK "+44…" must stay "+44…").
    e164 = '+' + trimmed.slice(1).replace(/\D/g, '');
  } else {
    const digits = trimmed.replace(/\D/g, '').replace(/^0+/, ''); // drop national trunk prefix
    if (digits.length < 7) return null; // too few digits to be a real number (matches the pre-canonicalization floor)
    if (CC && digits.startsWith(CC) && digits.length >= CC.length + ASSUMED_NSN_LEN) {
      // "919876543210" — the country code is already there, only the "+" is missing.
      e164 = '+' + digits;
    } else if (CC) {
      // bare national number — prepend the default country code
      e164 = '+' + CC + digits;
    } else {
      e164 = '+' + digits;
    }
  }

  return /^\+[1-9]\d{6,14}$/.test(e164) ? e164 : null;
}

module.exports = { normalizePhone };
