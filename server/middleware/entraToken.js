'use strict';

// Ref 9: OAuth 2.0 client credentials / Entra ID Service Principal auth - a THIRD
// front door alongside JWT sessions (requireAuth) and st_ API tokens (apiTokenAuth),
// for machine-to-machine callers holding an Entra-ID-issued access token instead of
// either. See docs/entra-auth.md for the full library research, threat-model
// reasoning, and Entra app-registration setup guide - this file only implements
// what that doc already worked out.
//
// REUSE, not a parallel system: this middleware's only job is to resolve an Entra
// JWT down to the EXACT SAME { req.viaToken, req.tokenScope, req.jwtWorkspaceId }
// shape api_tokens already produces (middleware/apiToken.js), via a DIFFERENT
// lookup (entra_service_principals instead of api_tokens). tokenScopeGate /
// requireScope / agencyGate / requireBillingRead read only that shape and are not
// modified at all - they enforce identically for either auth path.
//
// LIBRARY CHOICE (researched, not guessed - see docs/entra-auth.md):
//   - @azure/msal-node (already a dependency, used by services/email.js) is a
//     CLIENT library for ACQUIRING tokens, not a resource-server validation
//     library. Wrong tool for this side of the flow.
//   - passport-azure-ad (Microsoft's own older sample library for this) is
//     deprecated and unmaintained - no security fixes. Ruled out.
//   - jose (panva/jose): actively maintained, zero runtime dependencies, and
//     safe by construction against the exact vulnerability class this file
//     exists to avoid - its own docs state unsecured JWTs (alg:"none") are
//     NEVER accepted, unconditionally, and createRemoteJWKSet binds
//     verification to each JWK's own algorithm family, closing off RS256/HS256
//     algorithm-confusion attacks. We still pass algorithms:['RS256'] explicitly
//     below as defense in depth.
const { jwtVerify, createRemoteJWKSet, decodeJwt } = require('jose');
const config = require('../config');
const { db } = require('../db/database');
const { asyncHandler } = require('../lib/async-handler');

// Recognised Entra ID / Azure AD issuer authority hosts. Used ONLY to decide which
// validation path an incoming Bearer token should be routed through - our own
// session JWT (HS256, no `iss` claim at all - see middleware/auth.js generateToken)
// vs an Entra-issued one (RS256, `iss` under one of these hosts). jose's decodeJwt()
// is explicitly documented as UNSAFE for trust decisions (no signature check) - that
// is fine here because this is only a routing peek, never a trust decision. The
// actual trust decision happens in verifyEntraAccessToken() below, which
// independently re-verifies signature + issuer + audience + algorithm against the
// real JWKS. Routing a forged/malformed token down this path is harmless: it will
// simply fail real verification (unknown kid / bad signature / wrong issuer), same
// as it would fail anywhere else.
const ENTRA_ISSUER_HOSTS = ['login.microsoftonline.com', 'sts.windows.net'];

// Does this Bearer token look like an Entra-issued JWT (as opposed to our own st_...
// API token or our own session JWT)? Structural check, not just "has dots" - decodes
// the (unverified) payload and checks the `iss` claim's HOST, so a token that merely
// happens to be JWT-shaped but isn't ours and isn't Entra's still falls through to
// the ordinary requireAuth path (which will 401 it as an invalid session token,
// same as it does today for any garbage Bearer value).
function looksLikeEntraToken(raw) {
  if (!raw) return false;
  try {
    const claims = decodeJwt(raw);
    if (typeof claims.iss !== 'string') return false;
    return ENTRA_ISSUER_HOSTS.includes(new URL(claims.iss).host);
  } catch {
    return false; // not a well-formed JWT at all
  }
}

function entraConfigured() {
  return !!(config.entraTenantId && config.entraApiClientId);
}

// Built once, reused across requests. createRemoteJWKSet itself caches the fetched
// key set and only re-fetches when a request's `kid` isn't in the cache (rate-limited
// via its own cooldown) - see docs/entra-auth.md's jose research for the exact
// documented behaviour. Lazily constructed (not at module load) so a deployment that
// never sets ENTRA_TENANT_ID never even builds a JWKS client, matching this
// codebase's existing convention of not doing Azure-integration setup work for
// unconfigured optional features (services/email.js's lazy msal-node require).
let _jwks = null;
let _jwksTenantId = null;
function getJwks() {
  // Rebuild if the configured tenant ever changes (test suites reconfigure config
  // between cases; a long-lived process never does in practice).
  if (_jwks && _jwksTenantId === config.entraTenantId) return _jwks;
  _jwksTenantId = config.entraTenantId;
  _jwks = createRemoteJWKSet(
    new URL(`https://login.microsoftonline.com/${config.entraTenantId}/discovery/v2.0/keys`),
  );
  return _jwks;
}

function entraIssuer() {
  return `https://login.microsoftonline.com/${config.entraTenantId}/v2.0`;
}

// The actual verification, split out from the Express middleware below so it can be
// unit-tested directly against a real or realistic JWT without needing an Express
// req/res pair (see test/entra-token.test.js).
//
// Checks, per docs/entra-auth.md's research:
//   - signature, against Entra's real JWKS for the configured tenant
//   - issuer  === https://login.microsoftonline.com/{ENTRA_TENANT_ID}/v2.0 (exact)
//   - audience === ENTRA_API_CLIENT_ID (this app registration's own client ID -
//     the confused-deputy guard: a token minted for a DIFFERENT API must not work here)
//   - algorithm: RS256 only (explicit allowlist; jose also refuses alg:"none"
//     unconditionally regardless of this option)
//   - clock skew: 30s tolerance on exp/nbf
//   - idtyp === 'app': Entra's own documented discriminator for "this is a
//     client-credentials / app-only token", not a delegated user token that
//     happens to carry a matching azp. This is an OPTIONAL Entra claim - our app
//     registration must explicitly enable it (see docs/entra-auth.md) - so its
//     absence is treated as a validation failure, not "unknown, allow".
//
// `overrides` (jwks/issuer/audience) exists ONLY so test/entra-token.test.js can
// exercise this exact function - the real signature/issuer/audience/algorithm/idtyp
// checks below, unmodified - against a realistic self-signed token and a local JWKS,
// without a real Entra tenant or a network call. Production code never passes
// overrides; it always resolves the real trust anchors from config.
async function verifyEntraAccessToken(raw, overrides = {}) {
  const jwks = overrides.jwks || getJwks();
  const issuer = overrides.issuer || entraIssuer();
  const audience = overrides.audience || config.entraApiClientId;
  const { payload } = await jwtVerify(raw, jwks, {
    issuer,
    audience,
    algorithms: ['RS256'],
    clockTolerance: 30,
  });

  if (payload.idtyp !== 'app') {
    throw new Error('token is not an app-only (client-credentials) token');
  }
  // v2.0 tokens (which is what we require via requestedAccessTokenVersion=2 on the
  // app registration - see docs/entra-auth.md) carry the calling application's
  // client ID in `azp`. `appid` is the v1.0-token equivalent; accepted as a fallback
  // only in case a misconfigured app registration ever issues one, not the expected path.
  const clientId = payload.azp || payload.appid;
  if (!clientId) {
    throw new Error('token carries no azp/appid claim');
  }
  return { clientId, payload };
}

// Throttle last_used_at writes exactly like apiToken.js's touchLastUsed.
const lastUsedThrottle = new Map();
async function touchLastUsed(id) {
  const now = Date.now();
  if (now - (lastUsedThrottle.get(id) || 0) < 60_000) return;
  lastUsedThrottle.set(id, now);
  try {
    await db.prepare('UPDATE entra_service_principals SET last_used_at = UNIX_TIMESTAMP() WHERE id = ?').run(id);
  } catch { /* best-effort */ }
}

const entraTokenAuth = asyncHandler(async function entraTokenAuth(req, res, next) {
  if (!entraConfigured()) {
    return res.status(401).json({ error: 'Entra ID authentication is not configured on this server' });
  }

  const header = req.headers.authorization || '';
  const raw = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

  let clientId;
  try {
    ({ clientId } = await verifyEntraAccessToken(raw));
  } catch (err) {
    return res.status(401).json({ error: 'Invalid Entra ID access token: ' + err.message });
  }

  const row = await db.prepare('SELECT * FROM entra_service_principals WHERE client_id = ?').get(clientId);
  if (!row || row.revoked_at) {
    return res.status(403).json({ error: 'This Service Principal is not registered for API access' });
  }

  // Act AS the admin who registered this Service Principal - same pattern
  // api_tokens already uses (acts as its owning user_id), so workspace-role
  // resolution (resolveTenancy, keyed on req.user.id + req.jwtWorkspaceId) works
  // completely unmodified. Platform powers stripped exactly like a token.
  const user = await db.prepare(
    'SELECT id, email, name, role, auth_provider, avatar_url, plan_id, email_alerts, must_change_password FROM users WHERE id = ?',
  ).get(row.created_by);
  if (!user) return res.status(401).json({ error: 'Service Principal registrant not found' });

  req.user = { ...user, role: 'user' };
  delete req.headers['x-workspace-id'];
  if (req.query) delete req.query.workspace_id;
  req.jwtWorkspaceId = row.workspace_id;
  req.viaToken = true;
  req.tokenScope = row.scope;
  req.entraServicePrincipal = { id: row.id, client_id: row.client_id, name: row.name, workspace_id: row.workspace_id };

  touchLastUsed(row.id).catch(() => {});
  next();
});

module.exports = {
  looksLikeEntraToken,
  entraTokenAuth,
  verifyEntraAccessToken, // exported for direct unit-testing (see test/entra-token.test.js)
  entraConfigured,
};
