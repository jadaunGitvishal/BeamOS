# Setting up regional read-only access (PMI)

For organization owners and admins. This sets up read-only, area-wide visibility
for PMI's field hierarchy: RTMM, CM, ASM and TSE. How it works and what a
regional viewer can and can't do is in [rbac.md](rbac.md#regional-viewer-geographic-read-only-access-refs-4967).

## 1. Decide what a workspace is

Visibility is granted **per workspace**, so the workspace is the smallest unit
anyone can be given. Use **one workspace per territory**, or one per store
cluster if a territory has too few screens to justify its own. Devices,
content and schedules live inside workspaces as usual.

## 2. Build the region tree

*Settings → Regions.* Add nodes from the top down:

| Level | PMI role | Typical parent |
|---|---|---|
| Region | RTMM | (top level) |
| Cluster | CM | a Region |
| Area | ASM | a Cluster |
| Territory | TSE | an Area |

A parent must be a higher level. You can skip a level (for example, a
territory directly under a cluster) or place a node at the top level whatever
its level. Names only need to be unique under the same parent. To remove a
region, delete or move its children first.

## 3. Put each workspace in its region

*Settings → Regions → Workspace assignments*: pick the workspace's region, which
is normally its territory. **A workspace with no region is invisible to every
regional viewer**, so check that none are left unassigned.

## 4. Add the people

*Organization members → Add member*, role **Regional viewer** (the account must
already exist). The region picker opens next: tick the node that matches the
person's job, and everything below it is included.

| Person | Scope |
|---|---|
| RTMM | their Region |
| CM | their Cluster |
| ASM | their Area |
| TSE | their Territory |

Someone covering two areas gets both. A regional viewer with no regions sees
nothing. Change their regions any time with the **Regions** button on their
row.

## Reports you'll receive

Regional viewers get screen-runtime reports by email. Each email has a summary
in the body and attaches an Excel file listing every screen, plus a PDF
listing every screen that was never online and the 50 with the lowest uptime.

| Scope | Reports |
|---|---|
| A territory or area (TSE, ASM) | Daily, for yesterday |
| A cluster or region (CM, RTMM) | Weekly (Monday to Sunday) and monthly |

- Someone with both kinds of scope gets all three. Each report covers all of
  their regions in that organization.
- **Days are UTC.** In India, a day runs from 05:30 IST to 05:30 IST the next
  day, so the daily report arrives after 05:30 IST.
- Reports always use the person's regions **at the time of sending**, so scope
  changes apply to the next report.
- Deactivated accounts and people whose regions contain no workspaces don't
  get reports. A report that fails to send isn't retried.
- Admins and owners keep their existing proof-of-play reports.

Details, including how a zero-runtime screen is defined, are in
[regional-reports.md](regional-reports.md).

### Field operations report (on the portal)

**Reports → Field operations** shows installations and activations, RFS and
R&M visits, other visits, visits still in progress, and OEM / hardware cases
for the current workspace, by UTC day, ISO week or month. You can download it
as CSV, XLSX or PDF. It isn't emailed. Anyone who can read the workspace's
field visits can open it, and that includes regional viewers in scope. Two
definitions are still pending PMI confirmation: RFS = "Routine check" visits,
and OEM case = "hardware" tickets. See
[field-operations-report.md](field-operations-report.md).

## Good to know

- **Read-only.** Regional viewers can view and export everything in their
  workspaces, including member lists with email addresses, tickets, campaigns
  and field visits. They can't change anything, can't log field visits, and
  can't create API tokens.
- **Direct membership wins.** To let one person edit a particular store, also
  add them to that workspace as an editor. That workspace then follows the
  editor role.
- **Timing.** Changes to regions, assignments or scopes apply on the person's
  next page load. An open live dashboard picks them up when it reconnects,
  for example after a reload.
- **No personal organization.** Regional viewers and field technicians
  already belong to your organization, so signing in never creates a personal
  organization for them. They land in their first reachable workspace.
- **Leavers.** Removing someone from the organization, or changing their role,
  removes their regions automatically.
