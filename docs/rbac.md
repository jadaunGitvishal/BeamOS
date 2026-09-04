# Role-Based Access Control (RBAC)

BeamOS's authorization system, documented as evidence for Ref 5. Written the
same way as [docs/browser-support.md](browser-support.md) (Ref 24): what's
actually built and proven, cited against real code and real test runs, with
honest gaps called out rather than glossed over.

## The permission model, in plain language

Every authorization decision in the API funnels through
[`server/lib/permissions.js`](../server/lib/permissions.js) — nine functions,
each a yes/no predicate. Six read from the current request (`req`, already
populated by `resolveTenancy` — see
[`server/lib/tenancy.js`](../server/lib/tenancy.js)); three take an explicit
`(user, target)` pair for routes that act on a workspace/org named in the
URL rather than the caller's active one.

| Function | Checks | Used for |
|---|---|---|
| `canRead(req)` | Platform staff, OR org_owner/org_admin, OR *any* workspace role at all (viewer included) | "Can this person see this workspace's data?" |
| `canWrite(req)` | Platform staff, OR org_owner/org_admin, OR workspace_admin/workspace_editor | "Can this person create/edit content, playlists, tickets, etc.?" |
| `canAdmin(req)` | Platform **admin only** (not operator), OR org_owner/org_admin, OR workspace_admin | "Can this person manage this workspace itself — members, branding, provisioning?" |
| `canAdminWorkspace(db, user, workspace)` | Same tier as `canAdmin`, but for a workspace named by URL param instead of the caller's active one | Rename/delete a workspace, manage its members, generate device registration codes |
| `canAccessWorkspace(db, user, workspace)` | Read-access companion to the above — platform staff, org_owner/org_admin, or any workspace_members row | GET endpoints that target a workspace by URL param |
| `canWriteWorkspace(db, user, workspace)` | Write-access companion, sitting between the two above — platform staff, org_owner/org_admin, or workspace_admin/workspace_editor of the target workspace | Workspace-ticket routes reached by URL param |
| `canAccessOrg(db, user, org)` | Platform staff, or an `organization_members` row (org_owner or org_admin) | Read access to an org's settings/regions/members by URL param |
| `canAdminOrg(db, user, org)` | Platform admin, or **org_owner of this org specifically** (org_admin excluded) | Organization membership mutations — granting org_owner/org_admin is more consequential than workspace-level changes, so it's owner-only |
| `canManageOrgRegions(db, user, org)` | Platform admin, or org_owner/org_admin of this org | Create/rename/delete regions, assign a workspace to a region |

A tenth predicate, `isOrgAdmin`/`isOrgOwner`, backs the Express middleware
variants (`requireWorkspaceRead`, `requireWorkspaceWrite`,
`requireWorkspaceAdmin`, `requireOrgAdmin`, `requireOrgOwner`) that routes
attach directly rather than calling the boolean functions inline.

## Role hierarchy

Two independent tiers stack: an **organization** tier (org_owner, org_admin)
and a **workspace** tier (workspace_admin, workspace_editor,
workspace_viewer), plus a **platform** tier that sits above both.

| Role | Scope | Can... | Cannot... |
|---|---|---|---|
| **platform_admin** | Every org, every workspace | Everything — the only role `canAdmin`/`canAdminOrg`/`canManageOrgRegions` grant cross-org owner power to | — |
| **platform_operator** | Every org, every workspace (read/write, not admin) | View and write into any workspace's data (`canRead`/`canWrite` both include platform staff) for support purposes | Admin actions anywhere — member management, workspace/org rename, branding, regions, registration codes (deliberately excluded from every `canAdmin*`/`canManageOrgRegions` check) |
| **org_owner** | One organization, all its workspaces | Everything an org_admin can, **plus** grant/revoke org_owner and org_admin membership (`canAdminOrg` excludes org_admin from this specifically) | Reach into another organization |
| **org_admin** | One organization, all its workspaces | Manage every workspace in the org (read/write/admin — members, branding, provisioning, regions) without needing a `workspace_members` row in each one | Change who else is org_owner/org_admin (owner-only); reach another org |
| **workspace_admin** | One workspace | Everything workspace_editor can, **plus** manage that workspace's members, rename it, set branding, generate device registration codes | Manage org-level regions or org membership; touch other workspaces |
| **workspace_editor** | One workspace | Create/edit content, playlists, layouts, schedules, tickets | Manage workspace members, rename the workspace, generate registration codes, touch other workspaces |
| **workspace_viewer** | One workspace | Read everything — dashboards, content, playlists, tickets, devices | Any write action anywhere in that workspace |

## Capability matrix

| Capability | viewer | editor | ws_admin | org_admin | org_owner | operator | platform_admin |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| View devices, content, dashboards | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Create/edit content, playlists, layouts, schedules | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Create tickets / change ticket status | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Manage this workspace's members | ❌ | ❌ | ✅ | ✅ | ✅ | ❌ | ✅ |
| Generate device registration codes | ❌ | ❌ | ✅ | ✅ | ✅ | ❌ | ✅ |
| Manage org-level regions | ❌ | ❌ | ❌ | ✅ | ✅ | ❌ | ✅ |
| Grant/revoke org_owner or org_admin | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ✅ |
| Act across every workspace in the org without a membership row | ❌ | ❌ | ❌ | ✅ | ✅ | n/a¹ | ✅ |
| Access another organization entirely | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ (read/write, not admin) | ✅ |

¹ Operator visibility isn't org-scoped to begin with — it's every org, every
workspace, unconditionally (see `isPlatformStaff` in
[`server/middleware/auth.js`](../server/middleware/auth.js)).

## Sample role definitions

The concrete, "enterprise role management" style write-ups the RFP asks for —
these describe real, already-enforced behavior, not aspirational policy:

> **Workspace Viewer** — Store/site staff who need visibility but shouldn't
> change anything. Can see every screen's status, the content library,
> playlists, and open tickets in their assigned workspace. Cannot create,
> edit, or delete anything, cannot invite anyone, and has no visibility into
> any other workspace or organization.

> **Workspace Editor** — Day-to-day content operators. Can upload content,
> build and publish playlists, edit layouts, create and update tickets, all
> within their assigned workspace. Cannot manage who else has access to the
> workspace, cannot rename it or touch its branding, cannot generate device
> registration codes, and cannot see or act in any other workspace.

> **Workspace Admin** — The workspace's own IT/ops lead. Everything an Editor
> can do, plus manage that workspace's member list and roles, rename it, set
> its branding, and generate registration codes for new device installs.
> Still confined to that one workspace — no org-level or cross-workspace
> power.

> **Organization Admin** — Regional/multi-site management, e.g. an IT
> manager over several stores. Full admin (not just edit) rights in every
> workspace under the organization without needing to be individually added
> to each one, plus organization-level region management. Cannot change who
> holds org_owner/org_admin — that stays owner-only — and has no access
> outside the organization.

> **Organization Owner** — The customer's primary account holder. Everything
> an Org Admin can do, plus the authority to grant or revoke org_owner and
> org_admin membership itself. Scoped to their one organization only — no
> visibility into other tenants.

> **Platform Operator** — BeamOS support staff. Can view and act on data in
> any organization's workspace for support purposes (read/write), but is
> deliberately excluded from every admin-tier action — no member management,
> no branding, no regions, no registration codes — anywhere. A support
> engineer helping a customer cannot silently promote themselves or anyone
> else, or change who has account ownership.

## Real evidence: automated RBAC test coverage

Two already-built, already-shipped features carry dedicated RBAC test suites
that exercise the exact enforcement described above — not against mocked
permission functions, but real HTTP requests through the real Express routes
against a real (in-memory) database, asserting the actual status codes.
Re-run fresh for this document:

```
$ node --test server/test/regions.test.js server/test/tickets.test.js
# tests 27
# pass 27
# fail 0
```

**[`server/test/regions.test.js`](../server/test/regions.test.js)** — org-level region management (`canManageOrgRegions`):
- `RBAC: org_admin of org-a CANNOT touch org-b regions` — GET/POST/PATCH/DELETE all return 403 across the org boundary, including against a region the caller can see exists (via the other org's owner) but not touch.
- `RBAC: a workspace_admin (not an org member) cannot create a region` — confirms regions are an *org*-tier capability, not reachable from the workspace tier no matter how senior the workspace role is.
- `org_admin can create / list / rename their own org's regions` / `org_owner and platform_admin can also manage regions` — the positive cases for the same boundary.

**[`server/test/tickets.test.js`](../server/test/tickets.test.js)** — Operations/tickets (`canWriteWorkspace`, workspace-tier):
- `RBAC: viewer can read but not create or update` — a workspace_viewer's `GET` returns 200 with real ticket data, but `POST` (create) and `PATCH` (status change) both return 403 against the same workspace.
- `RBAC: non-member and other-org user get 403 on everything; cross-workspace denied` — a user with no relationship to the workspace, and a different workspace's admin, both get 403 on every verb, plus a 404 for a workspace that doesn't exist (not a 403 — doesn't leak existence).
- `RBAC: org_owner and platform_admin can manage without a workspace_members row` — confirms the org-tier short-circuit works even with zero direct workspace membership.

## Live verification

Real browser sessions (Chrome via CDP, the approach used throughout this
engagement), logged in as two real accounts provisioned through the actual
`POST /api/admin/users` admin-provisioning endpoint — one
`workspace_editor`, one `workspace_viewer` — both in the same real workspace,
looking at the same real ticket.

**Operations page, workspace_editor session:**
The ranked queue shows an "ACTION" column with a "Change" button per
ticket.

**Operations page, workspace_viewer session — same ticket, same workspace:**
The page subtitle reads *"...ranked by priority then age — read-only for
your role."* The "ACTION" column and its "Change" button are **not present
in the DOM at all** (confirmed via a DOM query, not just visually) — this is
[`OperationsView.jsx`](../frontend/dashboard-src/src/views/OperationsView.jsx)'s
`canWrite` check (line 56) conditionally rendering the column
(`{canWrite ? <th className="r">Action</th> : null}`, line 244) rather than
rendering-then-disabling it.

Both sessions were confirmed via `GET /api/auth/me` to genuinely be running
as their assigned role (`current_workspace_role: workspace_editor` /
`workspace_viewer`) before the screenshots were taken, and both loaded with
zero console errors.

**Content Library page, workspace_viewer session — a genuine finding, found
and fixed in this pass:** unlike Operations, the Content Library page did
*not* hide its per-item **Delete** button for a viewer — only the per-item
**Edit** button was conditionally rendered
(`frontend/js/views/content-library.js`, `state.canEdit`). A viewer looking
at this page saw a write-shaped Delete button that Operations would never
have shown.

The server was always the real authority regardless — verified live, not
assumed, by driving the exact requests that visible button would send, from
an authenticated workspace_viewer session, both before and after the fix:

```json
// DELETE /api/content/:id as workspace_viewer
{ "status": 403, "body": { "error": "Read-only access" } }
```

So there was never a security gap — every write path re-checks the role
server-side independent of what the UI shows — but the UI-polish gap itself
is now closed: the Delete button is wrapped in the same `state.canEdit`
check as Edit, so it's genuinely absent from the DOM for a viewer, not just
inert. Confirmed live with a real editor session and a real viewer session
on the same real content item:

| | Edit button | Delete button |
|---|:-:|:-:|
| workspace_editor session | present | present |
| workspace_viewer session | absent (unchanged) | **absent (fixed - was present)** |

and that the fix didn't touch editor functionality: the same editor session
clicked the (real, two-step confirm) Delete button on a disposable test item
and it was genuinely gone afterward, confirmed by re-querying the content
list.

One narrower gap remains, deliberately not touched by this fix: the Upload
area and the "Add Remote URL"/"Add YouTube Video" forms at the top of the
page are still shown unconditionally to every role (they were never part of
this specific finding, which was scoped to the per-item Delete button). A
viewer could still click "Add Remote URL" and get a real 403 back — server-enforced,
same as Delete was — just not yet hidden. Worth its own follow-up if full
parity with Operations' affordance-hiding is wanted.

*(All test accounts created for this document's live verification —
including the ones used for the Content Library re-check above — have been
fully deleted via the real `deleteUserCascade` admin path (`DELETE
/api/auth/users/:id`), not left as orphaned rows; confirmed gone via a
post-delete lookup. The demo ticket used earlier was closed. Nothing in
this section is live production data.)*

## Known gap: no Azure AD / Entra ID group-to-role mapping

**This is a real, confirmed gap — not a vague disclaimer.** Two genuinely
different things live under "Microsoft" in this codebase, and only one of
them exists:

- **Microsoft SSO login** (`POST /api/auth/microsoft` in
  [`server/routes/auth.js`](../server/routes/auth.js)) — real, built, and
  working. A user authenticates via Microsoft/Entra, and BeamOS verifies
  their identity through Microsoft Graph. On first login it creates a
  BeamOS account with the default `user` role and drops them into a default
  organization/workspace (`ensureDefaultOrgForUser`) — from there, a human
  admin assigns their real workspace/org role by hand, the same as any
  other user.
- **Azure AD / Entra ID *group*-to-*role* mapping** — reading a user's
  Entra security-group memberships and automatically assigning/updating
  their BeamOS role (e.g. "member of `IT-Regional-Managers`" →
  `org_admin`) — **does not exist anywhere in this codebase.** There is no
  group-claims parsing, no mapping configuration, and no code path that
  ever sets a role from anything other than a human calling the
  admin/invite/member-management endpoints.

This is correctly scoped as a **conditional, "if the host requires it"
enterprise integration** — distinct from, and not a prerequisite for, the
core RBAC system documented above, which is fully built, enforced
server-side on every route, and proven by the test suite and live sessions
in this document. If Entra group-to-role provisioning is a hard requirement,
it is new work: parsing group claims from the Microsoft token exchange, a
mapping configuration surface (which groups map to which role, per org),
and a sync path that keeps role assignments current as group membership
changes.

## Secondary finding: billing actions were not role-gated (now fixed)

While tracing every write path for this document, one more real gap
surfaced, adjacent to but distinct from the Azure AD gap: [`permissions.js`
documented an intended tier](../server/lib/permissions.js#L11) — *"org_owner
also has billing.write... not exposed in 2.1"* — but
[`server/routes/stripe.js`](../server/routes/stripe.js)'s `/checkout` and
`/portal` routes were gated with plain `requireAuth` only. Any authenticated
member of an organization — including a workspace_viewer — could open a
Stripe checkout or billing-portal session for that org, not just an
org_owner.

**Fixed in the same pass**: both routes now chain `resolveTenancy` +
`canAdminOrg` (the same owner-only predicate `routes/organizations.js`
already uses), with a `platform_admin` override. Verified with a full role
sweep in
[`server/test/stripe-billing-access.test.js`](../server/test/stripe-billing-access.test.js)
(org_owner and platform_admin succeed; workspace_admin/editor/viewer and a
non-member all get `403 Organization owner access required`; a second org's
own owner still succeeds for their own org) and live against the real dev
server with real accounts (org_owner correctly reaches the next-stage `503
Stripe not configured` — proving the gate passed them through — while a
freshly-created workspace_viewer and workspace_admin both got a real
`403`). The frontend's billing view (`frontend/js/views/billing.js`) was
updated to match — it now resolves `/auth/me` before first render and hides
the Upgrade/Manage-subscription buttons entirely for non-owners, the same
`canEdit`-style pattern used elsewhere, rather than rendering write buttons
a non-owner's click would 403 on.

**A separate, still-open bug surfaced during this verification**, unrelated
to RBAC: `requireAuth`'s own `SELECT` (`server/middleware/auth.js`) never
fetches `stripe_customer_id` or `stripe_subscription_id`, so `req.user`
never actually carries them on any request. In practice this means
`/portal` 400s with "No billing account found" for every caller regardless
of real billing history, and `/checkout` never detects an existing
subscription (always creates a fresh Stripe customer + new checkout
session instead of redirecting an existing subscriber to the portal). This
predates the access-control fix above and is independent of it — the org_owner
role gate now correctly lets an owner *reach* these handlers, but the
handlers themselves have this separate, pre-existing data bug. Not fixed
here (out of scope for an RBAC pass) — flagged for a follow-up.
