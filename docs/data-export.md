# Data Export

BeamOS's tabular-export surface, documented as evidence for Ref 21. Written the
same way as [docs/browser-support.md](browser-support.md) and
[docs/rbac.md](rbac.md): what is actually built and proven, cited against real
code and real test runs, with the boundaries called out honestly.

Every "list" screen in the product that has a meaningful tabular form behind it
exposes a sibling `GET .../export` endpoint. Each one emits the **same rows**
in any of four formats — **CSV, XLSX, PDF, JSON** — selected by a `?format=`
query parameter. The format only changes the serialisation; the query, the
row set, and the access control are identical across all four.

## What can be exported

Thirteen endpoints, each backed by one query against the tables listed. The
"Scope" column is the access rule the endpoint enforces — it is the *same* rule
for all four formats, because all four run the one underlying query.

| Endpoint | Data | Backing tables | Scope |
|---|---|---|---|
| `GET /api/content/export` | Content library (filename, folder, MIME, size, dimensions, remote URL, shared-template flag) | `content` | Caller's active workspace, **plus** platform-template rows (`workspace_id IS NULL`) |
| `GET /api/widgets/export` | Widgets (name, type, created, shared-template flag) | `widgets` | Caller's active workspace, plus platform templates |
| `GET /api/kiosk/export` | Kiosk pages (name, created, shared-template flag) | `kiosk_pages` | Caller's active workspace, plus platform templates |
| `GET /api/layouts/export` | Layouts (name, template category, zone count, is-template, created) | `layouts`, `layout_zones` | Caller's active workspace + templates; `?templates=true` for templates only |
| `GET /api/playlists/export` | Playlists (name, description, item count, display count, zoned, created) | `playlists`, `playlist_items`, `devices` | Caller's active workspace |
| `GET /api/schedules/export` | Schedules (content/widget/playlist/group names, start/end, device & group IDs, created) | `schedules` + name joins | Caller's active workspace; optional `device_id`/`group_id`/`start`/`end` filters |
| `GET /api/walls/export` | Video walls (name, device count, grid dimensions, created) | `video_walls`, `video_wall_devices` | Caller's active workspace |
| `GET /api/activity/export` | Activity log (user, action, device, details, IP, workspace, timestamp) | `activity_log` | `platform_admin`/operator → all; everyone else → their own entries. Optional `device_id`. Capped at 10 000 rows |
| `GET /api/reports/export` | Proof-of-play — raw play events (device, content, started, ended, duration, completed) | `play_logs`, `devices` | Caller's workspace devices only; optional `device_id`/`start`/`end` |
| `GET /api/dashboard/content/export` | Content-delivery rollup (plays, total hours, completion %) per content item | `play_logs` aggregated | Caller's workspace devices only; optional `start`/`end` |
| `GET /api/dashboard/devices/export` | Device inventory + latest telemetry (status, heartbeat, battery, storage, RAM, Wi-Fi, uptime) | `devices`, `device_telemetry` | Caller's active workspace |
| `GET /api/organizations/:id/members/export` | Org roster (name, email, role, joined, invited-by, user ID) | `organization_members`, `users` | Any member of org `:id` (`canAccessOrg`) |
| `GET /api/workspaces/:id/members/export` | Workspace roster (name, email, role, direct/via-org, joined, user ID) | `workspace_members` (+ org-inherited) | Any member of workspace `:id` (`canAccessWorkspace`) |

The two `members/export` routes are gated per-request by a URL parameter
(`canAccessOrg` / `canAccessWorkspace` in
[`server/lib/permissions.js`](../server/lib/permissions.js)). The other eleven
act on the caller's *active* workspace, resolved by `resolveTenancy`
([`server/lib/tenancy.js`](../server/lib/tenancy.js)) from the session, and
filter every query by it.

## Formats

`?format=` accepts `csv`, `xlsx`, `pdf`, `json`. Anything else — or an omitted
parameter — falls back to `csv`.

| Format | Content-Type | Shape | Best for |
|---|---|---|---|
| `csv` | `text/csv; charset=utf-8` | UTF-8 with BOM, CRLF line endings, RFC-4180 quoting. `Content-Disposition: attachment` | Excel / Google Sheets / Numbers import, quick `grep`/`awk`, universal interchange |
| `xlsx` | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` | Single worksheet, bold header row, auto-fitted column widths. `attachment` | Handing a finished spreadsheet to someone — no import step, formatting preserved |
| `pdf` | `application/pdf` | A4 landscape table, repeating header row per page, font-metric column layout. `attachment`. Wide tables are truncated-with-ellipsis per cell; the footer says so | A human-readable report to print, attach to a ticket, or send to someone who will not open a spreadsheet |
| `json` | `application/json; charset=utf-8` | `{ "columns": [...], "rows": [[...], ...] }` — served inline, no `Content-Disposition` | Programmatic / API integration: pull the data into a script, a BI pipeline, another system. Numeric cells stay numbers (e.g. a play count is `12`, not `"12"`); `csv`/`xlsx`/`pdf` stringify everything |

`columns` in the JSON payload is exactly the CSV header row; `rows` is exactly
the CSV data rows, in the same order, before CSV's string coercion. XLSX and PDF
render the identical `headers` / `dataRows` too — PDF additionally substitutes a
dash for blank cells since it is read by a person, but the data is the same.

## Calling an endpoint

Authenticate the same way as any other API call — a session JWT in the
`Authorization` header. An `st_…` scoped API token also works for the nine
endpoints under token-reachable routers (`content`, `widgets`, `kiosk`,
`layouts`, `playlists`, `schedules`, `walls`, `activity`, `reports` — see
[`server/config/api-surface.js`](../server/config/api-surface.js)); the
`dashboard/*` and `members` exports are JWT-only. No other parameter is
required; `format` defaults to CSV.

### Example — JSON

```
$ curl -s 'https://<host>/api/playlists/export?format=json' \
       -H "Authorization: Bearer $TOKEN"
```

```json
{
  "columns": ["Name", "Description", "Item Count", "Display Count", "Zoned", "Created At (UTC)"],
  "rows": [
    ["Morning Loop", "lobby screens", 4, 2, "No", "2026-09-07 09:35:47 UTC"],
    ["Promo Reel", "", 9, 5, "Yes", "2026-09-06 14:02:11 UTC"]
  ]
}
```

### Example — the same query as CSV

```
$ curl -s 'https://<host>/api/playlists/export?format=csv' \
       -H "Authorization: Bearer $TOKEN"
```

```
Name,Description,Item Count,Display Count,Zoned,Created At (UTC)
Morning Loop,lobby screens,4,2,No,2026-09-07 09:35:47 UTC
Promo Reel,,9,5,Yes,2026-09-06 14:02:11 UTC
```

Row-for-row identical; `json` keeps `4` / `2` as numbers, `csv` writes them as
text.

## No cost or tier restriction

**None of these endpoints is gated by plan, tier, subscription state, or any
billing check.** Billing is disabled platform-wide: BeamOS runs with
`config.selfHosted` hardcoded `true`
([`server/config.js`](../server/config.js#L139)), which makes
`checkActiveSubscription` short-circuit to `next()`
([`server/middleware/subscription.js`](../server/middleware/subscription.js#L137))
and gives every account the enterprise plan. The export routes do not reference
`checkActiveSubscription`, `requirePlan`, or any feature flag in the first
place — the only middleware in front of them is `requireAuth` + `resolveTenancy`
(plus the per-request RBAC predicate on the two `members` routes). Export
availability is a function of *who you are* (which workspace you can see), never
*what you pay*.

## Real evidence: RBAC / workspace-scoping is enforced on every format

The claim that all four formats share one query and one access rule is backed by
automated tests that drive the **real** Express app (real `requireAuth` +
`resolveTenancy` + the real route files, mounted exactly as `server.js` mounts
them) over real HTTP against a real in-memory database — the same method
[docs/rbac.md](rbac.md) and [docs/browser-support.md](browser-support.md) use.
Re-run fresh for this document (2026-09-07):

```
$ node --test server/test/data-export-json.test.js \
               server/test/dashboard-content-export.test.js \
               server/test/tenancy-cross-tenant.test.js
# tests 25
# pass 25
# fail 0
```

**[`server/test/data-export-json.test.js`](../server/test/data-export-json.test.js)**
— the JSON format across a representative 5 of the 13 endpoints (`content`,
`widgets`, `playlists`, `walls`, `workspaces/:id/members` — the JSON branch is
the identical three lines in all 13 files):
- *`<endpoint>`: json shape + matches csv* — for each endpoint, `format=json`
  returns `application/json` as `{ columns, rows }`, and that payload is
  asserted **row-for-row equal** to what `format=csv` returns for the very same
  request (the CSV is parsed and compared cell by cell). Proves JSON reuses the
  exact `headers` / `dataRows` the other formats do — no second query, no second
  code path.
- *`<endpoint>`: tenant B json is workspace-scoped* — a second tenant's
  `format=json` export contains only that tenant's rows and **never** the first
  tenant's canary rows. Same isolation the CSV/XLSX/PDF paths already had,
  because it is the same `WHERE workspace_id = ?`.
- *`workspaces/:id/members/export`: RBAC — non-member gets 403 on json, same as
  csv* — a user with no path into the workspace is refused `format=json` **and**
  `format=csv` with the identical `403`, from the identical `canAccessWorkspace`
  gate.
- *unknown format still falls back to csv* — adding the `json` branch did not
  disturb the existing default.

**[`server/test/dashboard-content-export.test.js`](../server/test/dashboard-content-export.test.js)**
— pre-existing cross-tenant test for `GET /api/dashboard/content/export`,
decoding CSV, XLSX **and** PDF and asserting each contains only the caller's
workspace content, never the other tenant's. (Its JSON branch is covered by the
suite above.)

**[`server/test/tenancy-cross-tenant.test.js`](../server/test/tenancy-cross-tenant.test.js)**
— the broader guarantee that the workspace gate on `playlists` / `layouts` /
`schedules` / `video-walls` (the routers these exports live in) actually fires:
a second tenant gets `403` on every cross-tenant resource request.

### Live verification (2026-09-07)

Beyond the automated suite, the JSON branch was exercised against a **real
running server** (a fresh `node server.js` instance on the live MySQL database),
with two accounts registered through the actual `POST /api/auth/register` flow
(each auto-provisioned its own org + workspace):

- `GET /api/{widgets,playlists,walls,activity,dashboard/devices}/export?format=json`
  each returned `Content-Type: application/json; charset=utf-8` and the
  `{ columns, rows }` shape, with rows byte-for-byte matching the same
  endpoint's `format=csv` output (numeric cells numeric in JSON, stringified in
  CSV).
- `GET /api/workspaces/:id/members/export?format=json` and `…?format=csv` both
  returned `403 {"error":"Workspace access required"}` for the **non-member**
  tenant, and both returned the roster for the member — the RBAC gate does not
  distinguish format.
- Tenant B's `widgets` export (`json`) showed only Tenant B's widget, never
  Tenant A's — live cross-tenant scoping.
- `?format=xml` and no `format` param both still returned
  `Content-Type: text/csv` — unchanged fallback.

Both test accounts and all resources they created were removed afterward via the
real `deleteUserCascade` path
([`server/lib/user-deletion.js`](../server/lib/user-deletion.js)); confirmed gone
by a follow-up count. Nothing above is production data.

## Boundaries / what this is not

- **Row caps.** The workspace-list exports carry a safety ceiling
  (`EXPORT_ROW_CAP` — 5 000 for widgets / kiosk / layouts / playlists /
  schedules / video-walls, 10 000 for content; `activity` also caps at 10 000).
  These are not pagination — an export past the cap is silently truncated.
  Realistic workspace sizes are far below either, but a very large tenant should
  be aware. The `members` and `dashboard/*` exports have no cap (rosters and
  per-content rollups are inherently small).
- **No streaming.** Every format is built fully in memory before the response is
  sent. Fine for thousands of rows; not designed for hundreds of thousands.
- **Nested data is summarised, not exploded.** Layout zones become a count;
  playlist items become a count; a video wall's device grid becomes a count +
  `CxR` string. The export is a flat table, not a full object graph — use the
  regular JSON list endpoints (`GET /api/layouts/:id` etc.) for nested detail.
- **PDF truncates wide tables per cell** (with an ellipsis and a footer note).
  For complete, untruncated values use CSV, XLSX, or JSON — the footer says as
  much.
