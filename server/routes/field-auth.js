'use strict';

// ============================================================================
//  Ref 43 (Field Visit Inspections) — PLACEHOLDER field-technician OTP login.
//
//  ⚠️  THIS IS NOT PRODUCTION-READY AUTH.  ⚠️
//
//  `send-otp` does NOT send anything. It logs a single FIXED code
//  (DUMMY_OTP_CODE) to the server console. `verify-otp` accepts that one fixed
//  code for ANY phone number on file. There is no per-phone code, no expiry, no
//  attempt lockout beyond the coarse per-IP rate limit in server.js.
//
//  Before this is exposed to real technicians, replace it with a real flow:
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
const { db } = require('../db/database');
const { generateToken } = require('../middleware/auth');
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

async function findUserByPhone(phone) {
  return db
    .prepare('SELECT id, email, name, role, phone FROM users WHERE phone = ?')
    .get(phone);
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
// On the correct dummy code for a known phone: issue a real BeamOS session JWT.
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
    // Record the attempt (phone + IP only, never the submitted code).
    logActivity(
      user?.id || null,
      'auth:login_failed',
      `${phone} - ${user ? 'wrong code' : 'unknown phone'} (field OTP)`,
      null,
      getClientIp(req),
      null,
    ).catch(() => {});
    return res.status(401).json({ error: 'Invalid or expired code' });
  }

  // Reuse the existing session mechanism. Embed the user's first workspace (if
  // any) as the JWT's current_workspace_id, exactly like password login; a
  // field_technician with no workspace membership gets null and the field-visit
  // routes (URL-param scoped, no resolveTenancy) work regardless.
  const ws = await db
    .prepare(
      'SELECT workspace_id FROM workspace_members WHERE user_id = ? ORDER BY joined_at ASC LIMIT 1',
    )
    .get(user.id);
  const token = generateToken(user, ws?.workspace_id || null);

  try {
    await db
      .prepare('UPDATE users SET last_login = UNIX_TIMESTAMP() WHERE id = ?')
      .run(user.id);
  } catch { /* last_login is best-effort */ }

  res.json({
    token,
    current_workspace_id: ws?.workspace_id || null,
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
  });
}));

module.exports = router;
