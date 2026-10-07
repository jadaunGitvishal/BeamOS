'use strict';

// PMI Ref 66: scheduled screen-runtime reports for regional viewers (Refs 49/67).
//
// Who gets what is decided by the LEVEL of the regions a regional_viewer is scoped to,
// per organisation:
//   - any scope at 'territory' or 'area'  (TSE / ASM)  -> DAILY   (yesterday)
//   - any scope at 'cluster' or 'region'  (CM / RTMM)  -> WEEKLY  (last complete ISO week)
//                                                      and MONTHLY (last complete month)
//   - scopes at both kinds of level                   -> all three
// One email per (user, organisation) per cadence. Admins / owners get no weekly report;
// their Ref 46 digests (services/report-digest.js) are unchanged.
//
// SCOPE SAFETY. The workspace and screen set of every report is derived at SEND TIME
// from the recipient's CURRENT scopes, using lib/region-scope.regionalWorkspaceIds (the
// same resolver tenancy uses for page access), and then limited to ONE organisation by
// lib/runtime-summary.loadRuntimeInputs, whose every query matches both the workspace
// ids and workspaces.organization_id. Nothing is cached between runs or periods, and no
// workspace list is accepted from a caller. The qualifying-level check only decides
// WHETHER a (user, org) pair gets a cadence; the report then covers all of that user's
// scopes in that org.
//
// Content is runtime only (no proof-of-play), computed by lib/runtime-summary.js (see
// there for the zero-runtime definition). Each email carries a PDF and an XLSX: the
// XLSX lists every screen; the PDF lists every zero-runtime screen plus the
// PDF_LOWEST_LIMIT lowest-uptime others, with an "N screens not shown" note.
//
// Periods are UTC, like the Ref 46 digests (device_usage_daily is per UTC day): in
// India a "day" runs 05:30 IST to 05:30 IST. Weekly = ISO week, Monday 00:00 UTC to
// the following Monday 00:00 UTC.
//
// Same scheduling pattern as report-digest.js (it is called from runReportDigests'
// tick): each cadence has an app_settings watermark (the last period sent); a cadence
// runs when its target period is past the watermark, sends, and advances the watermark
// only after its loop completes. A failed send is logged and NOT retried.
//
// Recipients: users with a non-empty email and deactivated_at IS NULL. The Ref 46
// digests apply no email opt-out (users.email_alerts is not consulted), and neither
// does this.

const { db: defaultDb } = require('../db/database');
const defaultEmail = require('./email');
const { regionalWorkspaceIds, REGIONAL_VIEWER, MAX_REGION_DEPTH } = require('../lib/region-scope');
const { getRuntimeSummary } = require('../lib/runtime-summary');
const { renderSectionedPdf, renderSectionedXlsx } = require('../lib/report-export');

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PDF_LOWEST_LIMIT = 50;
const DAY_MS = 86400_000;

const CADENCES = {
  daily: { key: 'regional_report_daily_through', levels: ['territory', 'area'] },
  weekly: { key: 'regional_report_weekly_through', levels: ['cluster', 'region'] },
  monthly: { key: 'regional_report_monthly_through', levels: ['cluster', 'region'] },
};

// ---- periods (UTC) ----------------------------------------------------------

function ymd(d) {
  return d.toISOString().slice(0, 10);
}
function utcMidnight(now) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
function isoWeekLabel(monday) {
  const thu = new Date(monday.getTime() + 3 * DAY_MS); // ISO week-year = the Thursday's year
  const year = thu.getUTCFullYear();
  const week = Math.floor((thu.getTime() - Date.UTC(year, 0, 1)) / (7 * DAY_MS)) + 1;
  return `${year}-W${String(week).padStart(2, '0')}`;
}

// The last complete period of a cadence as of `now`:
//   { key (watermark value, sortable), label, fileKey, startEpoch, endEpoch (exclusive) }
function targetPeriod(cadence, now) {
  const today = utcMidnight(now);
  if (cadence === 'daily') {
    const start = new Date(today.getTime() - DAY_MS);
    const key = ymd(start);
    return { key, label: key, fileKey: key, startEpoch: start.getTime() / 1000, endEpoch: today.getTime() / 1000 };
  }
  if (cadence === 'weekly') {
    const dow = (today.getUTCDay() + 6) % 7; // Monday = 0
    const thisMonday = new Date(today.getTime() - dow * DAY_MS);
    const start = new Date(thisMonday.getTime() - 7 * DAY_MS);
    const sunday = new Date(thisMonday.getTime() - DAY_MS);
    const week = isoWeekLabel(start);
    return {
      key: ymd(start),
      label: `week ${week} (${ymd(start)} to ${ymd(sunday)})`,
      fileKey: week,
      startEpoch: start.getTime() / 1000,
      endEpoch: thisMonday.getTime() / 1000,
    };
  }
  if (cadence === 'monthly') {
    const firstOfThis = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const key = start.toISOString().slice(0, 7);
    return { key, label: key, fileKey: key, startEpoch: start.getTime() / 1000, endEpoch: firstOfThis.getTime() / 1000 };
  }
  throw new Error(`unknown cadence ${cadence}`);
}

// ---- settings watermark ---------------------------------------------------

async function getSetting(db, key) {
  const row = await db.prepare('SELECT value FROM app_settings WHERE `key` = ?').get(key);
  return row ? row.value : null;
}
async function setSetting(db, key, value) {
  await db
    .prepare(
      'INSERT INTO app_settings (`key`, value, updated_at) VALUES (?, ?, UNIX_TIMESTAMP()) ' +
        'ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)',
    )
    .run(key, String(value));
}

// ---- recipients ---------------------------------------------------------

// (user, organisation) pairs where the user is currently a regional_viewer in that org,
// is active, has an email, and holds at least one scope at one of `levels` there.
async function qualifyingPairs(db, levels) {
  return db
    .prepare(
      `SELECT DISTINCT s.user_id, s.organization_id
         FROM region_viewer_scopes s
         JOIN regions r ON r.id = s.region_id AND r.organization_id = s.organization_id
         JOIN organization_members om ON om.organization_id = s.organization_id AND om.user_id = s.user_id
         JOIN users u ON u.id = s.user_id
        WHERE om.role = ? AND r.level IN (${levels.map(() => '?').join(',')})
          AND u.deactivated_at IS NULL AND u.email IS NOT NULL AND u.email <> ''
        ORDER BY s.organization_id, s.user_id`,
    )
    .all(REGIONAL_VIEWER, ...levels);
}

// ---- region paths ---------------------------------------------------------

// id -> "North > Punjab > Lahore Area" for every region in ONE org.
async function regionPaths(db, organizationId) {
  const rows = await db.prepare('SELECT id, name, parent_id FROM regions WHERE organization_id = ?').all(organizationId);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const paths = new Map();
  for (const r of rows) {
    const names = [];
    let cur = r;
    for (let i = 0; cur && i < MAX_REGION_DEPTH; i++) {
      names.unshift(cur.name);
      cur = cur.parent_id ? byId.get(cur.parent_id) : null;
    }
    paths.set(r.id, names.join(' > '));
  }
  return paths;
}

// ---- rendering -------------------------------------------------------------

function slug(s) {
  return String(s || 'report').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40) || 'report';
}
const fmtPct = (p) => (p == null ? 'n/a' : `${p}%`);
const fmtZero = (t) =>
  t.zero_runtime_eligible > 0 ? `${t.zero_runtime_count} of ${t.zero_runtime_eligible} (${fmtPct(t.zero_runtime_pct)})` : '0 of 0 (n/a)';

// The PDF's screen subset: every zero-runtime screen, then the PDF_LOWEST_LIMIT
// lowest-uptime other screens (ties by name). Returns { shown, omitted }.
function pdfScreenSelection(screens) {
  const byUptime = (a, b) => (a.uptime_pct - b.uptime_pct) || String(a.name).localeCompare(String(b.name)) || String(a.id).localeCompare(String(b.id));
  const zero = screens.filter((s) => s.zero_runtime).sort(byUptime);
  const rest = screens.filter((s) => !s.zero_runtime).sort(byUptime).slice(0, PDF_LOWEST_LIMIT);
  const shown = [...zero, ...rest];
  return { shown, omitted: screens.length - shown.length, zeroCount: zero.length };
}

function buildSections(summary, wsInfo) {
  const o = summary.overall;
  const summaryRows = [
    ['Screens', o.screens],
    ['New in this period', o.new_screens],
    ['Total runtime (hours)', o.runtime_hours],
    ['Average uptime', fmtPct(o.avg_uptime_pct)],
    ['Zero-runtime screens', fmtZero(o)],
    ['Workspaces', summary.workspaces.length],
  ];
  const wsRows = summary.workspaces.map((w) => [
    w.name || w.workspace_id,
    wsInfo.get(w.workspace_id)?.regionPath || '',
    w.screens,
    w.new_screens,
    w.runtime_hours,
    fmtPct(w.avg_uptime_pct),
    fmtZero(w),
  ]);
  const screenRow = (s) => {
    const ws = wsInfo.get(s.workspace_id) || {};
    return [
      s.name,
      s.id,
      ws.name || s.workspace_id,
      ws.regionPath || '',
      ymd(new Date(s.registered_at * 1000)),
      s.runtime_hours,
      fmtPct(s.uptime_pct),
      s.is_new ? 'New in period' : s.zero_runtime ? 'Yes' : 'No',
    ];
  };
  const screenHeaders = ['Screen', 'Device ID', 'Workspace', 'Region', 'Registered (UTC)', 'Runtime (h)', 'Uptime', 'Zero runtime'];

  const allScreens = [...summary.screens].sort(
    (a, b) =>
      String(wsInfo.get(a.workspace_id)?.name || '').localeCompare(String(wsInfo.get(b.workspace_id)?.name || '')) ||
      String(a.name).localeCompare(String(b.name)) ||
      String(a.id).localeCompare(String(b.id)),
  );
  const { shown, omitted, zeroCount } = pdfScreenSelection(summary.screens);

  const head = [
    { heading: 'Runtime Summary', headers: ['Metric', 'Value'], rows: summaryRows },
    { heading: 'Workspaces', headers: ['Workspace', 'Region', 'Screens', 'New', 'Runtime (h)', 'Avg uptime', 'Zero-runtime'], rows: wsRows },
  ];
  const pdfHeading =
    `Screens: ${zeroCount} zero-runtime + up to ${PDF_LOWEST_LIMIT} lowest uptime` +
    (omitted > 0 ? ` (${omitted} screens not shown; see the XLSX)` : '');
  return {
    pdf: [...head, { heading: pdfHeading, headers: screenHeaders, rows: shown.map(screenRow) }],
    xlsx: [...head, { heading: 'Screens', headers: screenHeaders, rows: allScreens.map(screenRow) }],
    omitted,
  };
}

// ---- one report -------------------------------------------------------------

const CADENCE_TITLE = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' };

// Builds and sends one (user, org, cadence) report. Everything is resolved here, now:
// the user's state, their current scopes, and the workspaces those scopes reach in
// this org. Returns 'sent' or a skip reason.
async function sendRegionalReport(db, email, { cadence, period, userId, organizationId }) {
  const user = await db.prepare('SELECT id, email, name, deactivated_at FROM users WHERE id = ?').get(userId);
  if (!user || user.deactivated_at != null || !user.email) return 'skipped:user';
  const org = await db.prepare('SELECT id, name FROM organizations WHERE id = ?').get(organizationId);
  if (!org) return 'skipped:org';

  // Current scopes -> workspaces (all orgs) -> limited to this org inside the loader.
  const scopedIds = await regionalWorkspaceIds(db, userId);
  const summary = await getRuntimeSummary(db, {
    organizationId,
    workspaceIds: scopedIds,
    startEpoch: period.startEpoch,
    endEpoch: period.endEpoch,
  });
  if (!summary.workspaces_loaded.length) return 'skipped:no-workspaces';

  const paths = await regionPaths(db, organizationId);
  const wsInfo = new Map(
    summary.workspaces_loaded.map((w) => [w.id, { name: w.name, regionPath: w.region_id ? paths.get(w.region_id) || '' : '' }]),
  );
  const scopeRows = await db
    .prepare(
      `SELECT s.region_id FROM region_viewer_scopes s
         JOIN regions r ON r.id = s.region_id AND r.organization_id = s.organization_id
        WHERE s.organization_id = ? AND s.user_id = ?`,
    )
    .all(organizationId, userId);
  const scopeNames = scopeRows.map((r) => paths.get(r.region_id)).filter(Boolean).sort();

  const o = summary.overall;
  const sections = buildSections(summary, wsInfo);
  const title = `Screen runtime — ${org.name} — ${CADENCE_TITLE[cadence]} ${period.label} (UTC)`;
  const [pdf, xlsx] = await Promise.all([renderSectionedPdf(title, sections.pdf), renderSectionedXlsx(sections.xlsx)]);
  const base = `screen-runtime-${slug(org.name)}-${cadence}-${period.fileKey}`;

  const istNote =
    cadence === 'daily'
      ? 'UTC day; in India that is 05:30 IST on that date to 05:30 IST the next day'
      : 'UTC; in India each day runs 05:30 to 05:30 IST';
  await email.sendEmail({
    to: user.email,
    subject: `Screen runtime: ${org.name} · ${CADENCE_TITLE[cadence]} ${period.label}`,
    text:
      `${CADENCE_TITLE[cadence]} screen runtime report for "${org.name}", ${period.label} (${istNote}).\n` +
      `Covers the workspaces in your current regions: ${scopeNames.join('; ') || '(none)'}.\n\n` +
      `Screens: ${o.screens}` + (o.new_screens ? ` (${o.new_screens} new in this period)` : '') + '\n' +
      `Total runtime: ${o.runtime_hours} hours\n` +
      `Average uptime: ${fmtPct(o.avg_uptime_pct)}\n` +
      `Zero-runtime screens: ${fmtZero(o)}\n\n` +
      `Attached as Excel (every screen) and PDF (zero-runtime screens and the ${PDF_LOWEST_LIMIT} lowest-uptime others` +
      (sections.omitted > 0 ? `; ${sections.omitted} screens not shown` : '') +
      ').',
    attachments: [
      { filename: `${base}.pdf`, content: pdf, contentType: 'application/pdf' },
      { filename: `${base}.xlsx`, content: xlsx, contentType: XLSX_MIME },
    ],
  });
  return 'sent';
}

// ---- cadence run ----------------------------------------------------------

async function runCadence(db, email, cadence, now) {
  const { key, levels } = CADENCES[cadence];
  const period = targetPeriod(cadence, now);
  const last = await getSetting(db, key);
  if (last && last >= period.key) return { ran: false, target: period.key, sent: 0, failed: 0, skipped: 0 };

  const pairs = await qualifyingPairs(db, levels);
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  for (const p of pairs) {
    try {
      const r = await sendRegionalReport(db, email, { cadence, period, userId: p.user_id, organizationId: p.organization_id });
      if (r === 'sent') sent++;
      else skipped++;
    } catch (e) {
      failed++;
      console.error(`[regional-report] ${cadence} report for user ${p.user_id} org ${p.organization_id} failed (not retried): ${e.message}`);
    }
  }

  await setSetting(db, key, period.key);
  console.log(`[regional-report] ${cadence} reports for ${period.key}: ${sent} sent, ${skipped} skipped, ${failed} failed`);
  return { ran: true, target: period.key, sent, failed, skipped };
}

// Testable core: db handle, email impl ({ sendEmail }), optional fixed `now` (ms or
// Date). Never throws: each cadence is isolated, so one failing doesn't stop the others.
async function runRegionalReports(db = defaultDb, email = defaultEmail, opts = {}) {
  const now = opts.now ? new Date(opts.now) : new Date();
  const out = {};
  for (const cadence of Object.keys(CADENCES)) {
    try {
      out[cadence] = await runCadence(db, email, cadence, now);
    } catch (e) {
      console.error(`[regional-report] ${cadence} run failed: ${e.stack || e.message}`);
      out[cadence] = { ran: false, target: null, sent: 0, failed: 0, skipped: 0, error: e.message };
    }
  }
  const part = (r) => (r.error ? `error (${r.error})` : r.ran ? `sent ${r.sent}` + (r.failed ? `, ${r.failed} failed` : '') : 'skipped');
  console.log(`[regional-report] tick: daily ${part(out.daily)}, weekly ${part(out.weekly)}, monthly ${part(out.monthly)}`);
  return out;
}

module.exports = {
  runRegionalReports,
  runCadence,
  sendRegionalReport,
  targetPeriod,
  isoWeekLabel,
  qualifyingPairs,
  pdfScreenSelection,
  CADENCES,
  PDF_LOWEST_LIMIT,
};
