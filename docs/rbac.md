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
| **regional_viewer** (org role, Refs 49/67) | The workspaces inside its region scopes | Read everything in those workspaces, exactly like a workspace_viewer there, including exports | Any write action; field-visit logging; anything org-wide (members, regions, settings); workspaces outside its scopes or with no region |

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

<a id="known-gap-no-azure-ad--entra-id-group-to-role-mapping"></a>

## Regional viewer: geographic read-only access (Refs 49/67)

A **regional_viewer** is an organization role for people who oversee an area
of the network rather than one store, such as an RTMM, CM, ASM or TSE at PMI.
They can see every workspace in their area and change nothing.

**Region tree.** An organization's regions form a tree with four levels,
highest first:

| Level | PMI role |
|---|---|
| Region | RTMM |
| Cluster | CM |
| Area | ASM |
| Territory | TSE |

A region's parent must be a **higher** level. Levels can be skipped (a
territory can sit directly under a cluster), and a node can be placed at the
top level whatever its level. So a tree is at most four deep. Names are
unique among siblings. A region that still has child regions can't be
deleted. Each **workspace** belongs to at most one region (Settings →
Regions → Workspace assignments). Geography is per workspace, not per device.

**Scopes.** An org owner or org admin gives a regional_viewer one or more
regions (*Organization members* → **Regions**). The viewer can read every
workspace whose region is one of those regions **or anywhere below one**. A
scope on a cluster covers its areas, their territories, and any territory
directly under the cluster.

**What they get, in each in-scope workspace.** The same as a direct
workspace_viewer:

- dashboards, devices, content, playlists, schedules, reports
- **member lists (including email addresses)**, tickets, campaigns and
  field visits
- exports (CSV / XLSX / PDF) of anything they can read
- the Regions SLA rollup, limited to the regions of the workspaces they can see

**What they never get.**

- **Any write.** They resolve to a read-only `workspace_viewer` context
  (`actingAs: false`), so every write route refuses them. The
  `viewer-write-denial` test sweeps every write route as a regional_viewer.
- **Field-visit logging.** That stays with field technicians and workspace
  editors/admins.
- **Org-wide settings.** Org members, regions, auth and token policy, Entra
  mappings.
- **API tokens.** They can't mint one. A token is refused for read-only
  callers.
- **Workspaces outside their scopes.** That includes sibling regions,
  workspaces in another organization, and **workspaces with no region**,
  which are never visible to a regional_viewer.

**Direct membership wins.** If a regional_viewer also has a
`workspace_members` row in a workspace (for example workspace_editor), that
row applies there, so they can edit that one workspace. The regional scope
only ever adds read access.

**Timing.** Scope changes, role changes and moving a workspace to another
region apply on the **next request**. Nothing is cached. An already-open
dashboard's live socket keeps its rooms until it **reconnects** (switching
workspace or reloading the page reconnects it).

**Cleanup.** Scopes are removed automatically when:

- the member is removed from the org, or their role changes away from
  regional_viewer;
- the user is deleted;
- the organization is deleted;
- the scoped region is deleted.

When a region is deleted, its workspaces become unassigned. Nobody silently
keeps access.

**Sign-in.** A regional_viewer with no workspace membership of their own
lands in their first in-scope workspace. Anyone who already belongs to an
organization, field technicians and regional viewers included, is **never
minted a personal organization** at sign-in. They land in the first workspace
they can reach, or in none. Only a brand-new user with no organization at all
still gets one (when `AUTO_CREATE_ORG_ON_SIGNUP` is on).

**Not mappable from Entra.** The Ref 7 Entra app-role mapping can't grant
regional_viewer; assign it by hand.

## Entra ID role mapping (Ref 7)

This used to be listed here as a known gap. Ref 7 closes it: Entra ID app
roles can now set a user's BeamOS org and workspace roles automatically at
Microsoft sign-in. Setup, timing and the full rules are in
[docs/sso-scim-integration.md, Part 4](sso-scim-integration.md#part-4--ref-7-entra-app-roles-to-beamos-roles).

**How it works.**

1. In Entra, the app registration defines **app roles** (for example
   `BeamOS.Editors`), and the enterprise app assigns **groups** to those
   roles. Entra then puts the user's app roles in the `roles` claim of their
   `id_token`. BeamOS reads only that claim, never the `groups` claim.
2. An org owner or org admin maps each app role value to a BeamOS role in
   *Settings → Entra role mappings* (`/api/organizations/:orgId/entra-role-mappings`).
   Only four roles can be mapped:

   | BeamOS role | Target |
   |---|---|
   | `org_admin` | the organization |
   | `workspace_admin`, `workspace_editor`, `workspace_viewer` | one workspace of that organization |

   `org_owner`, `field_technician`, platform roles and anything else are
   refused. A workspace from another organization is refused.
3. At each Microsoft sign-in whose `id_token` was verified against
   `SSO_TENANT_ID`, [`lib/entra-role-sync.js`](../server/lib/entra-role-sync.js)
   brings the user's memberships in line with their `roles` claim, in one
   transaction, before the session is issued. Without `SSO_TENANT_ID` there is
   no verified claim and no sync. Password, Google, field-technician OTP,
   API-token and service-principal sign-ins never sync.

**Manual memberships win.** Every `organization_members` /
`workspace_members` row has a `source`: `NULL` (manual: added by hand, by
invite, by SCIM or by org bootstrap) or `'entra'` (created by the sync). The
sync only creates, changes and removes `'entra'` rows. If the user already has
a manual row where a mapping points, that row is left exactly as it is. When an
admin changes the role of an `'entra'` membership by hand (or re-adds it from
the platform Users page), it becomes manual and the sync leaves it alone from
then on.

**What the sync does not do.** It does not map `org_owner`,
`field_technician` or platform roles. It does not read SCIM groups
(`/scim/v2/Groups` is still `501`). It does not run for API tokens or service
principals. It does not apply the "last admin" guards that the manual member
routes apply, so an Entra change can remove the last `'entra'`
`workspace_admin` of a workspace.

Note: [`docs/entra-auth.md`](entra-auth.md) (Ref 9) is a separate feature:
Entra ID service principal (machine-to-machine) API authentication. SCIM
provisioning (Ref 8) still provisions accounts with one configured org role;
role mapping is this section's sync, not SCIM.

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
