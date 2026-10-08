# Audit Logging

What BeamOS writes to its audit log (`activity_log`), and what it deliberately
does not write. Covers Ref 17 (mutations, authorization failures, retention,
tamper evidence) and Ref 20 (data exports and sensitive reads). Written in the
same style as [docs/data-export.md](data-export.md): what is built and tested,
cited against real code, with the known gaps stated plainly.

## Where entries come from

Every audit row is written by `logActivity()` in
[`server/services/activity.js`](../server/services/activity.js), which goes
through `appendEntry()` in
[`server/lib/activity-chain.js`](../server/lib/activity-chain.js). That is the
only writer, so every row is part of the hash chain (see
[Tamper evidence](#tamper-evidence)). Writes are fire-and-forget: they land
just after the response is sent, and a failed write is logged to the console
but never fails the request.

Each row records `user_id`, `workspace_id`, `device_id`, `ip_address` (the real
client IP, see `getClientIp()`), `action`, `details` and `created_at`.

`action` always uses the **route pattern**, never the concrete URL. For example,
the action is `/api/workspaces/:id/members/export` and not
`/api/workspaces/84ec…/members/export`. Ids and query strings therefore never
appear in `action`.

| Entry | Written by | When |
|---|---|---|
| `POST\|PUT\|PATCH\|DELETE <route>` | `activityLogger` | A successful (status < 400) mutation that responds with `res.json` |
| `ACCESS_DENIED <method> <route>` | `activityLogger` | Any response with status 403. `details` holds the server's refusal reason only, never the request body |
| `EXPORT <route>` | `activityLogger` (Ref 20) | A file download (see below) |
| `READ <route>` | `auditRead` (Ref 20) | One of the 6 sensitive reads listed below |
| Named events (`auth:login_failed`, `account_linked_microsoft`, …) | The route itself, via `logActivity` | Route-specific |

`activityLogger` is mounted in [`server/server.js`](../server/server.js) before
every workspace, tenancy and API router, and before `/api/status`.

## Data exports (`EXPORT`)

Every file download is logged from one central place, and no export route
contains audit code. `activityLogger` attaches a single `close` listener to every
request. When the response closes, it writes an `EXPORT` entry only if both of
these are true:

- the status is below 400, and
- the response carries a `Content-Disposition` header containing `attachment`.

This covers all 17 attachment responses in `server/routes`. 16 of them are
`GET` routes; `POST /api/reports/custom/export` is the only `POST`, which is why
the listener is attached for every method rather than `GET` only. It covers
buffered files (`res.send`), JSON sent as a download (`GET /api/status/export`)
and streamed responses (the `/api/status/backup` mysqldump and the zip from
`/api/status/export?include_files=true`).

Example rows from the test run:

```
EXPORT /api/activity/export        file=activity-log-2026-10-06.csv, format=csv, filters=[device_id,format], outcome=completed
EXPORT /api/reports/export         file=proof-of-play.pdf, format=pdf, filters=[device_id,format,start], outcome=completed
EXPORT /api/status/backup          file=beamos-backup-2026-10-06.sql, format=sql, filters=[], outcome=completed
```

What the `details` fields mean:

| Field | Meaning |
|---|---|
| `file` | The file name from the `Content-Disposition` header. The server sets this name, so it can contain an id that is already part of the name (members exports, for example) |
| `format` | The file name's extension (`csv`, `xlsx`, `pdf`, `sql`, `json`, `zip`, …). If the name has no extension, it is taken from `Content-Type`; failing that, it is `unknown` |
| `filters` | The **names** of the query parameters, sorted. Values are never recorded, and neither are request bodies, so a `POST` export logs `filters=[]` |
| `outcome` | `completed` if the whole response was handed to the OS (`res.writableFinished`). `aborted` if the connection closed first, for example when the client cancelled the download mid-stream |

The other fields:

- `user_id` is the authenticated user. For an API token (`st_…`) this is the
  token's owner. For an Entra service principal it is the admin who registered
  it. In both cases, that is the user the request runs as (`req.user`).
- `workspace_id` is the request's resolved workspace (`req.workspaceId`).
- `device_id` is set only when the route has an explicit `:deviceId`
  parameter. Otherwise it is `null`. A generic `:id` (an organization,
  workspace or resource id) is deliberately not copied.

A refused export, such as a `403` because the caller isn't a member of the
workspace, produces only the existing `ACCESS_DENIED` entry. It never also
produces an `EXPORT` entry, because the status check rejects it.

## Sensitive reads (`READ`)

These 6 routes record one `READ <route>` entry per successful request. The
`auditRead` middleware is placed after each route's own auth/permission
middleware.

| Route | Data | Who can read it |
|---|---|---|
| `GET /api/activity` | The audit log | Any user (their own entries); platform staff (all entries) |
| `GET /api/activity/verify-integrity` | Integrity report for the audit chain | `admin` / platform roles |
| `GET /api/auth/users` | User directory | `admin` / platform roles |
| `GET /api/admin/users/:id/workspaces` | A user's workspace memberships | Platform admins |
| `GET /api/organizations/:id/members` | Org roster | Members of that org |
| `GET /api/workspaces/:id/members` | Workspace roster | Members of that workspace |

A `READ` entry has no `details`. It contains no response data and no query
values. It is written on the response's `finish` event, and only when the
status is below 400, so a refused read produces `ACCESS_DENIED` only. (See
[Known issues](#known-issues) for `/api/auth/*`, where refusals are not logged
at all.) For `/verify-integrity`, writing the entry after the response means it
can never be part of the chain that request was verifying.

### What is deliberately not logged

Ordinary reads are not audited: list and detail `GET`s, dashboards, overview
JSON, polling endpoints, device heartbeats, render endpoints and so on. They are
very frequent, and much of it is automatic polling by the dashboard and players.
Logging them would bury the security-relevant entries, grow the table by orders
of magnitude, and contend on the chain's single row lock, which every append
serializes through. The audited reads were picked because they expose
identities, rosters or the audit trail itself. Data leaving the system in bulk
is covered by `EXPORT`.

### Viewing or exporting the audit log is itself logged

- `GET /api/activity` writes `READ /api/activity/`.
- `GET /api/activity/verify-integrity` writes `READ /api/activity/verify-integrity`.
- `GET /api/activity/export` writes `EXPORT /api/activity/export`.

This does not loop. `logActivity` writes straight to the database and never
makes an HTTP request, so each such request produces exactly one entry.

## Retention

Rows older than `AUDIT_LOG_RETENTION_DAYS` (default 365, and values below 365
are raised to 365) are deleted only by the manual admin action
`DELETE /api/activity/prune`. Nothing runs automatically. See
[Retention pruning](#retention-pruning) for how a prune keeps the chain
verifiable.

## Tamper evidence

Each row's `entry_hash` is SHA-256 over `prev_hash`, `user_id`, `action`,
`details`, `ip_address` and `created_at`. `prev_hash` links each row to the row
before it. `GET /api/activity/verify-integrity` (optionally with
`?start_id=&end_id=`) walks the chain and reports altered, unlinked or missing
rows. See `lib/activity-chain.js` for the exact serialization.

## Retention pruning

`DELETE /api/activity/prune` is manual and limited to the elevated admin roles,
as before. It waits for the prune to finish and returns
`{ success: true, pruned, anchor_id, cutoff }`. If the prune fails, nothing is
removed, the error is logged on the server, and the route returns `500`
`{ error }` (never `success: true`).

**What is removed.** The cutoff is now minus the retention period. A prune
removes one block of rows in `id` order from the start of the chain: every row
whose `id` is lower than that of the first row (in `id` order) whose
`created_at` is at or after the cutoff. It never deletes by `created_at` alone.
A row with an old timestamp but a higher `id` than an in-window row survives,
so a prune can't leave a gap in the middle of the chain. If no row is inside
the window, every row is removed, and the new `audit:pruned` entry is the only
row left. If nothing is old enough, nothing changes: the response has
`pruned: 0` and no `audit:pruned` entry is written.

**The checkpoint.** `activity_log_chain` has three more columns:

- `anchor_id` and `anchor_hash`: the `id` and `entry_hash` of the newest row the
  last prune removed. The first remaining row's `prev_hash` points at this hash.
- `pruned_count`: the total number of rows ever pruned. `entry_count` still
  counts every row ever chained, so `entry_count - pruned_count` rows should
  exist.

On a database that predates them, the startup schema check
(`lib/schema-check.js`) adds the three columns, leaving the anchors `NULL` and
`pruned_count` at `0`, which means "never pruned". It logs each column it adds
and does nothing on later runs.

**The `audit:pruned` entry.** Each prune appends a normal chained entry with
action `audit:pruned`. Its `user_id` is the admin who ran the prune, and its
`details` is JSON:
`{"cutoff", "removed", "anchor_id", "anchor_hash", "pruned_count_total"}`.
The delete, the checkpoint update and this entry are written in one
transaction, holding the same `activity_log_chain` row lock as every append.
Concurrent audit writes wait for the prune and then chain after its entry. If
any step fails, all of it rolls back.

**How verification uses it.** `verify-integrity` starts the chain at
`anchor_hash` instead of the genesis hash, requires the first remaining row's
`id` to be above `anchor_id`, and expects `entry_count - pruned_count` rows. A
ranged check that starts at or before the first remaining row uses the anchor
the same way. After a prune, the response also carries a `checkpoint` object.

The checkpoint is also cross-checked against the newest `audit:pruned` entry.
They must agree on `anchor_id`, `anchor_hash` and the total pruned count.
Verification reports the new failure type `checkpoint_mismatch` when:

- they disagree (for example `anchor_hash` or `pruned_count` was edited);
- the checkpoint is set but no `audit:pruned` entry exists (it was deleted);
- `audit:pruned` entries exist but the checkpoint is empty;
- a row at or below `anchor_id` is still present.

The other kinds of tampering show up as the existing failure types:

- Editing an `audit:pruned` entry's `details` gives `content_altered`.
- Deleting further rows from the start gives `broken_link` and
  `count_mismatch`.

A database that has never been pruned verifies exactly as before.

Rows that were already damaged are not repaired: a prune neither re-hashes nor
rewrites any row. For example, rows damaged by the earlier user-deletion issue
(see [User deletion](#user-deletion)) keep failing verification until a prune
removes them with the rest of their block.

## User deletion

Deleting a user does not change any of their audit rows' hashed columns.
`user_id` and `acting_user_id` keep the deleted user's id, so the hash chain
stays valid. What is deleted with the user is their `users` row, which holds
their name and email. The audit view (`GET /api/activity`, its export, and the
Activity page) labels those rows **"Deleted user"**, and the email comes back
empty.

How this works:

- `activity_log` has no foreign keys to `users`, which is what lets a row
  reference a user who no longer exists. `schema.sql` doesn't declare them.
  On an existing database, the startup schema check
  (`dropUserForeignKeys` in
  [`server/lib/schema-check.js`](../server/lib/schema-check.js)) looks up any
  `activity_log` foreign keys that reference `users` in `information_schema`
  and drops them. It logs each one it drops, keeps the indexes, and does
  nothing once none are left.
- `deleteUserCascade`
  ([`server/lib/user-deletion.js`](../server/lib/user-deletion.js)) no longer
  sets `activity_log.user_id` / `acting_user_id` to `NULL`.
- Deleting an organization or workspace still sets `workspace_id` /
  `organization_id` to `NULL` on audit rows. Those columns are not hashed, so
  the chain is unaffected.

**Limitation: rows damaged before this fix can't be repaired.** Before the fix,
deleting a user nulled `user_id` on their rows. Those rows will keep failing
verification as `content_altered`, because the original id is gone and
re-hashing them would defeat the point of the chain. Production has no data
yet, so it isn't affected. A local or test database can be reset. A local
development database checked on 2026-10-06 had about 3,000 such rows from test
cleanups, so a whole-chain verification there reports `ok: false`.

**Privacy note.** Some `details` strings contain email addresses. Examples are
`auth:login_failed`, `auth:login_success`, `account_linked_microsoft`, SCIM
provisioning events, and `delete_user` (which records the deleted user's
email). `details` is part of the row hash, so these can't be scrubbed when a
user is deleted without breaking the chain. They are removed only when
retention pruning deletes the row.

## Known issues

These are documented here and not fixed.

1. **Refused `/api/auth/*` requests are not logged.** `/api/auth` is mounted
   before `activityLogger` in `server.js`, so a `403` there (for example a
   non-admin calling `GET /api/auth/users`) produces no `ACCESS_DENIED` entry.
   Successful `GET /api/auth/users` reads are still logged, because `auditRead`
   is attached to that route directly. Login failures have their own
   `auth:login_failed` entries.
2. **A mysqldump that fails mid-stream is logged as completed.**
   `/api/status/backup` pipes mysqldump's stdout into the response. If
   mysqldump exits non-zero after the headers are sent (bad credentials, a
   lost connection), stdout simply ends: the response still finishes with
   status `200`, so the entry says `outcome=completed` even though the file is
   empty or truncated. The failure appears only in the server console
   (`[backup] mysqldump exited …`).

## Tests

[`server/test/audit-data-access.test.js`](../server/test/audit-data-access.test.js)
uses the real app in-process against real MySQL. It covers:

- CSV, XLSX and PDF exports, each with a distinctive filter value that is
  checked to be absent from `details`;
- an API-token export;
- the `POST` custom report;
- the JSON `/api/status/export` and the streamed `/api/status/backup`;
- an interrupted download (`aborted`);
- a refused export (`ACCESS_DENIED` only);
- all 6 `READ` routes;
- a refused read;
- ordinary `GET`s producing no entry;
- a chain verification over the rows the test wrote.

[`server/test/audit-user-deletion.test.js`](../server/test/audit-user-deletion.test.js)
covers:

- deleting a user through the real admin route: their rows keep `user_id` and
  `acting_user_id`, and the chain over those rows verifies;
- the "Deleted user" label in the audit list and export;
- organization and workspace deletion still nulling `workspace_id` /
  `organization_id` without breaking the chain;
- the foreign-key repair on a scratch table (and that a second run is a no-op);
- the startup repair's result on the real `activity_log`.

[`server/test/audit-prune.test.js`](../server/test/audit-prune.test.js) runs
against a scratch MySQL database that it creates and drops, so the real audit
log is never pruned. It covers:

- full and ranged verification after a prune;
- two prunes in a row;
- nothing old enough to prune, and everything old enough;
- an out-of-order timestamp (no gap in the middle of the chain);
- audit writes that run during a prune;
- rollback when the prune fails partway;
- tamper detection after a prune;
- unchanged verification for a chain that has never been pruned;
- the route: `403` for non-admins, the counts, a `500` on failure, and the
  audit entries the route writes;
- the startup column repair.
