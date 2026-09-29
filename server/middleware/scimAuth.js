'use strict';

// Ref 8: bearer-token auth for the SCIM 2.0 endpoint (/scim/v2, routes/scim.js) -
// the static "Secret Token" an admin pastes into the Entra ID provisioning app.
// Validated exactly the way apiTokenAuth validates api_tokens: SHA-256 the
// presented secret (the SAME hashToken from middleware/apiToken.js, not a second
// implementation), look the hash up, refuse missing/revoked, throttle last_used_at.
//
// Deliberate difference from apiTokenAuth / entraTokenAuth: a SCIM token does NOT
// act as a user. There is no req.user afterwards - the caller is the IdP's
// provisioning service, authorized for ONE organization's directory (req.scim).
// That is also why this does NOT check whether created_by is deactivated (unlike
// the Stage 2 checks on st_ tokens and Entra SPs, which borrow their creator's
// workspace role): nothing here borrows created_by's authority, so an admin who
// minted the token leaving the company doesn't - and shouldn't - stop provisioning.
// Revoke the token itself (DELETE /api/admin/scim-tokens/:id) to stop it.

const crypto = require('crypto');
const { db } = require('../db/database');
const { asyncHandler } = require('../lib/async-handler');
const { hashToken } = require('./apiToken');

const SCIM_TOKEN_PREFIX = 'scim_';

// scim_ + 32 random bytes base64url (~48 chars) - same entropy as an st_ token.
function generateScimToken() {
  return SCIM_TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
}

function displayPrefix(token) {
  return token.slice(0, SCIM_TOKEN_PREFIX.length + 8); // e.g. 'scim_a1b2c3d4'
}

// RFC 7644 §3.12 error body. Kept here (not in routes/scim.js) so an auth failure
// is SCIM-shaped too - Entra's Test Connection surfaces this detail to the admin.
function scimError(res, status, detail, scimType) {
  const body = {
    schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
    status: String(status), // RFC 7644 §3.12: "status" is a string
    detail,
  };
  if (scimType) body.scimType = scimType;
  return res.status(status).type('application/scim+json').send(JSON.stringify(body));
}

const lastUsedThrottle = new Map();
async function touchLastUsed(id) {
  const now = Date.now();
  if (now - (lastUsedThrottle.get(id) || 0) < 60_000) return;
  lastUsedThrottle.set(id, now);
  try { await db.prepare('UPDATE scim_tokens SET last_used_at = UNIX_TIMESTAMP() WHERE id = ?').run(id); } catch { /* best-effort */ }
}

const scimAuth = asyncHandler(async function scimAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const raw = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!raw.startsWith(SCIM_TOKEN_PREFIX)) {
    return scimError(res, 401, 'A valid SCIM bearer token is required');
  }
  const row = await db.prepare('SELECT * FROM scim_tokens WHERE token_hash = ?').get(hashToken(raw));
  if (!row || row.revoked_at) {
    return scimError(res, 401, 'Invalid or revoked SCIM bearer token');
  }
  req.scim = { tokenId: row.id, organizationId: row.organization_id, name: row.name };
  touchLastUsed(row.id).catch(() => {});
  next();
});

module.exports = { scimAuth, scimError, generateScimToken, displayPrefix, SCIM_TOKEN_PREFIX };
