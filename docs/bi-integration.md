# BI Tool Integration (Power BI / Tableau)

Ref 73. A guide for connecting an external analytics tool (Power BI Desktop/
Service, Tableau Desktop/Server, or anything else that speaks HTTP) to
BeamOS's read data over the same scoped API-token mechanism used everywhere
else in the public API. Written the same way as
[docs/data-export.md](data-export.md) and [docs/rbac.md](rbac.md): what is
actually built, cited against real code, with the boundaries called out
honestly.

This is not a separate integration layer. It reuses the existing public
API-token door ([`server/middleware/apiToken.js`](../server/middleware/apiToken.js),
[`server/config/api-surface.js`](../server/config/api-surface.js)) and the
same `?format=json → { columns, rows }` convention
[docs/data-export.md](data-export.md) already documents for exports — Ref 73
opened a few previously JWT-only read endpoints onto that same token door
(SLA, tickets, SIM inventory) and added pagination to the one endpoint that
needed it (proof-of-play).

For a **data platform** (Snowflake, Databricks, dbt, Atlan) instead of a BI
tool that pulls over HTTP, see
[docs/data-platform-integration.md](data-platform-integration.md). Ref 28's
connector pushes the same device/uptime/SLA/proof-of-play/ticket/SIM data to
an S3-compatible landing zone as gzipped NDJSON on a schedule.

## 1. Create a read-scoped API token

Any workspace member can mint their own token from the dashboard
(Settings → API Tokens, or `POST /api/tokens` directly). For a BI connection,
use scope `read` — it can `GET` everything below and nothing else (no
`POST`/`PUT`/`PATCH`/`DELETE`, enforced by `tokenScopeGate`, independent of
whatever role the token's owner actually holds).

```
POST /api/tokens
Authorization: Bearer <your dashboard session JWT>
Content-Type: application/json

{ "name": "Power BI - PMI analytics", "scope": "read" }
```

The response's `token` field (`st_...`) is shown **once** — store it in
Power BI's / Tableau's credential store, not in a shared file. A token is
bound to the workspace that was active when it was created; it can never be
redirected to another workspace (`X-Work­space-Id` / `?workspace_id=` are both
stripped for token callers — [`middleware/apiToken.js:68-72`](../server/middleware/apiToken.js#L68-L72)).
One token per workspace you want to report on.

## 2. Power BI Desktop — Web connector

1. **Get Data → Web**.
2. Choose **Advanced**.
3. URL parts: `https://<your-beamos-host>/api/<endpoint>` (see the table
   below; add query parameters as separate URL-part rows or directly in the
   base URL).
4. Under **HTTP request header parameters**, add one row:
   - Name: `Authorization`
   - Value: `Bearer st_<your token>`
5. **OK** → Power Query loads the JSON. Endpoints below that aren't already
   `{ columns, rows }` (devices, tickets, SLA, SIM inventory) come back as a
   plain array/object; use **Into Table** → **Expand** as usual, or point at
   an `?format=json` export for the already-flat `{ columns, rows }` shape.

For a scheduled refresh (Power BI Service), the same header setup applies
when publishing the credential as an **Anonymous** data source with the
header baked into the query (Power BI has no native "Bearer token" HTTP
auth type at the time of writing — the header-based Web connector is the
standard workaround for any Bearer-token API).

## 3. Tableau — Web Data Connector / custom HTTP

Tableau's REST/Web Data Connector paths that support custom headers (e.g. a
WDC script, or `Text Table` / `Other Databases (ODBC)` are not applicable
here — this is a REST JSON API, not ODBC/JDBC) should set:

```
Authorization: Bearer st_<your token>
```

as a static request header. If your Tableau version's connector UI doesn't
expose custom headers directly, a thin WDC script (a few lines of JS) that
sets the header and calls `tableau.submit()` after receiving the JSON is the
standard pattern — the endpoints below return plain JSON either way, so no
BeamOS-specific parsing is needed.

## 4. What's reachable

| Endpoint | Data | Scope | Notes |
|---|---|---|---|
| `GET /api/devices` | Device inventory + latest telemetry | read | Real pagination: `?limit=` (≤500) `&offset=` |
| `GET /api/reports/uptime` | Per-device uptime % (heartbeat estimate) | read | `?start=&end=&device_id=` |
| `GET /api/reports/plays` | Raw proof-of-play rows | read | **Ref 73**: `?limit=&offset=`, capped at 5000/page; `X-Total-Count` response header |
| `GET /api/reports/export?format=json` | Proof-of-play, `{columns,rows}` | read | **Ref 73**: same pagination as `/plays`; omit `limit`/`offset` for the full unbounded range (unchanged desktop-download behavior) |
| `GET /api/dashboard/reports/sla-overview` | Per-device SLA compliance, MTTR, live breaches | read | **Ref 73 — newly public**. `?start=&end=` |
| `GET /api/dashboard/reports/sla-trend` | Daily fleet-wide uptime % trend | read | **Ref 73 — newly public**. `?days=` (1-365) |
| `GET /api/tickets` | Operational tickets (read-only) | read | **Ref 73 — new endpoint**. `?status=&priority=&owner_category=&ticket_category=` |
| `GET /api/tickets/sla-summary` | Ticket response-time SLA rollup | read | **Ref 73 — new endpoint** |
| `GET /api/tickets/{id}` | Single ticket | read | **Ref 73 — new endpoint** |
| `GET /api/sim-inventory` | Physical SIM stock ledger | read | **Ref 73 — newly public**. `?status=&carrier=` |
| `GET /api/sim-inventory/{id}` | Single SIM record | read | **Ref 73 — newly public** |

Full parameter/response reference: [`docs/openapi.yaml`](openapi.yaml)
(served interactively at `/docs`) — every row above has a matching path
there now.

### What is deliberately still out of reach

Ticket **creation and updates**, workspace/organization management, billing,
and every other privileged surface stay JWT-only
([`server/config/api-surface.js`](../server/config/api-surface.js)'s
`JWT_ONLY_ROUTERS`, with `/api/workspaces` specifically pinned there by an
automated firewall test's `MUST_BE_PRIVATE` list —
[`server/test/api.test.js`](../server/test/api.test.js)). A read-scope token
cannot write anywhere; a write/full-scope token can create/update SIM
inventory records (if its owner is a `workspace_admin` — the route's own
gate) but still cannot touch tickets or SLA settings, since those routers
expose no write handlers to the token door at all.

## 5. Example requests

```
$ curl -s 'https://<host>/api/dashboard/reports/sla-overview?start=2026-08-01&end=2026-08-31' \
       -H "Authorization: Bearer st_..."

$ curl -s 'https://<host>/api/tickets?status=open&priority=high' \
       -H "Authorization: Bearer st_..."

$ curl -s 'https://<host>/api/sim-inventory?status=active' \
       -H "Authorization: Bearer st_..."

$ curl -si 'https://<host>/api/reports/plays?limit=500&offset=1000&start=2026-01-01' \
       -H "Authorization: Bearer st_..." | grep -i x-total-count
```

## 6. Refresh scheduling considerations

- **Tokens do not expire — unless your organization sets a maximum
  lifetime (Ref 34).** By default (`max_token_lifetime_days` = `null`) a
  token stays valid until someone revokes it (`DELETE /api/tokens/{id}`, or
  via the dashboard). An org owner/admin can set a cap in days (see
  [Maximum token lifetime](#maximum-token-lifetime-ref-34) below). Once a
  token's **age** (now − `created_at`) reaches the cap, every call returns
  `401 {"error":"Invalid or expired API token"}`. That is the same status and
  shape as a revoked token, so a refresh job's existing auth-failure handling
  covers it. **Plan for rotation** when a cap is set: `GET /api/tokens` shows
  each token's `expires_at` (epoch seconds, or `null` if uncapped) and
  `expired`. Mint the replacement and update the BI data source before
  `expires_at`, or the scheduled refresh starts failing. Whether or not a cap
  is set, a leaked token works until it is revoked or ages out. Treat the
  token string like a password and revoke+reissue it if it is ever exposed
  (e.g. committed to a repo, pasted into a support ticket).
- **Rate/volume**: no dedicated rate limit sits in front of these specific
  GET routes beyond the platform's general limiter; a refresh cadence in the
  minutes range (not sub-second polling) is the reasonable default.
- **Pagination and incremental refresh**: `/reports/plays` and
  `/reports/export` are the only endpoints here large enough to need paging.
  For a Power BI incremental-refresh policy or a Tableau extract schedule,
  filter by `start`/`end` per period (e.g. one day/month per extract
  partition) rather than paging a single unbounded pull — same approach
  [docs/data-export.md](data-export.md) already recommends for the other
  row-capped exports.
- **Timestamps** are Unix epoch seconds in raw list/detail responses and
  ISO-8601 UTC strings in the CSV/XLSX/PDF/JSON export shapes
  ([docs/data-export.md](data-export.md)) — normalize once in Power
  Query/Tableau's data-source step, not per report.

### Maximum token lifetime (Ref 34)

An organization owner/admin sets one cap for every `st_` API token in the
organization's workspaces. The same cap also covers the organization's SCIM
tokens ([docs/sso-scim-integration.md](sso-scim-integration.md#maximum-scim-token-lifetime-ref-34)).

```bash
# Read (org_owner / org_admin of the org, or platform admin; session JWT)
curl -s https://<host>/api/organizations/<org id>/token-policy -H "Authorization: Bearer $JWT"
# -> {"organization_id":"…","max_token_lifetime_days":null}

# Set a 90-day cap (integer 1–3650), or {"max_token_lifetime_days":null} to remove it
curl -s -X PATCH https://<host>/api/organizations/<org id>/token-policy \
  -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
  -d '{"max_token_lifetime_days":90}'
```

How it behaves:

- **It is retroactive and takes effect immediately.** The cap is not
  stamped onto tokens when they are minted. `apiTokenAuth` compares each
  token's age with the org's **current** cap on every request. If you lower
  the cap, tokens minted before the policy existed stop working on their
  next call when they are already older than the new cap. No backfill and no
  per-token action are needed.
- **Raising or removing the cap re-admits tokens that were refused only
  because of their age.** Age expiry is a policy, not a revocation. To kill a
  specific token for good, revoke it.
- `expires_at` in `GET /api/tokens` (and in the `POST` response) is computed
  from the current cap on each request, so it changes if the cap changes.
- **Not covered by the cap:**
  - **Entra ID Service Principals (Ref 9).** BeamOS stores no secret for
    them, only the SP's `client_id`. Every call brings its own short-lived
    access token issued by Entra, and `middleware/entraToken.js` rejects it
    once its `exp` has passed. Entra already bounds that lifetime. The
    long-lived credential (the SP's client secret or certificate) lives in
    Entra, and its expiry is set there.
  - **Browser sessions** (`jwtExpiry`, 7 days). These are interactive human
    logins, not programmatic access. They already have their own fixed
    expiry.
