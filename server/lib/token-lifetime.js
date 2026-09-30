'use strict';

// Ref 34: admin-defined maximum lifetime for static, long-lived programmatic
// credentials - api_tokens (st_..., middleware/apiToken.js) and scim_tokens
// (scim_..., middleware/scimAuth.js).
//
// The policy is ONE org-level number, organizations.max_token_lifetime_days
// (NULL = no cap, the default), checked against each token's EFFECTIVE AGE
// (now - created_at) at auth time. Deliberately NOT a per-row expires_at stamped
// at mint time:
//   - retroactive: lowering the cap immediately expires tokens minted before the
//     policy existed (the whole point - an admin tightening policy after an
//     audit finding must not have to hunt down and revoke old tokens by hand);
//   - no backfill: existing rows need nothing, and NULL keeps today's behaviour
//     for every deployment that never sets it;
//   - one source of truth: the auth check and the list endpoints derive
//     expires_at from the same (created_at, cap) pair via lifetimeExpiresAt().
// Consequence to be aware of: RAISING (or clearing) the cap also re-admits a
// token that was refused only for age. Age-expiry is policy, not revocation -
// revoked_at stays the permanent kill switch.
//
// Out of scope, on purpose:
//   - entra_service_principals (Ref 9): BeamOS stores no secret for these, only
//     the SP's client_id. Every call carries a fresh Entra-issued access token
//     whose exp is enforced by jwtVerify in middleware/entraToken.js, so its
//     lifetime is already bounded by Entra (and the SP's own client-secret /
//     certificate expiry is configured in Entra, not here).
//   - browser JWT sessions (config.jwtExpiry): an interactive human login, not
//     "programmatic access"; already bounded by its own expiry.

const DAY_SECONDS = 86400;
const MIN_LIFETIME_DAYS = 1;
const MAX_LIFETIME_DAYS = 3650; // 10 years: anything longer is "no cap" in practice

// created_at (epoch seconds) + cap, or null when the org sets no cap.
function lifetimeExpiresAt(createdAt, capDays) {
  if (capDays === null || capDays === undefined) return null;
  return Number(createdAt) + Number(capDays) * DAY_SECONDS;
}

// True once the token's age has reached the org's cap. Never true when uncapped.
function isBeyondLifetime(createdAt, capDays, nowSeconds = Math.floor(Date.now() / 1000)) {
  const exp = lifetimeExpiresAt(createdAt, capDays);
  return exp !== null && nowSeconds >= exp;
}

// Adds the computed fields list endpoints expose, so a consumer never has to
// re-derive the policy: expires_at (epoch seconds or null) and expired (bool).
function withLifetime(row, capDays, nowSeconds = Math.floor(Date.now() / 1000)) {
  const expires_at = lifetimeExpiresAt(row.created_at, capDays);
  return { ...row, expires_at, expired: expires_at !== null && nowSeconds >= expires_at };
}

// Validates a PATCH value. Returns { value } (an int, or null to clear) or { error }.
function parseLifetimeDays(raw) {
  if (raw === null) return { value: null };
  if (!Number.isInteger(raw) || raw < MIN_LIFETIME_DAYS || raw > MAX_LIFETIME_DAYS) {
    return { error: `max_token_lifetime_days must be an integer from ${MIN_LIFETIME_DAYS} to ${MAX_LIFETIME_DAYS}, or null for no cap` };
  }
  return { value: raw };
}

module.exports = {
  lifetimeExpiresAt, isBeyondLifetime, withLifetime, parseLifetimeDays,
  DAY_SECONDS, MIN_LIFETIME_DAYS, MAX_LIFETIME_DAYS,
};
