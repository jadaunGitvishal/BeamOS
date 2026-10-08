# Field operations report (PMI Ref 68)

A fixed report covering field work in **one workspace** (the workspace you're
in) over one period. It's on the portal under **Reports → Field operations**,
with CSV, XLSX and PDF downloads. It isn't emailed.

Every definition below lives in a single config block,
`FIELD_OPS_CONFIG` in `server/lib/field-ops-summary.js`. The API returns that
block as `definitions`, and the portal reads it from there. No other part of
the code repeats these values; a test fails if it does. Ref 71 imports the
same module.

## Sections

| Section | What's counted |
|---|---|
| Installations and activations | Completed visits of type **Installation**, by technician, with a list. Also the **screens activated** in the period, with a list. |
| RFS visits | Completed visits of type **Routine check**, by technician and by screen. Includes the device status recorded at the screen's latest completed visit. |
| R&M visits | The same, for visits of type **Repair**. |
| Other visits | Completed visits of any other type (count and list). |
| Visits in progress | Visits started in or before the period that are **still in progress now**. Listed separately and never counted as completed. |
| OEM / hardware cases | Tickets with owner category **hardware**: opened in the period, resolved in the period, open now, and the average age of the open ones (in days), with a list. |

Visit lists include the technician, screen, device status and remarks. The
OEM list includes the ticket title and description.

## Definitions

> **Pending PMI confirmation.** The two items marked ⚠ are assumptions. The
> portal shows "Definition assumed: pending PMI confirmation" under the RFS
> and OEM headings. Once PMI confirms, remove the item from
> `PMI_CONFIRMATION_PENDING`, and change the mapping if needed. Change it in
> that one place only.

- ⚠ **Visit type → section** (assumed): `Installation` → Installations,
  `Routine check` → RFS, `Repair` → R&M. Anything else goes to Other. Matching
  is exact after trimming spaces. These are the three types the field-tech
  app offers.
- ⚠ **OEM / hardware case** (assumed): a ticket whose owner category is
  `hardware`. There is no separate OEM field.
- **Completed visit:** status `completed`, with a completion time inside the
  period. A visit counts in the period it was **completed**, not the one it
  was started in.
- **In progress:** not completed, and started before the period ended. This
  reflects the visit's state **now**. A visit started last week and finished
  today appears in neither last week's completed list nor its in-progress
  list.
- **Activation:** a screen first paired (`devices.created_at`) inside the
  period, that isn't blocked and isn't still waiting to be re-paired
  (`provisioning`). This is the same screen rule as the Ref 66 runtime
  reports (`lib/runtime-summary.js`). A screen paired at exactly 00:00 UTC
  counts in the period that starts then.
- **OEM figures:** "opened" uses the ticket's creation time and "resolved" its
  resolution time. "Open now (as of today)" means not resolved or closed at
  the moment the report is generated, so for a past period it still shows
  **today's** backlog. Every format uses that label, taken from
  `METRIC_LABELS` in the config. The average age covers the cases that are
  open now.
- **Technician:** the user's name, or their email if they have no name. A
  technician whose account has been deleted appears as **Deleted user**.

## Periods

All periods are UTC, the same as the Ref 66 regional reports. Pick a period
type and any date inside it. If you leave the date empty, the report uses the
**last complete** period.

| Period | Runs from | In India (IST) |
|---|---|---|
| Day | 00:00 UTC to the next 00:00 UTC | 05:30 to 05:30 IST the next day |
| ISO week | Monday 00:00 UTC to the following Monday 00:00 UTC | Monday 05:30 IST to the next Monday 05:30 IST |
| Month | The 1st 00:00 UTC to the next month's 1st 00:00 UTC | The 1st 05:30 IST to the next 1st 05:30 IST |

You can choose the current period. It's then marked "Period not over yet".
Future dates are refused.

## Who can see it

Anyone who can read the workspace's field visits, using exactly the same
check as the field-visit pages (`canReadFieldVisits` in
`lib/permissions.js`):

- workspace members (any role), and org owners and admins;
- **field technicians** of the organization, because they can log visits
  in any of its workspaces;
- **regional viewers** whose regions include the workspace;
- platform staff.

Everyone else gets a 403. **API tokens are refused**, because field-visit
data isn't available to tokens anywhere else either. The report covers only
the workspace you're in; there is no roll-up across workspaces.

## API

`GET /api/reports/field-operations?period=day|week|month&date=YYYY-MM-DD&format=json|csv|xlsx|pdf`

- Defaults: `period=week`, `format=json`, and no date (the last complete
  period).
- An unknown period, a malformed, impossible or future date, or an unknown
  format returns a 400.
- JSON returns `period`, `workspace`, `generated_at`, `totals`, `sections`
  and `definitions`.

## Exports

File names are `field-operations-<day|week|month>-<key>.<ext>`, for example
`field-operations-week-2026-W40.xlsx`, `field-operations-day-2026-10-06.pdf`
or `field-operations-month-2026-09.csv`.

- **XLSX:** a Summary sheet (counts plus the pending definitions), then one
  sheet per section: Installation visits, Activations, RFS, R&M, Other
  visits, In progress, OEM cases, By technician, By screen. It contains every
  row and the full remarks.
- **PDF:** the summary, then each list **capped at 200 rows**. A capped
  section's heading reads "first 200 of N; M more in the XLSX". Long remarks
  and descriptions are shortened.
- **CSV:** one file. Its `Section` column names the table and its `Row`
  column is `columns` (that table's column names) or `data`. Filter on
  Section to get one table back.

Each download is recorded once in the audit log (an `EXPORT` entry, Ref 20).
Viewing the report in the portal isn't recorded.

## What's never included

No SIM data. `field_visits.sim_network_info` is never read by this report
and appears in no format. A test checks every format for it.
