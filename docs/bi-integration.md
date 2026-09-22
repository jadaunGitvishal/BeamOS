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

- **Tokens do not expire.** `api_tokens` has no `expires_at`/TTL column — a
  token is valid indefinitely until someone explicitly revokes it
  (`DELETE /api/tokens/{id}`, or via the dashboard). There is no separate
  "Ref 34 token-lifetime" mechanism in this codebase to reference; this is
  simply the current, deliberate design (revoke-only, no rotation). For a
  scheduled BI refresh this is actually convenient — no re-authentication
  flow to build — but it also means a leaked token stays valid until someone
  notices and revokes it. Treat the token string with the same care as a
  password, and revoke+reissue it if it's ever exposed (e.g. committed to a
  repo, pasted into a support ticket).
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
