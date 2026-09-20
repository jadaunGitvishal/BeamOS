# Entra ID Service Principal Authentication (OAuth 2.0 Client Credentials)

BeamOS's machine-to-machine API authentication, documented as evidence for
Ref 9. Written the same way as [docs/rbac.md](rbac.md) (Ref 5): what's
actually built and proven, cited against real code and real test runs, with
honest gaps called out rather than glossed over.

This is a **third**, distinct Microsoft-integration surface in this
codebase — worth naming precisely so it isn't confused with the other two:

| Surface | What it does | Entra app registration used |
|---|---|---|
| Microsoft SSO login (`POST /api/auth/microsoft`, [`server/routes/auth.js`](../server/routes/auth.js)) | A **human** signs in with their Microsoft account | The login app registration (pre-existing, unrelated to this doc) |
| Graph email sending ([`server/services/email.js`](../server/services/email.js)) | BeamOS acts as a **client**, acquiring its own token via `@azure/msal-node`'s client-credentials flow to call Microsoft Graph and send mail | `GRAPH_TENANT_ID`/`GRAPH_CLIENT_ID`/`GRAPH_CLIENT_SECRET` — a separate registration |
| **This doc: Entra Service Principal API auth** | An **external application** (a daemon, an ERP integration, a script — no human involved) authenticates itself to BeamOS's own API using its own Entra-issued access token | A **new, separate** registration — see [Setup](#setup-the-entra-id-app-registration) below |

None of these three share an app registration, and this doc's feature does
not touch or depend on either of the other two. It also does **not** close
the ["no Azure AD / Entra ID group-to-role mapping" gap](rbac.md#known-gap-no-azure-ad--entra-id-group-to-role-mapping)
documented in `docs/rbac.md` — that's about mapping a *human's* Entra group
memberships to a BeamOS role, which remains unbuilt. This is unrelated:
machine-to-machine access for a non-human caller.

## Why `jose`, not `@azure/msal-node` or `passport-azure-ad` — the research

Before writing any validation code, three options were checked against real
sources, not assumed:

- **`@azure/msal-node`** (already a dependency here, used by `services/email.js`)
  is a *client* library — built for *acquiring* tokens to call someone else's
  API. It has no token-verification/JWKS API at all. Confirmed both from
  Microsoft's own docs and from this codebase's own existing usage: `email.js`
  uses it to *get* a token to call Graph, the opposite direction from what a
  resource server needs.
- **`passport-azure-ad`** — Microsoft's own older sample
  ([`ms-identity-javascript-tutorial`](https://github.com/Azure-Samples/ms-identity-javascript-tutorial/blob/main/3-Authorization-II/1-call-api/README.md))
  uses this for exactly this kind of validation. But per its own npm page and
  [an open `microsoft-identity-web` issue](https://github.com/AzureAD/microsoft-identity-web/issues/2847),
  it's **deprecated and unmaintained** — no releases in over a year, no
  security fixes. Ruled out for new security-sensitive code.
- **`jose`** ([panva/jose](https://github.com/panva/jose)) — actively
  maintained, zero runtime dependencies, and safe by construction against the
  exact vulnerability class this feature has to avoid. From its own
  [`JWTVerifyOptions` docs](https://github.com/panva/jose/blob/main/docs/jwt/verify/interfaces/JWTVerifyOptions.md):
  the `algorithms` option "*Defaults to all algorithms applicable to the key
  or secret. **Unsecured JWTs (`alg: "none"`) are never accepted.***" —
  unconditional, not dependent on a developer remembering to pass an
  allowlist. `createRemoteJWKSet` gives native JWKS fetch/cache/auto-refresh
  (rate-limited via a cooldown on an unmatched `kid`), so no separate
  `jwks-rsa` package is needed either.

This was verified empirically, not just trusted from documentation — see
[Real evidence](#real-evidence-automated-test-coverage) below, specifically
the two tests that construct an actual `alg:"none"` token and an actual
RS256→HS256 algorithm-confusion attack token and confirm `jose` rejects both.

## How it works

Three front doors now exist to the public API surface
([`server/config/api-surface.js`](../server/config/api-surface.js)'s
`PUBLIC_ROUTERS`), all converging on the identical enforcement seam:

```
Authorization: Bearer st_...          -> apiTokenAuth      (existing, unchanged)
Authorization: Bearer <Entra JWT>     -> entraTokenAuth     (new, this doc)
Authorization: Bearer <our own JWT>   -> requireAuth        (existing, unchanged)
```

routed by [`bearerAuth`](../server/middleware/apiToken.js) (unchanged in
spirit, one new branch):

```js
function bearerAuth(req, res, next) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ' + TOKEN_PREFIX)) return apiTokenAuth(req, res, next);
  const raw = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (looksLikeEntraToken(raw)) return entraTokenAuth(req, res, next);
  return requireAuth(req, res, next);
}
```

`looksLikeEntraToken` ([`server/middleware/entraToken.js`](../server/middleware/entraToken.js))
is a **structural** check, not "count the dots" or check length: it decodes
the token's (unverified) payload and checks whether its `iss` claim's host is
`login.microsoftonline.com` or `sts.windows.net`. This is safe precisely
*because* it's not a trust decision — `jose`'s own `decodeJwt()` is documented
as unsafe for trust purposes, which is fine here since it only decides which
validation path to route into. Our own session JWT is HS256 and carries no
`iss` claim at all ([`server/middleware/auth.js`](../server/middleware/auth.js)'s
`generateToken`), so it can never be routed down the Entra path by mistake. A
forged/malformed token routed into the Entra path simply fails real
verification (unknown `kid` / bad signature / wrong issuer) — same outcome as
routing it anywhere else.

### The actual validation (`verifyEntraAccessToken`)

Every check below is enforced together in one `jose.jwtVerify()` call plus
one extra claim check, per the [access-tokens](https://learn.microsoft.com/en-us/entra/identity-platform/access-tokens)
and [claims-validation](https://learn.microsoft.com/en-us/entra/identity-platform/claims-validation)
Microsoft docs researched before writing this:

| Check | How | Why |
|---|---|---|
| Signature | `jose.createRemoteJWKSet` against `https://login.microsoftonline.com/{ENTRA_TENANT_ID}/discovery/v2.0/keys` | Proves Entra actually issued it |
| Issuer | Exact match against `https://login.microsoftonline.com/{ENTRA_TENANT_ID}/v2.0` | Pins to *our* configured tenant, not "any Entra tenant" |
| Audience | Exact match against `ENTRA_API_CLIENT_ID` (this app registration's own client ID) | The confused-deputy guard — a token minted for a *different* API must not work here |
| Algorithm | `algorithms: ['RS256']` explicit, **and** `jose` never accepts `alg:"none"` regardless | Defense in depth against algorithm-confusion / unsecured-JWT attacks |
| Expiry/clock skew | `clockTolerance: 30` (seconds) on `exp`/`nbf` | Standard JWT hygiene |
| `idtyp === 'app'` | Explicit claim check after `jwtVerify` succeeds | Entra's own documented discriminator for "this is a genuine app-only/client-credentials token," not a delegated user token that happens to carry a matching `azp`. **Optional Entra claim** — see [Setup](#setup-the-entra-id-app-registration): its *absence* is treated as a failure, not "unknown, allow" |
| Client identity | `azp` claim (v2.0 tokens; `appid` accepted as a v1.0 fallback) | Which Service Principal is calling — looked up against `entra_service_principals` |

### Data model

```sql
CREATE TABLE entra_service_principals (
    id, client_id UNIQUE, name, workspace_id, scope,
    created_by, created_at, last_used_at, revoked_at
);
```

Deliberately mirrors `api_tokens`' shape
([`server/db/schema.sql`](../server/db/schema.sql)) — same `workspace_id` +
`scope` columns, same `revoked_at` soft-delete, same `last_used_at`
throttled-write pattern. `scope` uses the **exact same vocabulary**
(`read`/`write`/`full`/`agency`/`billing:read`), imported from
[`server/routes/tokens.js`](../server/routes/tokens.js)'s exported `SCOPES`
array rather than a second, driftable copy.

No secret/hash column: there's nothing to store. Entra ID itself holds the
credential (the Service Principal's client secret or certificate); it proves
possession by minting a signed JWT we verify against Entra's own JWKS.

`created_by` plays the exact role `api_tokens.user_id` already plays: a
request authenticated this way **acts as that real, registered admin user**
(role forced to `'user'`, same as a token), so `resolveTenancy`'s
workspace-role resolution works completely unmodified — the admin's real
workspace role sets the ceiling, and `req.tokenScope` caps it further, same
ladder a token uses.

### The reuse seam (the point of this design)

`entraTokenAuth` ([`server/middleware/entraToken.js`](../server/middleware/entraToken.js))
resolves a validated token down to the *identical* shape `apiTokenAuth`
produces:

```js
req.user = { ...adminUser, role: 'user' };
req.jwtWorkspaceId = row.workspace_id;
req.viaToken = true;
req.tokenScope = row.scope;
```

`tokenScopeGate` / `requireScope` / `agencyGate` / `requireBillingRead`
([`server/middleware/apiToken.js`](../server/middleware/apiToken.js)) are
**not modified at all** — they only ever read `req.viaToken` +
`req.tokenScope`, so they enforce identically whether that shape came from an
`st_` token lookup or an Entra Service Principal lookup. This is proven, not
just asserted — see the "scope reuse" tests below, which call these exact
functions.

## Setup: the Entra ID app registration

This needs its **own** app registration, separate from the SSO-login one and
separate from the Graph-email one (see the table at the top of this doc for
why). Steps, in the Entra admin center:

1. **App registrations → New registration.** Name it something like
   `BeamOS API (machine-to-machine)`. Single tenant
   ("Accounts in this organizational directory only") — this feature is
   designed for a single, admin-controlled tenant, not multi-tenant
   federation (see [Known gaps](#known-gaps-honest-list) if that's ever
   needed).
2. **Expose an API** (or just note the Application (client) ID from the
   Overview page — that alone is what `ENTRA_API_CLIENT_ID` needs). No scopes
   need to be defined here since this is client-credentials/app-only, not
   delegated permissions.
3. **App roles** (optional but recommended if you want Entra-side
   authorization in addition to BeamOS's own scope check): define an app role
   and assign it to the calling Service Principal. Not required for this
   feature to work — BeamOS's own `entra_service_principals` table is the
   actual authorization decision — but doesn't hurt as defense in depth.
4. **Manifest → set `requestedAccessTokenVersion` to `2`.** This is what
   makes Entra issue v2.0-format tokens (`iss` ending in `/v2.0`, client
   identity in `azp`) instead of v1.0. Doing this here, once, at
   configuration time is what eliminates the `azp`-vs-`appid` ambiguity
   Microsoft's docs describe for multitenant apps — this app only ever needs
   to check `azp`.
5. **Manifest → `optionalClaims.accessToken` → add the `idtyp` claim.**
   This is required for the `idtyp === 'app'` check above to ever see the
   claim at all — it's optional in Entra's schema, off by default. Example
   manifest fragment:
   ```json
   "optionalClaims": {
     "accessToken": [
       { "name": "idtyp", "essential": false }
     ]
   }
   ```
6. For each external application that should call BeamOS's API: **create its
   own Service Principal** (its own app registration, or an existing one from
   a partner's tenant if using cross-tenant app-to-app auth — out of scope
   here), give it a client secret or certificate, and note its **Application
   (client) ID**. That's the `client_id` a BeamOS platform admin registers in
   the admin UI below.

### Environment variables

```bash
ENTRA_TENANT_ID=<your Entra tenant GUID>
ENTRA_API_CLIENT_ID=<the Application (client) ID from step 2 above>
```

Both empty (the default) means Entra auth is **entirely disabled** —
`entraTokenAuth` refuses every request with a clear "not configured" 401
rather than attempting to validate against an unset tenant/audience. See
[`server/config.js`](../server/config.js).

### Registering a Service Principal in BeamOS

Platform Admin console → **Entra ID Service Principals** section
([`frontend/js/views/admin.js`](../frontend/js/views/admin.js)) → enter the
calling application's `client_id` (from step 6 above), a name, the target
workspace ID, and a scope. This is deliberately **admin-only** (unlike
`api_tokens`, which is self-service per workspace member) — deciding *which
external application* may call the API on a workspace's behalf is an
administrative trust decision. Revoking works the same way as revoking an
`api_tokens` row: immediate, soft-deleted for the audit trail.

## Real evidence: automated test coverage

Two test files, 27 tests, **0 failing**:

- [`server/test/entra-token.test.js`](../server/test/entra-token.test.js) —
  22 unit tests calling the real, unmodified `verifyEntraAccessToken()`
  against a real self-signed RS256 token (a real RSA keypair generated with
  `jose.generateKeyPair`, a real local JWKS built with
  `jose.createLocalJWKSet`), matching Entra's exact documented claim shape.
- [`server/test/entra-token-integration.test.js`](../server/test/entra-token-integration.test.js) —
  5 tests that make **real HTTP requests** into a real Express app mounting
  the real, unmodified `bearerAuth` → `entraTokenAuth` → `resolveTenancy` →
  `tokenScopeGate` chain, with only the network fetch to Entra's JWKS URL
  intercepted (everything else — `config.entraTenantId`-driven URL
  construction, the DB lookup, workspace-role resolution — is the real
  production code path).

Real terminal transcript (`node --test`, both files):

```
# Subtest: verifyEntraAccessToken: a realistic, correctly-shaped Entra app-only token is accepted, azp extracted
ok 1 - verifyEntraAccessToken: a realistic, correctly-shaped Entra app-only token is accepted, azp extracted
# Subtest: verifyEntraAccessToken: falls back to appid when azp is absent (v1.0-token shape)
ok 2 - verifyEntraAccessToken: falls back to appid when azp is absent (v1.0-token shape)
# Subtest: verifyEntraAccessToken: wrong issuer is rejected
ok 3 - verifyEntraAccessToken: wrong issuer is rejected
# Subtest: verifyEntraAccessToken: wrong audience is rejected (confused-deputy guard)
ok 4 - verifyEntraAccessToken: wrong audience is rejected (confused-deputy guard)
# Subtest: verifyEntraAccessToken: expired token is rejected
ok 5 - verifyEntraAccessToken: expired token is rejected
# Subtest: verifyEntraAccessToken: idtyp="user" (delegated token) is rejected even with a matching azp
ok 6 - verifyEntraAccessToken: idtyp="user" (delegated token) is rejected even with a matching azp
# Subtest: verifyEntraAccessToken: missing idtyp entirely is rejected (fails closed, not "unknown, allow")
ok 7 - verifyEntraAccessToken: missing idtyp entirely is rejected (fails closed, not "unknown, allow")
# Subtest: verifyEntraAccessToken: missing azp/appid is rejected
ok 8 - verifyEntraAccessToken: missing azp/appid is rejected
# Subtest: verifyEntraAccessToken: alg:"none" (unsecured JWT) is rejected
ok 9 - verifyEntraAccessToken: alg:"none" (unsecured JWT) is rejected
# Subtest: verifyEntraAccessToken: RS256->HS256 algorithm-confusion attack is rejected (public key used as an HMAC secret)
ok 10 - verifyEntraAccessToken: RS256->HS256 algorithm-confusion attack is rejected (public key used as an HMAC secret)
# Subtest: verifyEntraAccessToken: HS256 confusion is rejected even WITHOUT an explicit algorithms allowlist (key-type binding alone stops it)
ok 11 - verifyEntraAccessToken: HS256 confusion is rejected even WITHOUT an explicit algorithms allowlist (key-type binding alone stops it)
# Subtest: verifyEntraAccessToken: unknown kid (no matching key in the JWKS) is rejected
ok 12 - verifyEntraAccessToken: unknown kid (no matching key in the JWKS) is rejected
# Subtest: looksLikeEntraToken: true for a token whose iss is an Entra authority host
ok 13 - looksLikeEntraToken: true for a token whose iss is an Entra authority host
# Subtest: looksLikeEntraToken: false for our own session JWT shape (HS256, no iss claim at all)
ok 14 - looksLikeEntraToken: false for our own session JWT shape (HS256, no iss claim at all)
# Subtest: looksLikeEntraToken: false for garbage / non-JWT input
ok 15 - looksLikeEntraToken: false for garbage / non-JWT input
# Subtest: looksLikeEntraToken: false for a well-formed JWT with an unrelated issuer
ok 16 - looksLikeEntraToken: false for a well-formed JWT with an unrelated issuer
# Subtest: scope reuse: a "read"-scope Entra request may GET but not POST (same as a read st_ token)
ok 17 - scope reuse: a "read"-scope Entra request may GET but not POST (same as a read st_ token)
# Subtest: scope reuse: a "write"-scope Entra request may POST but requireScope("full") still blocks it
ok 18 - scope reuse: a "write"-scope Entra request may POST but requireScope("full") still blocks it
# Subtest: scope reuse: a "full"-scope Entra request passes requireScope("full")
ok 19 - scope reuse: a "full"-scope Entra request passes requireScope("full")
# Subtest: scope reuse: an "agency"-scope Entra request is rejected by the read/write/full ladder (off-ladder, same as an agency st_ token)
ok 20 - scope reuse: an "agency"-scope Entra request is rejected by the read/write/full ladder (off-ladder, same as an agency st_ token)
# Subtest: scope reuse: only an "agency"-scope Entra request passes agencyGate
ok 21 - scope reuse: only an "agency"-scope Entra request passes agencyGate
# Subtest: scope reuse: only a "billing:read"-scope Entra request passes requireBillingRead (as a token, no admin session)
ok 22 - scope reuse: only a "billing:read"-scope Entra request passes requireBillingRead (as a token, no admin session)
1..22
# tests 22
# pass 22
# fail 0

# Subtest: integration: a real, registered Entra Service Principal token authenticates through the REAL bearerAuth/resolveTenancy/tokenScopeGate chain
ok 1 - integration: a real, registered Entra Service Principal token authenticates through the REAL bearerAuth/resolveTenancy/tokenScopeGate chain
# Subtest: integration: tokenScopeGate genuinely enforces the registered scope over real HTTP (write cannot reach a "full"-only route pattern via method)
ok 2 - integration: tokenScopeGate genuinely enforces the registered scope over real HTTP (write cannot reach a "full"-only route pattern via method)
# Subtest: integration: a revoked Service Principal registration is refused (403) over real HTTP
ok 3 - integration: a revoked Service Principal registration is refused (403) over real HTTP
# Subtest: integration: an unregistered client_id (valid Entra token, never registered) is refused (403) over real HTTP
ok 4 - integration: an unregistered client_id (valid Entra token, never registered) is refused (403) over real HTTP
# Subtest: integration: an st_ token header still routes to apiTokenAuth, not entraTokenAuth (no regression to the existing front door)
ok 5 - integration: an st_ token header still routes to apiTokenAuth, not entraTokenAuth (no regression to the existing front door)
1..5
# tests 5
# pass 5
# fail 0
```

### Live verification against the real dev server

- The real dev server (`npm run dev`, real local MySQL) restarted cleanly
  under its existing `node --watch` auto-restart with the new
  `entra_service_principals` table added to `server/db/schema.sql` +
  `server/lib/schema-check.js`'s migration list — no `[schema-check] FATAL`,
  no crash.
- Confirmed live, by direct query against the real running dev DB:
  ```
  SHOW COLUMNS FROM entra_service_principals;
  -> id, client_id, name, workspace_id, scope, created_by, created_at, last_used_at, revoked_at
  ```
- Regression check: ran every directly-relevant existing test file
  (`admin-users.test.js`, `api.test.js` [the partition-firewall test that
  asserts against `config/api-surface.js`], `apitoken-unit.test.js`,
  `billing-token-mint.test.js`) both with and without this change (via
  `git stash`/`git stash pop`), same technique used for prior Refs in this
  codebase's history. Result: **identical 10 pre-existing failures** in
  `admin-users.test.js` in both runs (a pre-existing test-harness/DB-fixture
  issue — `Cannot read properties of undefined (reading 'prepare')` / `no
  such table: devices` — unrelated to this feature, confirmed unaffected by
  this change). `api.test.js`'s partition-firewall test, which would catch
  any accidental mounting drift, passes clean.

## What this does and doesn't prove

**Proven, with real evidence above:**
- The validation logic itself (signature, issuer, audience, algorithm,
  expiry, `idtyp`) is correct, including against real, deliberately-forged
  attack tokens (`alg:"none"`, RS256→HS256 confusion) — not just trusted from
  `jose`'s documentation.
- The full Express request path — routing, DB lookup, workspace-role
  resolution, scope enforcement — is wired correctly end-to-end over real
  HTTP.
- Scope enforcement for a validated Service Principal is **provably
  identical** to an equivalent `st_` token's, because both paths call the
  exact same, unmodified gate functions.
- The schema migration applies cleanly to a real, already-running MySQL dev
  database with zero disruption to existing data or the existing test suite.

**Cannot be proven without a real Entra tenant:**
- That a genuine Entra ID tenant issues tokens shaped exactly the way this
  code (and Microsoft's own documentation) says it will, for a real,
  real-secret-holding Service Principal.
- That `createRemoteJWKSet`'s real network fetch, caching, and key-rotation
  behavior against Entra's *actual* JWKS endpoint works as documented (the
  integration test intercepts that one network call rather than hitting it
  for real).
- That the Entra portal setup steps above are pixel-accurate to the current
  admin center UI (they're written from Microsoft's current documentation,
  not from clicking through a real tenant).

This is the same category of gap as a few other items in this codebase that
need a real external environment to fully close — not a gap in the code
itself, and not glossed over here.

## Known gaps (honest list)

- **Single-tenant only.** `ENTRA_TENANT_ID` is one server-wide value; every
  registered `client_id` is implicitly scoped to that one tenant. If a
  genuinely multi-tenant model is ever needed (Service Principals from
  *different* Entra tenants, each representing a different customer),
  that's new work: a `tenant_id` column on `entra_service_principals`,
  switching to Entra's tenant-independent "common"/"organizations" endpoint
  metadata, and the signing-key-issuer validation Microsoft's docs describe
  for that case specifically (each JWK's own `issuer` property must then be
  checked against the token's `tid`, not just a single fixed issuer string).
- **No per-target (agency-style) restriction for Entra-authenticated
  callers.** `api_tokens` has `api_token_targets` for capability-restricted
  `agency` tokens (an allowlist of specific playlists). `entra_service_principals`
  has no equivalent yet — an `agency`-scoped Service Principal registration
  would need the same target-allowlist table and the same
  `router.param('playlistId')` enforcement `routes/agency.js` already uses
  for `api_tokens`, wired to the new table, if that combination is ever
  needed.
- **No UI workspace picker.** The admin registration form takes a raw
  workspace ID (text input), not a dropdown — a smaller polish gap, not a
  security one; the backend validates the ID references a real workspace
  either way.
