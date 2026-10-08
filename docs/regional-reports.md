# Regional runtime reports (PMI Ref 66)

Scheduled email reports on screen runtime for **regional viewers** (the
RTMM / CM / ASM / TSE hierarchy in [pmi-regional-setup.md](pmi-regional-setup.md)).
They complement the Ref 46 proof-of-play digests, which go to workspace admins
(daily) and organisation owners (monthly) and haven't changed.

Code: [`services/regional-report.js`](../server/services/regional-report.js)
(scheduling, recipients, rendering) and
[`lib/runtime-summary.js`](../server/lib/runtime-summary.js) (the figures,
shared with Ref 71).

## Who receives what

Cadence depends on the **level** of the regions a person is scoped to, in each
organisation separately:

| Scopes in the organisation | Typical role | Reports |
|---|---|---|
| Any territory or area | TSE, ASM | **Daily** (yesterday) |
| Any cluster or region | CM, RTMM | **Weekly** (last complete ISO week) and **monthly** (last complete month) |
| Both kinds | | All three |

- **One email per person, organisation and cadence.** Someone who is a regional
  viewer in two organisations gets a separate report for each, and each covers
  only that organisation's screens.
- **A report covers all of the person's scopes in that organisation**, not only
  the scopes that qualified them for the cadence. For example, a person scoped to a
  territory and a region gets a daily report and a weekly report, and both cover
  the territory and the region.
- **No report** when the person's scopes reach no workspaces (for example, every
  workspace under them has no region assigned).
- Admins and owners get no regional report. Their Ref 46 digests are
  unchanged, and there is no weekly digest for them.

### Eligibility

- The person must currently be a `regional_viewer` in the organisation, with an
  email address.
- **Deactivated users never receive reports.** This is checked when the
  recipient list is built and again just before each send.
- There is no separate on/off setting and no email opt-out. This matches the
  Ref 46 digests, which don't check `users.email_alerts`. That flag controls
  device alert emails only.

## Scope is checked at send time

Each report's workspaces and screens are worked out **when that email is built**,
from the person's **current** scopes. The report uses
`lib/region-scope.regionalWorkspaceIds`, the same resolver that controls what
they can open in the app, and then limits the result to the one organisation.
Every device and usage query filters on both the workspace ids **and**
`workspaces.organization_id`. Nothing is cached between runs.

So if someone's regions change, or a workspace moves to another region, the next
report reflects it. A screen outside their current scope, in a workspace with no
region, or in another organisation never appears.

## What's in a report

**Email body:** the period (UTC, with the IST equivalent), the person's current
regions, then screens (and how many are new), total runtime in hours, average
uptime, and zero-runtime screens as a count, the number of eligible screens and
a percentage.

**Subject:** `Screen runtime: <organisation> · <Daily|Weekly|Monthly> <period>`,
for example `Screen runtime: PMI India · Weekly week 2026-W35 (2026-08-24 to 2026-08-30)`.

**Attachments:** `screen-runtime-<organisation>-<cadence>-<period>.pdf` and
`.xlsx`, for example `screen-runtime-pmi-india-weekly-2026-W35.xlsx`. Both have
the same three parts:

| Part | Contents |
|---|---|
| Runtime Summary | Screens, new in this period, total runtime (hours), average uptime, zero-runtime screens, workspaces |
| Workspaces | Each workspace with its region path (for example `North > Punjab > Lahore Area`) and its own totals |
| Screens | Name, device id, workspace, region, registration date (UTC), runtime (hours), uptime, zero runtime (Yes / No / New in period) |

- The **XLSX lists every screen.**
- The **PDF lists every zero-runtime screen plus the 50 lowest-uptime others**.
  When that leaves screens out, the heading says
  `N screens not shown; see the XLSX` (the email says so too).

## How the figures are worked out

The source is `device_usage_daily`, which stores the seconds each device was
online on each UTC day. It's the same source as the Ref 46 uptime figure and the
billing usage rollup.

**What counts as a screen:** a device in one of the in-scope workspaces that is
not blocked and not still waiting to be paired (`status = 'provisioning'`).
Devices with no workspace are never included. A device's registration time is
`devices.created_at`, when it was first paired.

**Zero-runtime screen**, the one definition used everywhere:

1. it was registered **at or before the start** of the period,
2. it isn't blocked, and
3. it was online for **0 seconds** in the period.

Screens registered **during** the period are marked *New in period*. They are
left out of the zero-runtime count **and** out of the total it's divided by.
Their uptime is measured against the time since they were registered, not the
whole period. Screens registered after the period ended aren't in the report.

- **Uptime %** = online seconds ÷ seconds the screen existed in the period.
  It's capped at 100%: usage is recorded per whole UTC day, so on the day a
  screen is registered it can slightly exceed the time since pairing.
- **Average uptime** is time-weighted: total online seconds ÷ total seconds
  the screens existed in the period. Zero-runtime screens pull it down, and a
  new screen counts only for the time since it was registered.
- Hours and percentages are rounded half-up to one decimal place.

## Periods (UTC)

All periods are UTC, like the Ref 46 digests, because the usage data is stored
per UTC day.

| Cadence | Period | Sent |
|---|---|---|
| Daily | Yesterday, 00:00–24:00 UTC | On the first scheduler tick after 00:00 UTC |
| Weekly | ISO week: Monday 00:00 UTC to the next Monday 00:00 UTC, labelled like `2026-W35` | On the first tick after Monday 00:00 UTC |
| Monthly | The previous calendar month | On the first tick after 00:00 UTC on the 1st |

**In India a "day" runs from 05:30 IST to 05:30 IST the next day.** A daily
report for 6 October covers 05:30 IST on 6 October to 05:30 IST on 7 October,
and it arrives after 05:30 IST on 7 October.

## Scheduling and failures

- Runs on the Ref 46 digest tick (`REPORT_DIGEST_INTERVAL_MS`, hourly by
  default), after the digests, inside its own `try/catch`. A failure here can't
  affect the digests. It logs its own line:
  `[regional-report] tick: daily …, weekly …, monthly …`.
  The `[report-digest] tick:` line is unchanged.
- Each cadence keeps a watermark in `app_settings`:
  `regional_report_daily_through` (`YYYY-MM-DD`),
  `regional_report_weekly_through` (the Monday of the ISO week, `YYYY-MM-DD`)
  and `regional_report_monthly_through` (`YYYY-MM`). A cadence runs only when
  its period is newer than the watermark. The watermark moves forward once
  every recipient has been tried, so restarts never send a report twice.
- **A failed send is logged and not retried**, the same as Ref 46. One person's
  failure doesn't stop the others.
- No database migration: only the three `app_settings` rows above.

## Overview dashboard: screen runtime (PMI Ref 71)

The React dashboard's Overview page has a **Screen runtime** row with the same
figures as these reports, for the **active workspace**. It reads
`GET /api/dashboard/runtime?period=<1|7|30>` (the global period selector's
values; `24h`, `7d` and `30d` are accepted too). The endpoint takes every
figure from `lib/runtime-summary.js`, so the dashboard and the reports can't
disagree.

**Who can read it:** the same callers as `GET /api/dashboard/overview`. It is
mounted the same way (JWT session plus the active workspace; see
`config/api-surface.js`). API tokens get 401. Someone with no workspace gets
200 with every figure `n/a`.

**Period: whole complete UTC days, never today.** Today is still accruing, so
it is left out:

| Selector | Days covered |
|---|---|
| 24h | Yesterday, 00:00 to 24:00 UTC (the daily report's day) |
| 7d | The 7 complete UTC days before today |
| 30d | The 30 complete UTC days before today |
| Missing or unknown | 30 complete UTC days, the default window of the other dashboard routes |

The response gives the day range (`first_day`, `last_day`) and a label such as
`last 7 complete days (UTC)`. In India each day runs from 05:30 IST to 05:30 IST
the next day, so "yesterday" ends at 05:30 IST today. This range can differ from
the Overview header's rolling "Reporting period", which runs up to now.

**KPIs** (the definitions above apply unchanged):

- **Average runtime** = hours online per screen per day: the time-weighted
  average uptime x 24. A screen registered during the period counts only for the
  time since it was registered. It's worked from the unrounded seconds, capped
  at 24 h and rounded half-up to one decimal. The row shows no uptime %, so the
  SLA "Fleet uptime" gauge is the page's only uptime figure (the API still
  returns the reports' average uptime as `avg_uptime_pct`, for parity checks).
  The row's figures can differ from that gauge because they are time-weighted
  across all eligible screens, including screens with no runtime, while the
  gauge is a plain per-screen average of only the screens that reported usage
  data.
- **Zero-runtime screens** = the zero-runtime rule above: registered at or
  before the period start, not blocked, not waiting to be paired, 0 online
  seconds. Shown as "N of M" and a percentage, where M is the screens registered
  at or before the period start (new screens are left out of both).
- **Screens with no runtime**: up to 10 zero-runtime screens, sorted by name,
  each linking to that screen's page, with "and N more" when there are more.
- With no screens (or no eligible screens), the figure shows **n/a**.

**RFS compliance is not shown yet.** It is waiting for PMI's definition of the
RFS target. There is no RFS target setting or column.
