'use strict';

// ============================================================================
//  Ref 43 (Field Visit Inspections) — PLACEHOLDER field-technician OTP login.
//
//  ⚠️  DEV/TEST ONLY. THIS IS NOT PRODUCTION-READY AUTH.  ⚠️
//
//  `send-otp` does NOT send anything. It logs a single FIXED code
//  (DUMMY_OTP_CODE) to the server console. `verify-otp` accepts that one fixed
//  code. There is no per-phone code, no expiry, no attempt lockout beyond the
//  coarse per-IP rate limit in server.js.
//
//  PMI security fix (Stage 1) — the fixed code is public (repo + history), so:
//    - Guarded by FIELD_OTP_ENABLED (config.fieldOtpEnabled, default OFF). When
//      off, server.js mounts nothing at /api/field-auth (plain 404), and this
//      router also answers 404 if mounted anyway.
//    - Refused in production: server.js will not start with FIELD_OTP_ENABLED
//      set when NODE_ENV=production, and this router 404s under production too.
//    - Technician-only: a session is issued ONLY to a plain user (users.role =
//      'user') whose sole memberships are organization_members rows with role
//      'field_technician' — no other org role, no workspace_members row, and
//      TOTP not enabled. Everyone else gets the same generic 401 as a wrong code,
//      so this route can never mint an admin/owner/workspace/platform session
//      and never bypasses TOTP or Ref 5 SSO-only (technician-only users are the
//      deliberate Ref 5 exception).
//
//  Stage 2 replaces this with a real flow before technicians use it:
//    - generate a random 6-digit code per request, store it hashed with a short
//      TTL (a `field_otp_codes` table or a cache), and
//    - deliver it via a real SMS provider (Twilio / MessageBird / SNS), and
//    - add per-phone attempt lockout (mirror lib/totp-lockout.js).
//  The route CONTRACT (POST send-otp {phone} -> POST verify-otp {phone,code} ->
//  { token }) is designed to survive that swap unchanged.
//
//  What IS real: the session token minted on success. It is an ordinary BeamOS
//  JWT from middleware/auth.generateToken — the SAME mechanism password login
//  uses — so every existing permission function (incl. canLogFieldVisit, which
//  reads organization_members.role) applies to it with no special-casing.
// ============================================================================

const express = require('express');
const router = express.Router();
const config = require('../config');
const { db } = require('../db/database');
const { generateToken, ACCOUNT_DEACTIVATED_MESSAGE } = require('../middleware/auth');
const { asyncHandler } = require('../lib/async-handler');
// Single source of truth for phone canonicalization — the SAME function the
// phone-write path (routes/auth.js PUT /me) uses before storing, so a number
// typed any way (bare 10-digit, "+91…", "0…", spaces) resolves to the one
// stored E.164 value. See lib/field-phone.js.
const { normalizePhone } = require('../lib/field-phone');
// Ref 17: failed OTP verification is an authentication event the RFP wants
// captured. Same writer + label as password-login failures in routes/auth.js.
const { logActivity, getClientIp } = require('../services/activity');

// PLACEHOLDER: the one code every field login accepts. Given to technicians out
// of band; never shown in the app UI. Delete when the real SMS-backed flow lands.
const DUMMY_OTP_CODE = '000999';

const INVALID_CODE = { error: 'Invalid or expired code' };

// Defence in depth: even if this router is mounted somewhere other than the
// flag-gated mount in server.js, it answers nothing unless explicitly enabled
// outside production.
router.use((req, res, next) => {
  if (config.fieldOtpEnabled && process.env.NODE_ENV !== 'production') return next();
  res.status(404).json({ error: 'Not found' });
});

async function findUserByPhone(phone) {
  return db
    .prepare('SELECT id, email, name, role, phone, deactivated_at, totp_enabled FROM users WHERE phone = ?')
    .get(phone);
}

// Returns null when the user may sign in with the field OTP, else a short reason
// for the audit log (never shown to the caller). Technician-only means: plain
// 'user' platform role, >= 1 org membership, ALL of them field_technician, no
// workspace membership at all, and no TOTP (the same users.totp_enabled flag
// /api/auth/login gates on).
async function technicianOnlyRefusal(user) {
  if (user.role !== 'user') return 'platform role';
  const orgRoles = await db
    .prepare('SELECT role FROM organization_members WHERE user_id = ?')
    .all(user.id);
  if (!orgRoles.some((r) => r.role === 'field_technician')) return 'not a field technician';
  if (orgRoles.some((r) => r.role !== 'field_technician')) return 'has another org role';
  const ws = await db
    .prepare('SELECT 1 AS hit FROM workspace_members WHERE user_id = ? LIMIT 1')
    .get(user.id);
  if (ws) return 'has a workspace membership';
  if (user.totp_enabled) return 'TOTP enabled';
  return null;
}

// The single refusal used for unknown phone, wrong code and ineligible account,
// so the caller cannot tell them apart. Records phone + IP only, never the code.
function refuse(req, res, phone, user, reason) {
  logActivity(
    user?.id || null,
    'auth:login_failed',
    `${phone} - ${reason} (field OTP)`,
    null,
    getClientIp(req),
    null,
  ).catch(() => {});
  return res.status(401).json(INVALID_CODE);
}

// POST /api/field-auth/send-otp  { phone }
// Always 200 { sent: true } (no phone-enumeration oracle). PLACEHOLDER: logs the
// fixed dummy code server-side instead of sending an SMS.
router.post('/send-otp', asyncHandler(async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  if (!phone) return res.status(400).json({ error: 'A valid phone number is required' });

  const user = await findUserByPhone(phone);
  // Intentionally uniform response whether or not a user matched.
  console.warn(
    `[field-auth] PLACEHOLDER OTP for ${phone}: code=${DUMMY_OTP_CODE} ` +
      `(user ${user ? user.id : 'NOT FOUND'}) — no SMS sent, this is a dev stub`,
  );
  res.json({ sent: true });
}));

// POST /api/field-auth/verify-otp  { phone, code }
// On the correct dummy code for a known, technician-only phone: issue a real
// BeamOS session JWT.
router.post('/verify-otp', asyncHandler(async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  const code = String(req.body?.code || '').trim();
  if (!phone || !code) {
    return res.status(400).json({ error: 'phone and code are required' });
  }

  const user = await findUserByPhone(phone);
  // PLACEHOLDER check — one fixed code, constant-time-ish compare is pointless
  // for a hardcoded stub. Wrong code OR unknown phone -> the same 401.
  if (!user || code !== DUMMY_OTP_CODE) {
    return refuse(req, res, phone, user, user ? 'wrong code' : 'unknown phone');
  }
  // PMI: only technician-only accounts may use this route. Same 401 as above, so
  // it reveals nothing about the account behind the phone.
  const refusal = await technicianOnlyRefusal(user);
  if (refusal) return refuse(req, res, phone, user, refusal);
  // Ref 5/8: a deactivated technician can't obtain a session (checked after the
  // code, so it isn't a phone-enumeration oracle). Their EXISTING field-tech JWT is
  // an ordinary session token and already dies in requireAuth.
  if (user.deactivated_at) {
    return res.status(403).json({ error: ACCOUNT_DEACTIVATED_MESSAGE });
  }

  // Reuse the existing session mechanism. A technician-only user has no
  // workspace_members row, so current_workspace_id is null; the field-visit
  // routes (URL-param scoped, no resolveTenancy) work regardless.
  const token = generateToken(user, null);

  try {
    await db
      .prepare('UPDATE users SET last_login = UNIX_TIMESTAMP() WHERE id = ?')
      .run(user.id);
  } catch { /* last_login is best-effort */ }

  res.json({
    token,
    current_workspace_id: null,
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
  });
}));

module.exports = router;
