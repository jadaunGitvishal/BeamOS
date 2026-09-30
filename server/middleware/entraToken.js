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
//
// Keyed per tenant: Ref 9 (this middleware) trusts config.entraTenantId, while
// Ref 5's SSO login (verifyEntraIdToken below) trusts config.ssoTenantId - two
// independently-configured settings that MAY name the same tenant, in which case
// they share one cached key set. Defaults to entraTenantId so every Ref 9 call site
// is unchanged.
const _jwksByTenant = new Map();
function getJwks(tenantId = config.entraTenantId) {
  let jwks = _jwksByTenant.get(tenantId);
  if (!jwks) {
    jwks = createRemoteJWKSet(
      new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`),
    );
    _jwksByTenant.set(tenantId, jwks);
  }
  return jwks;
}

function entraIssuer(tenantId = config.entraTenantId) {
  return `https://login.microsoftonline.com/${tenantId}/v2.0`;
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

// Ref 5: the SAME trust-anchor builders (getJwks() / entraIssuer() - a tenant's
// JWKS and exact v2.0 issuer), pointed at config.ssoTenantId, applied to a
// DIFFERENT token: a human user's OIDC id_token from "Sign in with Microsoft" (routes/auth.js POST /microsoft), instead of
// a Service Principal's app-only access token. Differences from
// verifyEntraAccessToken above, and why:
//   - audience is config.microsoftClientId (the SPA login app registration the
//     frontend's MSAL popup uses), not entraApiClientId. Per Microsoft's ID token
//     claims reference, an id_token's `aud` is always the signing-in app's client ID.
//   - idtyp === 'app' is REJECTED here (the inverse of the check above): an app-only
//     token minted for the same client ID must never pass as a user sign-in.
//   - `tid` is re-checked against the configured tenant even though the exact-issuer
//     check already implies it - defense in depth, and the claim Microsoft's docs
//     name as THE tenant-restriction signal ("use the GUID portion ... to restrict
//     the set of tenants that can sign in").
//   - `oid` (immutable per-tenant user object ID, == Graph's user `id`, which is what
//     the pre-Ref-5 access-token flow already stored in users.provider_id) is required.
//
// MFA (config.entraRequireMfa): checks `amr` includes "mfa". Why `amr` and not `acr`:
// Microsoft's ID token claims reference (learn.microsoft.com/entra/identity-platform/
// id-token-claims-reference) documents NO `acr` claim for v2.0 id_tokens at all, and
// the optional claims reference (.../optional-claims-reference, "v2.0-specific
// optional claims set") lists `amr` as a v2.0 optional claim - "always included in
// v1.0 tokens, but not included in v2.0 tokens unless requested" - with the
// documented rule "The multipleauthn and mfa values are emitted only when the user
// has completed MFA" (e.g. Authenticator push -> rsa, ngcmfa, mfa; SMS -> sms, mfa;
// password alone -> pwd). So the app registration MUST add `amr` as an ID-token
// optional claim for this check to ever pass; a token with NO amr claim at all is
// failed closed with an error that says exactly that (a misconfiguration), distinct
// from an amr that is present but lacks "mfa" (the user genuinely skipped MFA).
// NOTE: tested only against self-signed tokens shaped per those docs - no real
// tenant was available; see docs/sso-scim-integration.md.
//
// `overrides` exists for the same reason, and with the same production guarantee, as
// verifyEntraAccessToken's (see test/microsoft-sso.test.js).
async function verifyEntraIdToken(raw, overrides = {}) {
  // SSO_TENANT_ID, NOT ENTRA_TENANT_ID - see config.js ssoTenantId for why the two
  // are configured independently.
  const tenantId = overrides.tenantId || config.ssoTenantId;
  if (!tenantId) {
    throw new Error('SSO_TENANT_ID is not configured; cannot validate the id_token issuer');
  }
  const jwks = overrides.jwks || getJwks(tenantId);
  const issuer = overrides.issuer || entraIssuer(tenantId);
  const audience = overrides.audience || config.microsoftClientId;
  const requireMfa = overrides.requireMfa !== undefined ? overrides.requireMfa : config.entraRequireMfa;
  if (!audience) {
    // Never call jwtVerify with an undefined audience - jose would then skip the
    // audience check entirely, accepting an id_token minted for ANY app in the tenant.
    throw new Error('MICROSOFT_CLIENT_ID is not configured; cannot validate the id_token audience');
  }
  const { payload } = await jwtVerify(raw, jwks, {
    issuer,
    audience,
    algorithms: ['RS256'],
    clockTolerance: 30,
  });

  if (payload.tid !== tenantId) {
    throw new Error('token was not issued for the configured Entra tenant');
  }
  if (payload.idtyp === 'app') {
    throw new Error('token is an app-only token, not a user sign-in');
  }
  if (!payload.oid) {
    throw new Error('token carries no oid (user object ID) claim');
  }
  // `email` is present only if the app registration requests it (optional claim /
  // email scope); `preferred_username` (UPN for work accounts) is present with the
  // `profile` scope MSAL always requests. Both are returned, email first - the
  // caller matches whichever one an existing account already uses.
  const emails = [...new Set(
    [payload.email, payload.preferred_username]
      .filter((v) => typeof v === 'string' && v.includes('@'))
      .map((v) => v.toLowerCase()),
  )];
  if (!emails.length) {
    throw new Error('token carries no email or preferred_username claim');
  }

  if (requireMfa) {
    if (!Array.isArray(payload.amr)) {
      const err = new Error(
        'Multi-factor authentication is required, but the Microsoft sign-in token carries no "amr" claim. ' +
        'An administrator must add "amr" as an ID-token optional claim on the app registration.',
      );
      err.code = 'ENTRA_MFA_REQUIRED';
      throw err;
    }
    if (!payload.amr.includes('mfa')) {
      const err = new Error(
        'Multi-factor authentication is required. Sign in again and complete MFA with your Microsoft account.',
      );
      err.code = 'ENTRA_MFA_REQUIRED';
      throw err;
    }
  }

  return { oid: payload.oid, emails, name: typeof payload.name === 'string' ? payload.name : '', payload };
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
  const { deactivated_at, ...user } = await db.prepare(
    'SELECT id, email, name, role, auth_provider, avatar_url, plan_id, email_alerts, must_change_password, deactivated_at FROM users WHERE id = ?',
  ).get(row.created_by) || {};
  if (!user.id) return res.status(401).json({ error: 'Service Principal registrant not found' });
  // Ref 5/8: the SP's credential lives in Entra, but its AUTHORITY here is borrowed
  // from created_by - req.user becomes that admin and resolveTenancy grants their
  // workspace role. A deactivated registrant would otherwise keep lending a live
  // workspace role to an external caller, so this fails closed exactly like a
  // DELETED registrant already does (the line above). Operational consequence
  // (documented in docs/sso-scim-integration.md): offboarding the admin who
  // registered an SP stops that integration until it is re-registered under an
  // active admin (POST /api/admin/entra-service-principals).
  if (deactivated_at) return res.status(401).json({ error: 'Service Principal registrant account is deactivated' });

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
  verifyEntraIdToken, // Ref 5: SSO login id_token validation (routes/auth.js POST /microsoft)
  entraConfigured,
};
