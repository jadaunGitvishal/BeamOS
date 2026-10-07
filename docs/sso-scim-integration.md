# SSO (Ref 5) and SCIM Provisioning (Ref 8) with Microsoft Entra ID

Evidence for Ref 5 (SSO integration) and Ref 8 (automated provisioning /
SCIM). Written the same way as [docs/entra-auth.md](entra-auth.md) and
[docs/bi-integration.md](bi-integration.md): what is actually built, cited
against real code and real test runs, with honest gaps called out.

The two Refs are one connected unit. Ref 5 makes the human "Sign in with
Microsoft" login trust only **one** Entra tenant, cryptographically, with
optional MFA enforcement. Ref 8 lets that tenant's provisioning service
create and **deactivate** BeamOS accounts, and deactivation takes effect on
the user's **very next request**, not at their next login.

| Stage | Commit | What it added |
|---|---|---|
| 1 — Ref 5 | `786dab9` | OIDC `id_token` validation, tenant restriction and MFA enforcement on `POST /api/auth/microsoft` |
| 2 — prerequisite | `0040311` | `users.deactivated_at` and per-request revocation on every path that trusts a user's identity |
| 3 — Ref 8 | `9dbdc09` | SCIM 2.0 endpoint at `/scim/v2`, `scim_tokens`, platform-admin token API |
| 4 | this doc | Setup, operations and evidence |
| 5 — Ref 7 | (uncommitted) | Entra app roles mapped to org/workspace roles at verified sign-in (Part 4) |

## The four Microsoft-integration surfaces

This feature adds a fourth surface to the three that
[docs/entra-auth.md](entra-auth.md#entra-id-service-principal-authentication-oauth-20-client-credentials)
already lists:

| Surface | Direction | Entra object | Config |
|---|---|---|---|
| **SSO login (Ref 5, this doc)** | A human signs in | The login **app registration** (SPA) | `MICROSOFT_CLIENT_ID`, `SSO_TENANT_ID`, `ENTRA_REQUIRE_MFA` |
| **SCIM provisioning (Ref 8, this doc)** | Entra pushes user create/update/disable **to** BeamOS | A **non-gallery enterprise app** with Provisioning enabled | `scim_` token (DB), `SCIM_DEFAULT_ORG_ROLE` |
| Service Principal API auth (Ref 9) | An external app calls BeamOS's API | Its own app registration | `ENTRA_TENANT_ID`, `ENTRA_API_CLIENT_ID` |
| Graph email | BeamOS calls Graph to send mail | Its own app registration | `GRAPH_*` |

Ref 5 and Ref 9 each have their **own** tenant setting, `SSO_TENANT_ID` and
`ENTRA_TENANT_ID`, and `SSO_TENANT_ID` never falls back to `ENTRA_TENANT_ID`.
They may name the same tenant, but each feature is opted into separately. If
one variable drove both, a deployment that set `ENTRA_TENANT_ID` only for Ref 9's
API integrations would find its human Microsoft login switched to
single-tenant, id_token-only mode on upgrade. That would lock out personal and
other-tenant accounts, and any browser still running the old login page. Each
setting is still **one global tenant per deployment**, matching BeamOS's
self-hosted-per-customer model.

---

## Part 1 — Ref 5: tenant-restricted, MFA-enforced Microsoft login

### Behaviour

[`server/routes/auth.js`](../server/routes/auth.js) `POST /microsoft` now
has two identity paths, selected by `SSO_TENANT_ID`:

| `SSO_TENANT_ID` | Client must send | How identity is established | Tenant restricted? | MFA check? |
|---|---|---|---|---|
| **unset** (default, **regardless of `ENTRA_TENANT_ID`**) | `access_token` | Graph `GET /v1.0/me` with that token. The **pre-Ref-5 flow, byte-for-byte unchanged** | No: any Microsoft account (authority `common`) | No |
| **set** | `id_token` | Validated locally with `jose` (no Graph call). See the checks below | Yes: only that tenant | If `ENTRA_REQUIRE_MFA=true` |

With `SSO_TENANT_ID` set, a request carrying only `access_token` gets
`400 "…requires an OpenID Connect id_token (an access_token alone is not
accepted)…"`. A Graph access token is audience-bound to Graph, not to
BeamOS, so it cannot be validated here. That was the gap Ref 5 closes.

Everything after identity resolution is **shared and unchanged**: user
lookup/creation, the provider-link rules, `ensureDefaultOrgForUser`, session
JWT issuance and signup emails.

### The checks (`verifyEntraIdToken`, [`server/middleware/entraToken.js`](../server/middleware/entraToken.js))

`verifyEntraIdToken` sits next to Ref 9's `verifyEntraAccessToken` and
reuses its trust-anchor builders, `getJwks()` and `entraIssuer()`, which are
cached per tenant. For SSO they point at `SSO_TENANT_ID`
(`https://login.microsoftonline.com/{SSO_TENANT_ID}/discovery/v2.0/keys`). If
`SSO_TENANT_ID` is empty, validation fails closed instead of building a URL
for an empty tenant.

| Check | Value | Why |
|---|---|---|
| Signature | Tenant JWKS, `algorithms: ['RS256']` | Entra issued it; `jose` also never accepts `alg:"none"` |
| `iss` | Exactly `https://login.microsoftonline.com/{SSO_TENANT_ID}/v2.0` | Pins the tenant |
| `tid` | `=== SSO_TENANT_ID` | Defense in depth. Microsoft's [ID token claims reference](https://learn.microsoft.com/entra/identity-platform/id-token-claims-reference) names `tid`/`iss` as the tenant-restriction signal |
| `aud` | `=== MICROSOFT_CLIENT_ID` | "In `id_tokens`, the audience is your app's Application ID … The token should be rejected if it fails to match". If `MICROSOFT_CLIENT_ID` is empty the check **fails closed** rather than skipping the audience check |
| `exp`/`nbf` | 30 s tolerance | Standard |
| `idtyp` | Must **not** be `app` | An app-only token minted for the same client ID is never a user sign-in |
| `oid` | Required | Immutable user object ID, the same value Graph returns as `id`, so `users.provider_id` keeps its meaning |
| Email | `email`, else `preferred_username` | The login matches whichever of the two an existing account already uses (the old flow keyed on Graph's `mail` ‖ `userPrincipalName`, which map to these claims) |
| **MFA** (`ENTRA_REQUIRE_MFA=true`) | `amr` must contain `"mfa"` | See below |

#### Why `amr`, not `acr`

- Microsoft's [ID token claims reference](https://learn.microsoft.com/entra/identity-platform/id-token-claims-reference)
  documents **no `acr` claim** for v2.0 id_tokens.
- The [optional claims reference](https://learn.microsoft.com/entra/identity-platform/optional-claims-reference)
  lists `amr` under **"v2.0-specific optional claims"**: *"always included in
  v1.0 tokens, but not included in v2.0 tokens unless requested."*
- The same page states: *"The `multipleauthn` and `mfa` values are emitted
  only when the user has completed MFA."* Examples: Authenticator push emits
  `rsa, ngcmfa, mfa`, SMS emits `sms, mfa`, and password alone emits `pwd`.

So the app registration **must** request `amr` as an ID-token optional claim
(setup step 4). Without it, every login fails closed, with an error that
names that exact misconfiguration:

- no `amr` claim at all → `401` *"…carries no "amr" claim. An administrator
  must add "amr" as an ID-token optional claim on the app registration."*
- `amr` present but no `mfa` → `401` *"Multi-factor authentication is
  required. Sign in again and complete MFA…"*

BeamOS does not *trigger* MFA. It **verifies** that Entra performed it. Make
Entra require it with a Conditional Access policy targeting the login app
(or security defaults / per-user MFA). `ENTRA_REQUIRE_MFA` is the server-side
guarantee that a policy gap can't silently let a password-only session
through.

#### Frontend

[`frontend/js/views/login.js`](../frontend/js/views/login.js) already used
MSAL.js `loginPopup`, which returns an `idToken`. It now sends
`{ access_token, id_token }`. `GET /api/auth/config` reports
`microsoftTenantId = SSO_TENANT_ID` when that is set, so MSAL's authority is
the tenant itself and users from other tenants are stopped at Microsoft's
sign-in page as well as by the server. When unset, it is unchanged
(`MICROSOFT_TENANT_ID`, default `common`).

### SSO-only mode (per organization)

An organization can require Microsoft sign-in for its members, with no
separate local login. The setting is `organizations.sso_only`
(`TINYINT(1) NOT NULL DEFAULT 0`). It is added to existing databases at boot
by the [`lib/schema-check.js`](../server/lib/schema-check.js) repair. With the
default `0`, every login path behaves exactly as before.

**Enabling.** An org owner or org admin (or a platform admin) opens
*Settings → Authentication* and turns on *Require Microsoft sign-in (SSO
only)*, or calls the API:

```bash
curl -s https://signage.example.com/api/organizations/<org id>/auth-policy \
  -H "Authorization: Bearer $SESSION_JWT"
# -> {"organization_id":"…","sso_only":false,"sso_tenant_configured":true,"caller_can_enable":true}

curl -s -X PATCH https://signage.example.com/api/organizations/<org id>/auth-policy \
  -H "Authorization: Bearer $SESSION_JWT" -H "content-type: application/json" \
  -d '{"sso_only": true}'
```

The endpoint uses the same permission check as `token-policy` and regions.
Every actual change is audited as `org_sso_only_changed` (`sso_only: false ->
true`). The response never includes the tenant id.

| Rule | Result |
|---|---|
| `SSO_TENANT_ID` not set on the server | Enabling returns `400`. Without it, the Microsoft login is not tenant-restricted, so there's nothing safe to require. The settings toggle is disabled with an explanation |
| Caller's own account does not sign in with Microsoft (`auth_provider` is not `microsoft`) | Enabling returns `403` "Sign in with Microsoft before enabling SSO-only, so you don't lock yourself out." Platform admins are exempt |
| Disabling | Always allowed for anyone who passes the org-admin check |

**What members see.** A member is SSO-only if they belong to **any**
organization with `sso_only = 1`, either directly (`organization_members`) or
through one of its workspaces (`workspace_members`). The strictest setting
wins. The check is [`lib/sso-policy.js`](../server/lib/sso-policy.js)
`isSsoOnlyUser()`.

- **Password login** (`POST /api/auth/login`): a correct password returns
  `403 {"code":"SSO_REQUIRED","error":"Your organization requires Microsoft sign-in."}`.
  The check runs after the password and deactivation checks, so an unknown
  email or wrong password still gets the generic `401` (no account
  enumeration). It runs before the TOTP step, so a blocked user never gets an
  `mfa_token`. The login page shows the message and highlights the *Sign in
  with Microsoft* button.
- **Google login** (`POST /api/auth/google`): an existing SSO-only member gets
  the same `403 SSO_REQUIRED` before any session is issued. Signing up a new
  user with Google is unchanged.
- **TOTP second step** (`POST /api/auth/totp/verify`) applies the same check.
  A TOTP user who got an `mfa_token` just before the org was switched to
  SSO-only gets `403 SSO_REQUIRED` with no session. The check runs before the
  code is verified, so the refused attempt uses up no TOTP step or recovery code.
- Each refusal is audited as `auth:login_failed` with reason `SSO required`.
- The login page still shows the password form (`GET /api/auth/config`
  keeps `localEnabled: true`), because it can't know the user's organization
  until the email is entered. The server enforces the rule.

**Linking existing password accounts.** Normally, a Microsoft sign-in for an
email that already has a password account returns `409` "log in with your
password". For an SSO-only member that would be a dead end. So when
`SSO_TENANT_ID` is set (the id_token was verified against your tenant) **and**
the user is SSO-only, the account is linked instead. `auth_provider` becomes
`microsoft` and `provider_id` becomes the token's `oid`. The rest of the row
(memberships, history) is kept. It is audited as `account_linked_microsoft`.
In every other case the `409` stays. After linking, the old password no longer
works, because password login only accepts `auth_provider = 'local'` accounts.

**Exemptions and what isn't affected.**

- **Platform admins** (`superadmin`, `platform_admin`) are always exempt.
  They are the recovery path if the tenant is misconfigured or Entra is
  unavailable.
- **Field technicians' phone OTP login** ([`routes/field-auth.js`](../server/routes/field-auth.js))
  is not subject to the SSO-only check, but it is no longer a way around it.
  The route is a dev/test placeholder that is **off by default**
  (`FIELD_OTP_ENABLED`, not mounted unless set) and **impossible in
  production** (the server refuses to start with it set under
  `NODE_ENV=production`) until a real SMS OTP ships (Stage 2). It only ever
  issues a session to **technician-only** accounts: `users.role = 'user'`,
  only `field_technician` org memberships, no workspace membership, no TOTP.
  Everyone else, including an org admin or owner of an SSO-only org who has a
  phone on file, gets the same generic `401` as a wrong code. Consequence:
  **technicians in an SSO-only org have no production sign-in until Stage 2**,
  because password login refuses them (`SSO_REQUIRED`) and the OTP route is
  off in production. (Earlier versions of this note said the OTP login was
  "unchanged"; that was the bypass fixed here.)
- **Existing sessions** are not logged out. They expire naturally (session
  JWT lifetime, currently 7 days). To cut someone off immediately, deactivate
  the account (Part 2).
- **API tokens, SCIM tokens, Entra Service Principals and device auth** are
  unaffected.

**Not verified without a real tenant.** The tests use self-signed id_tokens
and a faked JWKS (see *What this does and doesn't prove*). An end-to-end run
against a real Entra tenant has not been done: enabling the mode while
signed in through real Microsoft SSO, checking that a member's password login
is refused, and checking that an existing password account links on its first
real Microsoft sign-in.

---

## Part 2 — Deactivation: instant, per-request revocation

`users.deactivated_at BIGINT NULL` (NULL = active),
[`server/db/schema.sql`](../server/db/schema.sql) plus a
[`lib/schema-check.js`](../server/lib/schema-check.js) ALTER-if-missing
repair, so existing databases pick it up at boot.

It is read **on every request**, never baked into a token.
[`lib/user-deactivation.js`](../server/lib/user-deactivation.js)
`setUserDeactivated()` is the single write path (idempotent; audited into the
Ref 17 hash chain as `user:deactivated` / `user:reactivated`).

| Path that trusts a user's identity | Behaviour when deactivated | Where |
|---|---|---|
| Session JWT on any `/api` router | `401 account_deactivated` on the **next** request | `requireAuth` ([`middleware/auth.js`](../server/middleware/auth.js)) |
| `optionalAuth` | Token treated as absent | same |
| `st_` API tokens | `401` | `apiTokenAuth`. A token acts **as its owner** (`req.user` = owner, workspace role from the owner's membership) and was already gated on the owner's `must_change_password` |
| Entra Service Principal (Ref 9) | `401` | `entraTokenAuth`. The SP borrows `created_by`'s workspace role, so a deactivated registrant is treated like a deleted one (which already 401'd) |
| JWT side doors outside `requireAuth` | Refused | `/api/devices/:id/screenshot` ([`server.js`](../server/server.js)), [`routes/public-content.js`](../server/routes/public-content.js), `/dashboard` socket handshake ([`ws/dashboardSocket.js`](../server/ws/dashboardSocket.js)) |
| Already-open dashboard sockets | Disconnected at deactivation time | `disconnectUserSockets()` |
| New logins: password, TOTP verify, Google, Microsoft, field-tech OTP | `403 "This account has been deactivated…"`, **only after** the credential checks out (no enumeration oracle). The Google/Microsoft check runs before the provider-link UPDATE, so a refused login changes nothing | [`routes/auth.js`](../server/routes/auth.js), [`routes/field-auth.js`](../server/routes/field-auth.js) |
| SCIM token itself | **Not** affected by its creator's deactivation | [`middleware/scimAuth.js`](../server/middleware/scimAuth.js). It acts as no user, so an admin leaving doesn't stop provisioning. Revoke the token instead |

> **Operational consequence (Ref 9):** offboarding the admin who registered
> an Entra Service Principal stops that integration until an active admin
> re-registers it (`POST /api/admin/entra-service-principals`).

Deactivation is non-destructive: memberships, content, tokens and history
are untouched, and reactivating restores exactly the prior access,
including still-unexpired sessions.

---

## Part 3 — Ref 8: SCIM 2.0 endpoint

### Front door

`/scim/v2` is mounted directly in [`server.js`](../server/server.js),
**not** through [`config/api-surface.js`](../server/config/api-surface.js).
That file's PUBLIC/JWT-only partition decides which *workspace API* routers
an `st_`/Entra-SP caller acting *as a user* may reach. The SCIM caller is
the IdP: it acts as no user and is bound to an organization, not a
workspace. It is a separate front door with its own auth (the same kind of
decision as Ref 9). The router is mounted before the global
`express.json()` because Entra sends `Content-Type: application/scim+json`
and the router must return RFC 7644-shaped errors for bad JSON.

Auth ([`middleware/scimAuth.js`](../server/middleware/scimAuth.js)):
`Authorization: Bearer scim_…` is SHA-256 hashed with the **same**
`hashToken` `api_tokens` uses, looked up in `scim_tokens`, and refused if
missing or revoked. Only the hash is stored and the plaintext is shown once.
A `scim_` secret is useless on `/api` and `st_`/JWTs are useless on
`/scim/v2` (both tested).

**Each token is bound to one organization** (`scim_tokens.organization_id`).
That org is where created users get their `organization_members` row, and it
is the token's entire world: every lookup is joined through that org's
membership, so a token can neither see nor deactivate anyone outside it.

### Endpoints ([`server/routes/scim.js`](../server/routes/scim.js))

| Endpoint | Behaviour |
|---|---|
| `GET /ServiceProviderConfig` | RFC 7643 §5, with every REQUIRED capability present and honest: `patch` true, `filter` true (`maxResults` 100), `bulk`/`changePassword`/`sort`/`etag` false, `authenticationSchemes: [oauthbearertoken]` |
| `GET /ResourceTypes[/User]` | ListResponse with the `User` resource type (RFC 7643 §6) |
| `GET /Schemas[/{urn}]` | ListResponse (Microsoft: *"Must return a list response"*) with the core User schema, advertising **only stored attributes**: `userName`, `displayName`, `active`, `emails` (read-only) |
| `GET /Users` | `filter` with `eq` joined by `and` (Microsoft: *"Microsoft Entra-only uses the following operators: eq, and"*) on `userName` (case-insensitive), `externalId` (quoted, or unquoted as in Microsoft's own example), `id`, `displayName`, `active`, `emails[type eq "work"].value`. Anything else → `400 invalidFilter`. 1-based `startIndex`/`count` |
| `POST /Users` | `201` + `Location`. `409 uniqueness` if the org already has that `userName` |
| `GET /Users/{id}` | `200` / `404` |
| `PATCH /Users/{id}` | `Add`/`Replace`/`Remove` (case-insensitive), path or path-less. **`active: false` → deactivation (Part 2)** |
| `PUT /Users/{id}` | Replaces `userName`, `displayName` and `externalId` (absent → cleared). `active` is applied if present |
| `DELETE /Users/{id}` | `204`. Soft delete (see below) |
| `/Groups`, `/Bulk`, `/Me` | `501`, SCIM-shaped. Groups are intentionally unsupported |

Every response is `application/scim+json` with RFC 7643/7644 shapes (`schemas`
array, `meta.resourceType`/`created`/`lastModified`/`location`, RFC 7644 §3.12
errors with string `status` and `scimType`). No `null` values are emitted.

### Entra's real request shapes, and where they differ from the RFC

Microsoft's [SCIM compatibility page](https://learn.microsoft.com/entra/identity/app-provisioning/application-provisioning-config-problem-scim-compatibility)
documents that **by default** (without the `aadOptscim062020` flag) Entra
disables a user with:

```json
{ "schemas": ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
  "Operations": [{ "op": "Replace", "path": "active", "value": "False" }] }
```

The value is the **string** `"False"`, not a boolean. With the flag, it sends
`"op":"replace"` with `false`, and may send a path-less replace whose value
is an object with dotted keys (`"name.givenName"`). BeamOS accepts **both
documented shapes**. Any other `active` value is a `400 invalidValue` rather
than a guess. Both are exercised in tests.

### Attribute mapping

| SCIM | BeamOS | Notes |
|---|---|---|
| `id` | `users.id` | Server-assigned UUID |
| `userName` | `users.email` (lowercased login key) + `users.scim_user_name` (verbatim) | Must be email-shaped. Returned with its original casing: Microsoft asks that *"Values sent should be stored in the same format they were sent"* |
| `externalId` | `users.scim_external_id` | Verbatim |
| `displayName` | `users.name` | Falls back to `name.formatted` or `givenName familyName` |
| `active` | `users.deactivated_at IS NULL` | |
| `emails` | derived | `[{value: email, type: "work", primary: true}]` |
| everything else | not stored | Accepted and **ignored** rather than rejected, so Entra's default mapping doesn't fail every user |

### Design decisions

- **Default org role: `field_technician`**, configurable via
  `SCIM_DEFAULT_ORG_ROLE`. The `organization_members` vocabulary is
  `org_owner` / `org_admin` / `field_technician`
  ([`routes/organizations.js`](../server/routes/organizations.js)).
  `field_technician` is the least-privileged: viewer-level access in the
  org's workspaces plus field-visit logging. An invalid value falls back to
  it with a warning.
- **Adoption:** if an account with that email exists but isn't in the org
  (typically someone who used "Sign in with Microsoft" before SCIM was
  enabled), `POST` links it into the org and returns `201`. A `409` would
  make that person unprovisionable forever: the org-scoped `userName` filter
  can't see them, so Entra would retry the create every cycle.
- **`DELETE` is a soft delete:** deactivate, then remove the membership in
  this org. RFC 7644 §3.6 allows this (*"MAY choose not to permanently delete
  … MUST return a 404"*). It does **not** call `deleteUserCascade`, which
  irreversibly deletes any org the user solely owns, with all its content.
  Entra only sends `DELETE` on hard-delete (30 days after soft-delete, per
  Microsoft's [deprovisioning docs](https://learn.microsoft.com/entra/identity/app-provisioning/how-provisioning-works#deprovisioning)).
  Unassigning, disabling or soft-deleting sends `PATCH active=false`. A
  platform admin can still hard-delete via `DELETE /api/auth/users/:id`.
- **Last-admin guard:** SCIM may deactivate platform admins (an offboarded
  admin must lose access too), but **not the last active one**, which would
  leave nobody able to fix a misconfigured provisioning job. That returns
  `403`.
- **`auth_provider='microsoft'`, no password** for created accounts. The
  person signs in through Part 1, matched by email.

---

## Part 4 — Ref 7: Entra app roles to BeamOS roles

Ref 8 provisions **accounts**. Ref 7 sets their **roles**: an Entra ID app role
(assigned to Entra groups) maps to a BeamOS org or workspace role, and the
mapping is applied each time the user signs in with Microsoft.

### What is read

Only the `roles` claim of the user's **verified** `id_token`, the one Part 1
checks against `SSO_TENANT_ID`. Entra fills it with the values of the app
roles assigned to the user, either directly or through a group. The `groups`
claim is never read, and SCIM `/Groups` is still `501`.

The sync needs `SSO_TENANT_ID`. Without it, the Microsoft login uses the old
Graph flow, there is no verified token, and **no sync runs**. Password,
Google, field-technician OTP, API tokens, SCIM tokens and service principals
never sync.

### Mapping roles in BeamOS

An org owner or org admin (or a platform admin) opens *Settings → Entra role
mappings*. Each row maps an **app role value** to a **target** and a **role**:

| Role | Target |
|---|---|
| `org_admin` | the organization itself |
| `workspace_admin`, `workspace_editor`, `workspace_viewer` | one workspace of this organization |

The role list in the form changes with the target. The same API:

```bash
curl -s https://signage.example.com/api/organizations/<org id>/entra-role-mappings \
  -H "Authorization: Bearer $SESSION_JWT"

curl -s -X POST https://signage.example.com/api/organizations/<org id>/entra-role-mappings \
  -H "Authorization: Bearer $SESSION_JWT" -H "content-type: application/json" \
  -d '{"claim_value": "BeamOS.Editors", "role": "workspace_editor", "workspace_id": "<workspace id>"}'

curl -s -X DELETE https://signage.example.com/api/organizations/<org id>/entra-role-mappings/<mapping id> \
  -H "Authorization: Bearer $SESSION_JWT"
```

| Rule | Result |
|---|---|
| `claim_value` empty, over 255 characters, or containing control characters | `400` |
| `role` not one of the four above (`org_owner`, `field_technician`, platform roles…) | `400` |
| `org_admin` with a `workspace_id`, or a workspace role without one | `400` |
| `workspace_id` not a workspace of this organization | `400` |
| The same app role value already mapped to the same target | `409` (one role per value and target) |
| Deleting a mapping of another organization | `404` |
| Caller not org owner/admin of this org | `403` |

The value is matched **exactly**, case included. Deleting a workspace or
organization deletes its mappings. Deleting the user who created a mapping
keeps the mapping. Every add/remove is audit-logged.

### What happens at sign-in

After the token is verified and the deactivated and account-link checks pass,
and **before** the session is issued, the sync brings the user's memberships in
line with their `roles` claim in one database transaction
([`lib/entra-role-sync.js`](../server/lib/entra-role-sync.js)):

- Each membership has a `source`: `NULL` = manual (added by hand, by invite,
  by SCIM, by org bootstrap) or `'entra'` = created by the sync.
- **No membership yet** where a mapping points → created with `source = 'entra'`.
- **An `'entra'` membership with a different role** → its role is updated.
  If several mappings point at the same workspace, the highest role wins
  (admin > editor > viewer).
- **A manual membership** where a mapping points → **left exactly as it is**
  (role and source). Manual wins.
- **An `'entra'` membership no mapping points at any more** (the user left the
  group, the app role was unassigned, or the mapping was deleted, including an
  org's last mapping) → removed.
- One audit entry, `entra_role_sync`, lists what was added, updated, removed
  or skipped, as org/workspace ids and roles only. It never contains the
  token, the claim values, the email or the `oid`. Nothing is written when
  nothing changed.

**Manual takeover.** When an admin changes the role of an `'entra'`
membership by hand (org or workspace member role change, or re-adding it from
the platform Users page), it becomes manual (`source = NULL`), and the sync
never changes or removes it again.

**Removing a mapped member by hand doesn't stick.** If an admin deletes an
`'entra'` membership while the user's group still maps to it, the sync creates
it again at their next Microsoft sign-in. To remove access, remove the user
from the Entra group (or unassign the group from the app role), or delete the
mapping.

**Fail closed.** If the sync fails (for example, the database is
unavailable), its transaction is rolled back and the sign-in is refused with
`503 {"code":"ROLE_SYNC_FAILED","error":"Sign-in could not complete; please try again."}`.
No session is issued with roles that weren't applied. The error is logged on
the server. A brand-new user's account row was already created at that point;
their next attempt signs in normally.

### Timing

- Changes apply at the user's **next Microsoft sign-in**, not immediately.
- An existing BeamOS session stays valid for up to **7 days** (the session
  JWT lifetime) with the memberships it had. Membership checks read the
  database on each request, so a removal or role change takes effect as soon
  as the user signs in again.
- For leavers, don't wait for the next sign-in: deactivate them through SCIM
  (Part 3). That cuts off every session on the next request (Part 2).

### Entra setup

Needs **Microsoft Entra ID P1 or higher** to assign **groups** to app roles
(Free tier only allows assigning individual users).

1. **App registrations → your BeamOS login app (`MICROSOFT_CLIENT_ID`) → App
   roles → Create app role.** Allowed member types: *Users/Groups*. The
   **Value** (for example `BeamOS.Editors`) is what you map in BeamOS. Create
   one app role per BeamOS role you want to grant.
2. **Enterprise applications → the same app → Users and groups → Add
   user/group.** Pick a group and the app role. Repeat for each group.
3. Nothing needs adding under *Token configuration*: Entra includes the
   `roles` claim in the `id_token` automatically once the user has an app role
   assignment.
4. In BeamOS, add the matching rows under *Settings → Entra role mappings*.
5. Make sure `SSO_TENANT_ID` is set (Part 1).

**Not verified without a real tenant.** The tests sign their own `id_token`s
with a `roles` claim shaped per Microsoft's documentation. A real Entra
tenant has not been used to check the portal steps, that group-assigned app
roles arrive in the `roles` claim of an MSAL SPA `id_token`, or how a user in
many groups is handled.

---

## Setup

### Is it one Entra registration or two?

**Two.** This is Microsoft's documented behaviour, not a design choice. From
Microsoft's [provisioning known issues](https://learn.microsoft.com/entra/identity/app-provisioning/known-issues#automatic-provisioning-isnt-available-on-my-oidc-based-application):

> *"If you create an app registration, the corresponding service principal in
> enterprise apps won't be enabled for automatic user provisioning. You'll need
> to either request the app be added to the gallery … or create a second
> non-gallery app for provisioning."*

The existing SSO login registration (created under **App registrations**,
used by MSAL) therefore cannot host the Provisioning tab, and SCIM needs a
**non-gallery enterprise app**.

*Not verified:* whether creating the non-gallery enterprise app first and
then also configuring its underlying app registration as the MSAL SPA could
collapse both into one object. Microsoft's docs don't state it either way,
and no real tenant was available to try it.

### A. SSO login app registration (existing; `MICROSOFT_CLIENT_ID`)

1. **App registrations → your BeamOS login app.** Single tenant is
   recommended.
2. **Authentication → Single-page application** redirect URI = your BeamOS
   origin (e.g. `https://signage.example.com`), as it already is for the
   current login.
3. Note the **Application (client) ID** (`MICROSOFT_CLIENT_ID`) and the
   **Directory (tenant) ID** (`SSO_TENANT_ID`).
4. **Token configuration → Add optional claim → ID:**
   - `email` (recommended): lets the login match accounts keyed on `mail`
     rather than UPN.
   - `amr` (**required** if `ENTRA_REQUIRE_MFA=true`), or in the manifest:
     ```json
     "optionalClaims": { "idToken": [ { "name": "email" }, { "name": "amr" } ] }
     ```
5. (For MFA) **Conditional Access → New policy** targeting this app, *Grant →
   Require multifactor authentication*.

### B. SCIM provisioning enterprise app

1. **Enterprise apps → New application → Create your own application →**
   *"Integrate any other application you don't find in the gallery
   (Non-gallery)"*. Name it e.g. `BeamOS provisioning`.
2. Mint a SCIM token in BeamOS (next section). You need the `token` and
   `scim_base_url`.
3. **Provisioning → Automatic.** *Tenant URL* = `https://<your-host>/scim/v2`.
   *Secret Token* = the `scim_…` value. Click **Test Connection**. Entra then
   queries `GET /Users?filter=userName eq "<random GUID>"`, and BeamOS answers
   `200` with an empty ListResponse (tested).
4. **Mappings:**
   - Turn **off** "Provision Microsoft Entra ID Groups" (BeamOS returns
     `501` for `/Groups`).
   - In user mappings, keep `userPrincipalName → userName` (matching
     attribute), `Switch([IsSoftDeleted]…) → active`, `displayName →
     displayName`, and `mailNickname → externalId`. Other default mappings
     (`name.givenName`, `emails[type eq "work"].value`, `title`, …) are
     accepted and ignored. Deleting them reduces noise in Entra's
     provisioning logs.
5. **Users and groups:** assign the people who should have BeamOS accounts.
   Scope = *Sync only assigned users and groups*.
6. **Start provisioning.**

### C. App roles for role mapping (Ref 7)

Optional. Define app roles on the login app registration (A) and assign groups
to them on its enterprise app. See [Part 4 → Entra setup](#entra-setup).

### Environment

```bash
SSO_TENANT_ID=<Directory (tenant) ID>          # enables Ref 5 tenant restriction (independent of Ref 9's ENTRA_TENANT_ID)
MICROSOFT_CLIENT_ID=<login app's client ID>    # required id_token audience
ENTRA_REQUIRE_MFA=true                         # optional; requires the amr optional claim
SCIM_DEFAULT_ORG_ROLE=field_technician         # optional; org role for provisioned users
PUBLIC_BASE_URL=https://signage.example.com    # optional; used in SCIM meta.location
AUTO_CREATE_ORG_ON_SIGNUP=false                # recommended with SCIM, see Known gaps
```

All unset leaves behaviour exactly as before Ref 5/8. Setting only Ref 9's
`ENTRA_TENANT_ID` does **not** change login (tested). With `SSO_TENANT_ID`
unset, the Microsoft login is the old Graph flow, and `/scim/v2` does nothing
without a minted token.

### Minting / listing / revoking a SCIM token (API only)

**There is no dashboard UI for this yet.** It is platform-admin API only,
the same tier as Ref 9's Service Principal registration
([`routes/admin.js`](../server/routes/admin.js)).

```bash
# Platform-admin session JWT (e.g. from the browser's localStorage "token")
TOKEN=eyJ...

# Find the organization id
curl -s https://signage.example.com/api/admin/orgs -H "Authorization: Bearer $TOKEN"

# Mint: the `token` field is shown ONCE and only its SHA-256 is stored
curl -s -X POST https://signage.example.com/api/admin/scim-tokens \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Entra provisioning","organization_id":"<org id>"}'
# -> 201 {"id":"…","prefix":"scim_a1b2c3d4","name":"Entra provisioning",
#         "organization_id":"…","token":"scim_…","scim_base_url":"https://signage.example.com/scim/v2", …}

# List (never includes the secret or hash; shows last_used_at)
curl -s https://signage.example.com/api/admin/scim-tokens -H "Authorization: Bearer $TOKEN"

# Revoke (soft; refused on the very next SCIM request)
curl -s -X DELETE https://signage.example.com/api/admin/scim-tokens/<id> -H "Authorization: Bearer $TOKEN"
```

To rotate a token: mint a new one, paste it into Entra, *Test Connection*,
then revoke the old one.

### Maximum SCIM token lifetime (Ref 34)

SCIM tokens follow the same organization-level cap as `st_` API tokens:
`organizations.max_token_lifetime_days`. The default is `null`, meaning no
cap and the existing behaviour. An org owner/admin (or a platform admin) sets
it with `PATCH /api/organizations/<org id>/token-policy`. See
[docs/bi-integration.md](bi-integration.md#maximum-token-lifetime-ref-34) for
the endpoint.

- `scimAuth` compares the token's age (now − `created_at`) with the **bound
  organization's** current cap (`scim_tokens.organization_id`) on every
  request. The check is retroactive: when the cap is lowered, a token that
  is already older than the new cap is refused on its very next request. The
  refusal is the same `401` SCIM error as a revoked token, with `detail`
  `"Invalid or expired SCIM bearer token"`. Entra reports it as a
  provisioning credential failure, and provisioning stops until a new token
  is pasted in.
- `GET /api/admin/scim-tokens` (and the mint response) now include
  `expires_at` (epoch seconds, or `null` when uncapped) and `expired`.
  Rotate (mint → paste into Entra → *Test Connection* → revoke the old one)
  before `expires_at`.
- Raising or removing the cap re-admits a token that was refused only for its
  age. Use revoke to kill a token permanently.
- **Minting stays platform-admin only, but the org sets the cap.** An org
  admin can't mint or see its SCIM tokens (see above), yet it can shorten
  their lifetime. That is intentional: the cap only restricts access and
  never widens it.
- **Not covered:** Entra ID Service Principals (Ref 9). BeamOS stores only
  their `client_id`, and each call brings a short-lived Entra access token
  whose `exp` is enforced by `jwtVerify` in `middleware/entraToken.js`. The
  SP's own client-secret or certificate expiry is set in Entra. Browser SSO
  sessions (`jwtExpiry`) are interactive logins, not programmatic access, and
  are also out of scope.

---

## Worked example: the full loop

This is exactly what `test/scim.test.js`'s end-to-end test does over real
HTTP against the real database (see Evidence). The `curl`s are the requests
Entra sends.

**1. User assigned to the app in Entra, and Entra's next cycle creates them:**

```http
POST /scim/v2/Users
Authorization: Bearer scim_…
Content-Type: application/scim+json

{ "schemas": ["urn:ietf:params:scim:schemas:core:2.0:User"],
  "userName": "ana.leaver@contoso.com", "externalId": "ana.leaver",
  "displayName": "Ana Leaver", "active": true,
  "emails": [{ "primary": true, "type": "work", "value": "ana.leaver@contoso.com" }] }
```
→ `201`, `Location: …/scim/v2/Users/<id>`, `"active": true`. BeamOS now has
the account, a member of the token's org as `field_technician`.

**2. Ana signs in with Microsoft.** MSAL returns an id_token for tenant
`SSO_TENANT_ID`. `POST /api/auth/microsoft {id_token}` validates it (Part 1),
matches the SCIM account by email, and issues a session JWT. Her
`GET /api/auth/me` returns `200`.

**3. Ana leaves, and is unassigned or disabled in Entra.** On its next
incremental cycle, Entra sends:

```http
PATCH /scim/v2/Users/<id>
Content-Type: application/scim+json

{ "schemas": ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
  "Operations": [{ "op": "Replace", "path": "active", "value": "False" }] }
```
→ `200 { …, "active": false }`, and `users.deactivated_at` is set.

**4. Ana's still-open browser tab makes its next API call with the same,
unexpired session JWT:**

```http
GET /api/auth/me
Authorization: Bearer <Ana's session JWT>
```
→ `401 {"error":"account_deactivated"}`. Her `st_` tokens and any open
dashboard socket are cut off too, and a fresh Microsoft login with a
perfectly valid id_token gets `403`.

**Timing, stated honestly.** BeamOS revokes on the **next request after the
SCIM call arrives**. When the SCIM call arrives is up to Entra: it runs
periodic incremental cycles whose interval Microsoft says *"is currently not
configurable"*
([known issues](https://learn.microsoft.com/entra/identity/app-provisioning/known-issues#the-provisioning-interval-is-fixed)).
For an urgent offboarding, use **Provision on demand** on the enterprise
app's Provisioning page to push that one user immediately.

---

## Evidence

All runs are on branch `version2` against the local MySQL dev database, with
disposable randomly-suffixed fixtures deleted afterwards (leftover-row checks
returned 0).

| Test file | Result | What it covers |
|---|---|---|
| [`test/microsoft-sso.test.js`](../server/test/microsoft-sso.test.js) | **25/25** | 14 unit cases on `verifyEntraIdToken`: valid, wrong tenant (`iss`), mismatched `tid`, wrong `aud`, unset client ID fails closed, expired, app-only, missing `oid`/email, `alg:none`, RS256→HS256 confusion, MFA missing `amr` / password-only / `mfa` present / not required, and validation keyed to `SSO_TENANT_ID` (never `ENTRA_TENANT_ID`, failing closed when unset). 11 real-HTTP route cases: tenant-restricted login creates an account from verified claims with no Graph call; `email` vs UPN matching; access_token-only → 400; other tenant → 401; wrong aud → 401; MFA 401/200; **tenant unset → original Graph flow unchanged, no JWKS fetch**; original error messages preserved; **`ENTRA_TENANT_ID` set alone (Ref 9 only) leaves login in the original access_token mode**; `/config` authority |
| [`test/user-deactivation.test.js`](../server/test/user-deactivation.test.js) | **8/8** | Schema-check repair; **an existing, valid session JWT rejected on the very next request**, and restored on reactivation; idempotent + audited; password login 403 vs generic 401; `st_` token dies; field OTP 403; Microsoft login refused **without** re-linking provider; open socket disconnected + handshake refused |
| [`test/scim.test.js`](../server/test/scim.test.js) | **25/25** | Token plaintext-once + hash-only; non-admin can't mint; 401 shapes; `scim_` useless on `/api`; revoked token refused; ServiceProviderConfig / ResourceTypes / Schemas shapes; Test Connection empty list; Entra create body; 409; adoption; filters incl. unquoted `externalId`; pagination; **cross-org invisibility**; PATCH default + flag shapes; validation errors; **full loop** (above); PUT; soft DELETE → 404 → re-adopt; malformed JSON / `/Groups` 501 |
| [`test/scim-unit.test.js`](../server/test/scim-unit.test.js) | **5/5** | Last-admin guard (not reachable on the shared DB), `"False"` parsing, `and`-splitting inside quotes/brackets, filter compilation, PATCH parsing |

**Mutation checks** (each temporarily applied, then reverted):
- Removing the `tid` and MFA checks → 4 SSO tests fail.
- Removing `requireAuth`'s deactivation check → the RFP test fails.
- Removing string-`"False"` parsing → the full-loop test fails.
- Removing the `revoked_at` check → the revoked-token test fails.
- Keying the login on `ENTRA_TENANT_ID` again (undoing the split) → 7 SSO tests fail, including the Ref-9-only test.

**Regression:**
- Stage 2 changes the columns `requireAuth` / `apiTokenAuth` SELECT, so 30
  test files with hand-written SQLite `users` mocks gained a
  `deactivated_at` column (as `must_change_password` did before). Each was
  run before and after, sequentially, and matches its **pre-change
  pass/fail counts exactly**.
- `api.test.js` (partition firewall, 63), `openapi-contract` (2),
  `entra-token` (22) and `entra-token-integration` (5) pass.
- Pre-existing failures are unchanged and not introduced here:
  `admin-users` (10), `user-deletion` (4), `schema-check` (3).

**Live server boots:**
- With **only Ref 9 configured** (`ENTRA_TENANT_ID` + `ENTRA_API_CLIENT_ID` + `MICROSOFT_CLIENT_ID` set, `SSO_TENANT_ID` unset):
  `/api/auth/config` reports `microsoftTenantId: "common"`. `POST /microsoft` with `{}` or with only an `id_token` both return
  `"Microsoft access token required"`, and a (fake) `access_token` goes to real Graph `/me` and returns the original
  `"Could not get Microsoft profile"`. The pre-Ref-5 login is unaffected.
- Earlier boots, with no Entra settings at all:
  - `/api/auth/config`, `/api/auth/microsoft` (`"Microsoft access token
    required"`) and `/api/auth/login` responses are byte-identical to before.
  - After `ALTER TABLE users DROP COLUMN deactivated_at`, boot logged
    `[schema-check] repaired users.deactivated_at`.
  - `/scim/v2` on the real mount: SCIM-shaped 401 without a token;
    ServiceProviderConfig and Test Connection correct with one;
    `application/scim+json` malformed body → `400 invalidSyntax`; a `scim_`
    token on `/api/devices` → 401.

## What this does and doesn't prove

**Proven:** the validation logic (including against forged tokens), the full
Express paths over real HTTP on real MySQL, per-request revocation on every
identity path listed in Part 2, SCIM response shapes against RFC
7643/7644, and handling of both request shapes Microsoft documents Entra
sending.

**Not proven without a real Entra tenant** (same category as
[entra-auth.md's list](entra-auth.md#what-this-does-and-doesnt-prove)):
- That real id_tokens carry exactly these claims. In particular, `amr`
  appears only after the optional claim is added, and `email` only if
  requested. Only self-signed tokens shaped per Microsoft's docs were
  tested.
- That Entra's provisioning service, against this endpoint, passes *Test
  Connection* and a full cycle without surprises. The request bodies used are
  Microsoft's documented examples, not captured traffic. Microsoft's
  [SCIM validator](https://learn.microsoft.com/entra/identity/app-provisioning/scim-validator-tutorial)
  should be run against a deployed instance before go-live.
- Portal steps are written from Microsoft's current documentation, not by
  clicking through a tenant.

## Known gaps (honest list)

- **Role mapping is sign-in time only (Ref 7).** SCIM still provisions
  **accounts** with the one `SCIM_DEFAULT_ORG_ROLE` and `/Groups` is `501`.
  Org/workspace roles from Entra app roles (Part 4) are applied at the user's
  next Microsoft sign-in, not when the group changes in Entra, and need
  `SSO_TENANT_ID`. `org_owner`, `field_technician` and platform roles can't be
  mapped. The sync doesn't apply the manual routes' "last admin" guards.
- **No UI** for SCIM tokens or for deactivating/reactivating a user by hand.
  Both are API/SCIM only (`setUserDeactivated` is ready for an admin toggle).
- **First SSO login of a provisioned user can mint a personal org.**
  `ensureDefaultOrgForUser` ([`routes/auth.js`](../server/routes/auth.js)) only
  looks for **workspace** memberships. A SCIM user holds an *org* membership,
  so with `AUTO_CREATE_ORG_ON_SIGNUP` at its default `true`, their first login
  also creates `"<name>'s organization"`. This is pre-existing behaviour for any
  org-level member without a workspace row. Set `AUTO_CREATE_ORG_ON_SIGNUP=false`
  on SCIM deployments; changing the helper itself was out of scope because it
  would alter login for all users.
- **Deactivation is global.** `deactivated_at` is per user, not per org. A
  user in two orgs deactivated by one org's SCIM token loses access
  everywhere. That fits one-tenant-per-deployment, but is worth knowing.
- **Unstored SCIM attributes are discarded.** `name.givenName` /
  `familyName`, `title`, `phoneNumbers`, `emails` beyond the login email and
  the enterprise extension are accepted and dropped. `/Schemas` advertises
  exactly what is stored.
- **Accounts are keyed by email.** A `userName` change via SCIM changes the
  login email. SSO matching is by email, not `oid`, which is unchanged from
  before Ref 5.
- **id_token replay window.** The server can't check `nonce` (MSAL validates
  it client-side against its own request), so a stolen, unexpired id_token for
  this client ID could be exchanged for a session. This is inherent to the
  SPA-sends-id_token pattern and bounded by token lifetime (~1 h). An
  auth-code + PKCE server-side flow would close it and is new work.
- **Live-socket disconnect is per process.** It iterates the local
  socket.io namespace, which is correct for BeamOS's single-node
  deployments. Every other revocation is a DB read and works across
  processes.
- **SCIM query extras ignored:** `attributes` / `excludedAttributes` /
  `sortBy` are not implemented (ServiceProviderConfig says `sort: false`).
  Entra only sends `excludedAttributes=members` for Groups, which are
  unsupported anyway.
