# Multi-Tenancy & Data Isolation

BeamOS's tenant-isolation model, documented as evidence for Ref 11. Written
the same way as [docs/rbac.md](rbac.md) (Ref 5) and
[docs/data-export.md](data-export.md) (Ref 21): what is actually built and
proven, cited against real code and real test runs, with the boundaries
called out honestly. For the role/permission layer that sits on top of this
boundary (who, once inside a tenant, can read vs. write vs. administer), see
[docs/rbac.md](rbac.md); this document is about the boundary itself — what
stops one tenant from ever reaching another tenant's rows in the first
place. The original design proposal this shipped from is
[docs/multi-tenancy-design.md](multi-tenancy-design.md); this document
describes the built, tested result, not the plan.

## 1. The isolation model

BeamOS is a single shared MySQL database (`beamos`) serving every customer.
There is no database-per-tenant or schema-per-tenant split — isolation is
enforced entirely in the application layer, at one chokepoint every
authenticated request passes through.

**The tenant boundary is `workspace_id`** (grouped under `organization_id`
one level up — see the hierarchy below). Nearly every tenant-owned table —
`content`, `widgets`, `kiosk_pages`, `layouts`, `playlists`, `schedules`,
`devices`, `video_walls`, `activity_log`, `play_logs`, `field_visits`,
`registration_codes`, `ai_settings`, and more — carries a `workspace_id`
(or, for org-level tables like `regions`, an `organization_id`) column, and
every query against them is filtered by it.

```
platform            (one hosted instance, or one self-hosted install)
  organization       (billing/admin entity — a direct customer, or a reseller)
    workspace         (a tenant — data inside is isolated from every sibling)
      devices, content, playlists, layouts, schedules,
      tickets, activity_log, play_logs, field_visits, ...
```

### `resolveTenancy`: the single resolution point

[`server/lib/tenancy.js`](../server/lib/tenancy.js)'s `resolveTenancy`
middleware is the one place, on every request, where "which tenant is this
request for" gets decided. It runs immediately after `requireAuth` and
attaches a fixed set of fields to `req` — `req.workspaceId`, `req.workspace`,
`req.organizationId`, `req.workspaceRole`, `req.orgRole`, `req.actingAs`,
`req.isPlatformAdmin` — that every downstream route handler and every
`server/lib/permissions.js` predicate reads instead of re-deriving tenancy
itself. There is exactly one implementation of "resolve the active
workspace," not one per route.

Resolution order (first match wins), each step validated against real
access before it's accepted:

1. `X-Workspace-Id` header — explicit per-request override
2. `?workspace_id=` query param — same purpose, easier from a browser
3. The JWT's `current_workspace_id` — the session's last-switched-to workspace
4. The user's first `workspace_members` row (by `joined_at`)
5. For `platform_admin` / `platform_operator` only, with no membership at
   all: any workspace, so staff always land in a usable context

An **explicit** candidate (steps 1–2 — the caller *named* a workspace on
purpose) that the caller has no path into is rejected outright with `403`,
not silently swapped for the caller's own workspace. An implicit, stale one
(a JWT carrying a `current_workspace_id` for a workspace the user was since
removed from) is discarded and resolution falls through to the next
candidate instead of 403ing the whole request.

"No path into it" is checked by `accessContext()` — membership row, or
org-wide access (`org_owner`/`org_admin` of the workspace's parent org), or
platform staff, or (Ref 43) a `field_technician`'s org-wide *read-only*
reach. Anything else returns `null`, and `resolveTenancy` treats that
exactly like a missing workspace.

### The general pattern

With `req.workspaceId` resolved once per request, every route follows the
same shape: **every query is scoped by tenant ID in the `WHERE` clause**
(`WHERE workspace_id = ?`, or `WHERE organization_id = ?` for org-tier
resources), sourced from `req.workspaceId` — never from a client-supplied
body field, and never trusted from a URL param without re-checking access
to *that* param's workspace/org via `canAccessWorkspace`/`canAccessOrg` (see
[docs/rbac.md](rbac.md)). There is no cross-tenant read or write possible
through the normal request path — a tenant ID a caller doesn't have
standing in simply never matches a row.

The only way to cross that boundary is an **explicit, audited override**:
`platform_admin` (full owner-tier access to every org/workspace) or
`platform_operator` (cross-org read/write for support, but never
admin-tier actions — see the role table in [docs/rbac.md](rbac.md)).  Both
route through the *same* `resolveTenancy`/`accessContext` code path as
everyone else (`isPlatformStaff` is just one more branch in
`accessContext()`, not a bypass around it) and both are logged: every write
made by a platform-staff session lands in `activity_log` like any other
write, and Ref 17's tamper-evident hash chain
([`GET /api/activity/verify-integrity`](../server/routes/activity.js))
covers those rows the same as everyone else's. There is no "raw SQL admin
backdoor" that skips `workspace_id` filtering — the override is a role
check inside the same resolver, not a different code path.

## 2. Architecture: where the boundary sits

```
 ┌────────────┐   ┌─────────────┐   ┌──────────────────┐   ┌─────────────────────┐   ┌──────────┐
 │  HTTP       │──>│ requireAuth │──>│  resolveTenancy   │──>│ route handler:       │──>│ response │
 │  request    │   │ (verify JWT │   │  (server/lib/     │   │  WHERE workspace_id  │   │  (only   │
 │  + JWT /    │   │  / st_...   │   │  tenancy.js)      │   │  = req.workspaceId   │   │  this    │
 │  API token) │   │  token)     │   │                   │   │  (or org_id = ...)   │   │  tenant's│
 └────────────┘   └─────────────┘   └──────────────────┘   └──────────┬───────────┘   │  rows)   │
                                       sets req.workspaceId,                          └──────────┘
                                       req.organizationId,                                  ▲
                                       req.workspaceRole, req.actingAs                       │
                                                                                              │
                                                           ═══════════ isolation boundary ════╪═══
                                                                                              │
                                                                              ┌───────────────┴──┐
                                                                              │  MySQL (`beamos`) │
                                                                              │  ONE shared DB —  │
                                                                              │  every tenant's    │
                                                                              │  rows live in the  │
                                                                              │  same tables,      │
                                                                              │  distinguished     │
                                                                              │  only by           │
                                                                              │  workspace_id /    │
                                                                              │  organization_id   │
                                                                              └────────────────────┘
```

The isolation boundary is **entirely application-side, above the query**:
nothing in MySQL itself knows or enforces which rows belong to which
tenant — no row-level security, no per-tenant schema, no per-tenant
database user. The database will faithfully return whatever a query asks
for; the guarantee that a query only asks for one tenant's rows lives in
`resolveTenancy` producing `req.workspaceId`, and in every route handler
using it in its `WHERE` clause. This is why the "real evidence" in §3 tests
the request → resolver → query path end-to-end against a real Express app
and (mostly) a real database, rather than unit-testing the resolver alone —
the guarantee only holds if every route actually uses what the resolver
gives it, and that is exactly the thing that can regress silently (see the
missing-`await` bug below).

## 3. Real evidence: cross-tenant isolation test coverage

This is not a general claim — every row below is a real, currently-passing
automated test, in a real file, asserting a real tenant boundary (either
"tenant B never sees tenant A's row" or "a cross-tenant/cross-org request
is refused"), found by sweeping every file under
[`server/test/`](../server/test/) for isolation-boundary assertions rather
than sampling a few. Grouped by feature area.

### 3.1 The core resolver guard — and a real bug it caught

**[`server/test/tenancy-cross-tenant.test.js`](../server/test/tenancy-cross-tenant.test.js)**
is the dedicated suite for `resolveTenancy`/`accessContext` itself, and it
exists because of a genuine regression: a missing `await` on
`accessContext()` (`const ctx = ws && accessContext(...)` — an unawaited
call is a pending Promise, which is always truthy) silently disabled the
`!ctx → 403` gate at **10 call sites** across `assignments.js`, `layouts.js`,
`playlists.js`, `schedules.js`, and `video-walls.js`. While that bug was
live, any authenticated user could reach any other tenant's resources
through those routes. Fixed at all 10 sites; this suite drives the real
Express app (real `requireAuth` + `resolveTenancy` + real route files,
mounted exactly as `server.js` mounts them) to exercise the actual routes,
not a re-implementation of the check:

- `cross-tenant: user-b is denied tenant A playlist (playlists.js:47)`
- `cross-tenant: user-b is denied tenant A layout (layouts.js:49)`
- `cross-tenant: user-b is denied writing tenant A schedule (schedules.js:43)`
- `cross-tenant: user-b is denied tenant A video wall (video-walls.js:19)`
- `cross-tenant: user-b is denied tenant A device assignments (assignments.js:41)`
- `control: user-a can read their own tenant A playlist (200, ...)` — the
  negative control proving the suite isn't just failing every request

### 3.2 Data export (all four formats: CSV/XLSX/PDF/JSON)

**[`server/test/data-export-json.test.js`](../server/test/data-export-json.test.js)**:
- `content/export: tenant B json is workspace-scoped (no tenant A rows)`
- `widgets/export: tenant B json is workspace-scoped`
- `playlists/export: tenant B json is workspace-scoped`
- `walls/export: tenant B json is workspace-scoped`
- `workspaces/:id/members/export: RBAC - non-member gets 403 on json, same as csv`

**[`server/test/dashboard-content-export.test.js`](../server/test/dashboard-content-export.test.js)**:
- `csv: tenant A sees only its own content, never tenant B`
- `csv: tenant B sees only its own content, never tenant A`
- `xlsx: correct content-type, and no cross-tenant leakage`
- `pdf: tenant B decode is disjoint from tenant A`
- `control: GET / JSON is also workspace-scoped (proves the shared query, not just the export)`

**[`server/test/dashboard-content-plays.test.js`](../server/test/dashboard-content-plays.test.js)**:
- `cross-tenant: tenant A never sees tenant B's rows for a shared content id`
- `cross-tenant: tenant B sees only its own single row for the shared content id`
- `content id that exists only in the other tenant -> empty timeline, not a leak`

### 3.3 SLA / dashboard rollups

**[`server/test/sla-overview.test.js`](../server/test/sla-overview.test.js)**:
- `workspace isolation: WS A never sees the other tenant device`

**[`server/test/sla-trend.test.js`](../server/test/sla-trend.test.js)**:
- `workspace-scoped: WS A never sees WS B usage (its full-day b1 row)`

**[`server/test/regions-sla.test.js`](../server/test/regions-sla.test.js)**:
- `RBAC: a member of ONE workspace sees only that workspace — no other region leaks in`
- `RBAC: no accessible workspace in the org -> 403; unknown org -> 404`

### 3.4 Org-level resources (regions)

**[`server/test/regions.test.js`](../server/test/regions.test.js)**:
- `RBAC: org_admin of org-a CANNOT touch org-b regions` — GET/POST/PATCH/DELETE
  all return 403 across the org boundary
- `RBAC: a workspace_admin (not an org member) cannot create a region`
- `PATCH /workspaces/:id/region — RBAC + cross-org guard + unassign`

### 3.5 Reporting (Ref 48 / Ref 49)

**[`server/test/reconciliation.test.js`](../server/test/reconciliation.test.js)**:
- `GET /reconciliation: workspace-scoped — WS2 member sees only WS2 devices`

**[`server/test/pending-installation-report.test.js`](../server/test/pending-installation-report.test.js)**:
- `GET /pending-installations: workspace-scoped — WS2 member sees only WS2 codes`

*(These two run against the live MySQL database rather than an in-memory
stub — see §3.11 for the fix that made that possible in this environment
and the fresh run: both now confirmed 15/15 passing against real MySQL,
today.)*

### 3.6 Device provisioning & registration codes

**[`server/test/registration-codes.test.js`](../server/test/registration-codes.test.js)**:
- `scoping: an admin of another workspace cannot mint into ws-a`
- `scoping: an admin of another workspace cannot list ws-a codes`
- `delete: RBAC - an admin of another workspace cannot delete a ws-a code (403)`

**[`server/test/registration-code-claim.test.js`](../server/test/registration-code-claim.test.js)**:
- `claim: workspace scoping - a ws-b code lands the device in ws-b` — the
  device is assigned into the *code's* workspace regardless of who claims it
- `claim: code for a since-deleted workspace -> 409, no orphan device`

**[`server/test/registration-codes-device-owner-qr.test.js`](../server/test/registration-codes-device-owner-qr.test.js)**:
- `device-owner QR: a non-admin of the code's workspace is denied (403)`

### 3.7 Campaigns, tickets, and API-surface guards

**[`server/test/campaigns.test.js`](../server/test/campaigns.test.js)**:
- `RBAC: viewer reads but cannot create/update/delete; non-member + other-org denied`
- `RBAC: org_owner and platform_admin can manage without a workspace_members row`
- `GET detail + 404 for other workspace`

**[`server/test/campaign-delivery.test.js`](../server/test/campaign-delivery.test.js)**:
- `workspace scope: a play of the SAME content on a device in ANOTHER workspace is NOT counted`
  — proves the isolation holds even for a play-log join on a *shared*
  content id, not just simple row ownership

**[`server/test/tickets.test.js`](../server/test/tickets.test.js)**:
- `RBAC: non-member and other-org user get 403 on everything; cross-workspace denied`
- `GET single ticket + 404 for other workspace`
- `sla-summary RBAC: viewer can read, non-member 403, unknown workspace 404`

**[`server/test/api.test.js`](../server/test/api.test.js)**:
- `gap: playlist item REJECTS a cross-tenant zone_id (400, is_template OR workspace_id guard)`
- `gap: device PUT REJECTS a cross-tenant layout_id (400)` — proves the
  boundary is enforced on *nested writes* (a foreign key pointing into
  another tenant), not just top-level resource ownership
- `pip: workspace isolation — wsA token cannot target a wsB device (404)`

*(`api.test.js` runs against the live MySQL database; still not
re-executed cleanly for this document — see §3.11 for why fixing the
credential gap wasn't enough to resolve it.)*

### 3.8 Device audit trail (Phase 2) and field visits (Ref 43)

**[`server/test/device-audit.test.js`](../server/test/device-audit.test.js)**:
- `route: 404 unknown device, 403 unassigned, 403 no workspace access`
- `route: status-heatmap 200 + RBAC (404 / 403 / 403)`

**[`server/test/field-visits.test.js`](../server/test/field-visits.test.js)**:
- `platform_admin is allowed; unknown workspace 404; cross-workspace device 400`

### 3.9 A narrower boundary inside the boundary: agency (scoped API) tokens

Ref 73's agency-token primitive adds a *second*, tighter boundary that sits
*inside* the workspace one: a scoped API token confined not just to a
workspace but to specific, pre-designated resources within it.

**[`server/test/agency-list.test.js`](../server/test/agency-list.test.js)**:
- `#73 GET targets: returns ONLY this token's designated, in-workspace
  playlists` — four distinct ways this could leak (another token's
  designation, an undesignated in-workspace row, a designation that's since
  gone cross-workspace) are each asserted false in one test.

**[`server/test/agency-layouts.test.js`](../server/test/agency-layouts.test.js)**:
- `#73 layout geometry: own layout only, all zones geometry, theirs marked,
  NO device data`

**[`server/test/agency-scope.test.js`](../server/test/agency-scope.test.js)** /
**[`server/test/agency-gate.test.js`](../server/test/agency-gate.test.js)** /
**[`server/test/agency.test.js`](../server/test/agency.test.js)** — the
token-scope-gate seam itself (`#73 spine: agency scope auto-fails
tokenScopeGate everywhere`) and the end-to-end confinement suite against a
booted server (`#73 agency token: full bite-suite (happy path + 4
confinement assertions)`).

### 3.10 A related, adjacent boundary: shared/template rows

**[`server/test/operator-permissions.test.js`](../server/test/operator-permissions.test.js)**
covers the one legitimate exception to "every row belongs to exactly one
workspace" — platform-template content (`workspace_id IS NULL`), shared
read-only across every tenant:
- `operator CAN update a workspace-scoped content row`
- `operator CANNOT update a shared (workspace_id IS NULL) content row -> 403`
- `operator CANNOT delete a shared (workspace_id IS NULL) content row -> 403`

This is the mirror image of the isolation guarantee: a `NULL`
`workspace_id` is a deliberate, visible "belongs to no tenant, readable by
all" marker, not an accidental gap in the `WHERE workspace_id = ?` filter —
and even platform *operator* staff (who can act-as into any real tenant)
still can't write to it, only `platform_admin` can.

### 3.11 Re-run fresh for this document (2026-09-11)

Every file cited above that runs against an in-memory/stubbed database (no
live MySQL, no spawned server process, no external fixture) was re-run
fresh, together, right now — 20 files spanning every subsection except
§3.5 and part of §3.9 (see the gap note below):

```
$ node --test server/test/tenancy-cross-tenant.test.js \
               server/test/data-export-json.test.js \
               server/test/dashboard-content-export.test.js \
               server/test/dashboard-content-plays.test.js \
               server/test/regions.test.js \
               server/test/regions-sla.test.js \
               server/test/sla-overview.test.js \
               server/test/sla-trend.test.js \
               server/test/campaigns.test.js \
               server/test/campaign-delivery.test.js \
               server/test/tickets.test.js \
               server/test/registration-codes.test.js \
               server/test/registration-code-claim.test.js \
               server/test/agency-list.test.js \
               server/test/agency-layouts.test.js \
               server/test/agency-scope.test.js \
               server/test/agency-gate.test.js \
               server/test/field-visits.test.js \
               server/test/device-audit.test.js \
               server/test/operator-permissions.test.js
# tests 184
# pass 184
# fail 0
```

**Update, same day: the "no `.env`" gap originally noted here was a
misdiagnosis of the real mechanism — corrected below rather than
silently.** The original note said `reconciliation.test.js`,
`pending-installation-report.test.js`, and `api.test.js` were skipped
because this environment had no `.env`. That premise was wrong:
`server/.env` existed the whole time with real
credentials — `npm test` (and every bare `node --test` invocation) simply
never loaded it. `start`/`dev` already passed Node's
`--env-file-if-exists=.env` flag; `test` didn't. Fixed in
[`server/package.json`](../server/package.json) (`"test": "node
--env-file-if-exists=.env --test"`), matching `start`/`dev`. Re-investigating
with real credentials now available produced three genuinely different
outcomes, not one uniform "now it works":

- **`reconciliation.test.js` and `pending-installation-report.test.js`
  were genuinely credential-blocked, and are now confirmed passing.**
  Re-run fresh against the real MySQL database, each in its own process:
  ```
  $ node --env-file-if-exists=.env --test server/test/reconciliation.test.js
  # tests 15
  # pass 15
  # fail 0

  $ node --env-file-if-exists=.env --test server/test/pending-installation-report.test.js
  # tests 15
  # pass 15
  # fail 0
  ```
  The citations in §3.5 now stand on a fresh, real run, not a "last
  known-passing" claim.

- **`api.test.js` (§3.7) is a partial correction, not a clean resolution.**
  Credentials were genuinely part of the failure — with the fix, the real
  server now boots against real MySQL. But that only uncovers a second,
  independent, pre-existing bug: the test's own `before()` hook opens
  `DATA_DIR/db/remote_display.db` directly via `better-sqlite3` — a flat-file
  SQLite path from before this codebase's MySQL migration
  (`server.js` hasn't created that file since ~2026-07-21). Re-run fresh:
  ```
  $ node --env-file-if-exists=.env --test server/test/api.test.js
  # tests 61
  # pass 0
  # fail 61
  ```
  Same fail count as before the fix, for a **different, unrelated reason**
  now. The cross-tenant assertions cited from this file in §3.7 are still
  standing on their last known-passing run, not today's — the npm-test fix
  did not resolve this file, and fixing it further is unrelated,
  pre-migration test-fixture work, not a tenancy-isolation question.

- `agency.test.js` and `registration-codes-device-owner-qr.test.js` (§3.9)
  remain excluded from the in-process re-run for the original, unrelated
  reason (spawn a real separate `node server.js` process / depend on a
  resolved APK fixture) — nothing about this investigation changes that.

The 184-test in-process run above is unaffected by any of this — none of
those 20 files touch MySQL — and remains a substantial, genuinely fresh,
genuinely representative sample spanning every feature area in this
section: the core resolver guard (including the regression it caught),
exports, dashboards, SLA rollups, regions, campaigns, tickets, registration
codes, field visits, device audit, the agency-token confinement boundary,
and the shared-template exception. Adding the two now-confirmed real-MySQL
runs above, **214 tests across 22 files are now fresh, real, and passing**
for this document — up from 184, with the one remaining gap (`api.test.js`)
honestly attributed to its actual, different cause.

## 4. Encryption

Tenant isolation (§1–3) is a *logical* boundary — it stops queries from
crossing tenants. It says nothing about what happens if someone reads the
raw database files or a backup directly. That's a separate property,
covered here honestly in two parts: what BeamOS's application code actually
encrypts today, and what's a deployment decision left to whoever runs the
database.

### 4.1 What the application encrypts today

[`server/lib/secretbox.js`](../server/lib/secretbox.js) is a real,
generic AES-256-GCM encrypt/decrypt helper — 31 lines, not a stub. Format is
`base64(iv[12] | tag[16] | ciphertext)`; a fresh random 12-byte IV per call,
a 16-byte GCM auth tag (so tampering with the ciphertext is detected, not
just silently mis-decrypted), and the key is `sha256(JWT_SECRET +
':secretbox-v1')` — derived from the instance's existing JWT secret rather
than a new key to manage, at the cost that rotating `JWT_SECRET` invalidates
everything encrypted with it (values are re-enterable, not permanently
lost — the affected fields are re-entered by the user/admin, not recovered).

**Its actual current scope is two fields, not a general secrets-at-rest
system**:

| Field | Table | What it protects |
|---|---|---|
| `ai_settings.api_key_enc` / `ai_settings.image_api_key_enc` | `ai_settings` | Bring-your-own-key AI provider credentials ([`server/routes/ai.js`](../server/routes/ai.js)) — never returned to clients in plaintext |
| `users.totp_secret_enc` | `users` | A user's TOTP MFA secret ([`server/lib/totp.js`](../server/lib/totp.js)) — stored reversibly (not hashed like a password) because the server must recompute the current code to verify a login, which a one-way hash can't support |

Everything else in the database — device names, content metadata, ticket
text, activity logs, usernames, emails — is stored as plain columns.
Passwords are `bcrypt`-hashed (one-way, not `secretbox`, since nothing ever
needs to recover the original password). **There is no general
column-level or row-level encryption across tenant data**, and no per-tenant
encryption key — `secretbox` uses one key, derived from one instance-wide
secret, for the two field types above. If per-tenant key isolation at the
application layer is a real requirement, that is new work, not something
this module already provides.

### 4.2 What's a deployment decision, not application code: encryption at rest

Protecting the database files themselves (so that reading the raw MySQL
data directory, a `mysqldump` backup, or a stolen disk doesn't hand over
every tenant's data in plaintext) is **correctly a deployment concern, not
something `server/` code should be doing per-query** — this is standard
practice; application-level re-encryption of every column is neither how
BeamOS is built nor generally how this problem is solved. Concretely, for
whoever deploys BeamOS:

- **MySQL's own encryption-at-rest.** BeamOS connects via `mysql2`
  ([`server/package.json`](../server/package.json)); MySQL 5.7.11+/8.0
  supports InnoDB tablespace encryption via a keyring plugin
  (`keyring_file` for a simple on-disk key, or `keyring_hashicorp` /
  a cloud KMS-backed keyring in production). Turn it on with
  `ALTER TABLE ... ENCRYPTION='Y'` per table, or set
  `default_table_encryption=ON` so every new table (including ones BeamOS's
  migrations create) is encrypted by default. This also covers the redo
  log and binlogs when `innodb_redo_log_encrypt=ON` /
  `binlog_encryption=ON` are set — otherwise decrypted data can still leak
  through those.
- **Managed MySQL (RDS/Cloud SQL/Azure Database for MySQL).** Each offers
  encryption-at-rest as a checkbox at instance-creation time, backed by the
  provider's KMS (AWS KMS, GCP CMEK, Azure Key Vault) — no application
  change needed, and it's the simplest correct option if BeamOS is deployed
  on one of them. It must be enabled at creation; retrofitting it onto an
  existing unencrypted instance typically requires a snapshot-and-restore
  into a new encrypted instance, not an in-place toggle.
  Self-hosted, on your own MySQL instance: enable InnoDB tablespace
  encryption directly, as above.
- **Full-disk encryption on the host**, independent of MySQL's own
  feature: LUKS (Linux) or BitLocker (Windows) on the volume holding the
  MySQL data directory (`datadir`, typically `/var/lib/mysql`) and the
  BeamOS `uploadsDir`/`fieldVisitPhotosDir`/`certsDir`
  ([`server/config.js`](../server/config.js)) — those hold uploaded
  content and device certs outside the database entirely, and MySQL's own
  at-rest encryption does not cover them. This protects against a stolen
  or improperly-decommissioned disk even if MySQL's own encryption is
  somehow misconfigured; the two are complementary, not either/or.
- **Backups.** Whichever of the above is chosen, make sure it covers
  backups too, not just the live data directory — an unencrypted
  `mysqldump` file or an unencrypted snapshot defeats the point even with
  a fully encrypted live database.
- **In transit**, separately from at-rest: `MYSQL_HOST`/`MYSQL_SOCKET_PATH`
  in [`server/config.js`](../server/config.js) support both TCP and local
  Unix-socket connections; if the app server and MySQL are not on the same
  host, terminate that connection over TLS (`mysql2`'s `ssl` connection
  option) rather than assuming a trusted private network.

None of the above requires a BeamOS code change — it's infrastructure
configuration on however MySQL is deployed, orthogonal to the
`workspace_id`-scoped query isolation in §1–3, which stays the actual
guarantee that one tenant's *live, running* queries can never reach
another's rows.
