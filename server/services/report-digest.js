'use strict';

// Ref 46: daily / monthly automated proof-of-play reports.
//
// No RSM/ASM/ZM role hierarchy exists in this app, so this is scoped to the real roles:
//   - DAILY:   one workspace-scoped proof-of-play PDF per workspace, emailed to that
//              workspace's workspace_admin(s).
//   - MONTHLY: one org-wide roll-up PDF (across every workspace in the org) per org,
//              emailed to that org's org_owner(s).
//
// Follows scheduler.js's setInterval pattern: instead of sleeping until midnight, the
// sweep runs on a short interval and asks "has a day/month boundary passed since the
// last send?" - a watermark in app_settings (report_digest_daily_through /
// report_digest_monthly_through) makes it idempotent and restart-safe.
//
// Reuses lib/proof-of-play.js (the same aggregation /api/reports/summary serves),
// lib/report-export.js renderPdf, and services/email.js sendEmail (with the new
// attachments option). All dates are UTC.

const { db: defaultDb } = require('../db/database');
const defaultEmail = require('./email');
const config = require('../config');
const { getProofOfPlaySummary } = require('../lib/proof-of-play');
const { renderPdf } = require('../lib/report-export');

const DAILY_KEY = 'report_digest_daily_through';   // 'YYYY-MM-DD' of the last day reported
const MONTHLY_KEY = 'report_digest_monthly_through'; // 'YYYY-MM' of the last month reported

// ---- date helpers (UTC) ----------------------------------------------------

function ymd(d) {
  return d.toISOString().slice(0, 10);
}
function ym(d) {
  return d.toISOString().slice(0, 7);
}
// [startEpoch, endEpoch] (inclusive, seconds) for a 'YYYY-MM-DD' UTC day.
function utcDayRange(dayStr) {
  const start = Date.parse(dayStr + 'T00:00:00.000Z');
  return { startEpoch: Math.floor(start / 1000), endEpoch: Math.floor(start / 1000) + 86400 - 1 };
}
// [startEpoch, endEpoch] for a 'YYYY-MM' UTC month.
function utcMonthRange(monthStr) {
  const [y, m] = monthStr.split('-').map(Number);
  const start = Date.UTC(y, m - 1, 1) / 1000;
  const end = Date.UTC(y, m, 1) / 1000 - 1; // last second of the month
  return { startEpoch: Math.floor(start), endEpoch: Math.floor(end) };
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

async function resolveWorkspaceAdmins(db, workspaceId) {
  return db
    .prepare(
      `SELECT DISTINCT u.email, u.name
       FROM workspace_members wm JOIN users u ON u.id = wm.user_id
       WHERE wm.workspace_id = ? AND wm.role = 'workspace_admin'
         AND u.email IS NOT NULL AND u.email <> ''`,
    )
    .all(workspaceId);
}

async function resolveOrgOwners(db, organizationId) {
  return db
    .prepare(
      `SELECT DISTINCT u.email, u.name
       FROM organization_members om JOIN users u ON u.id = om.user_id
       WHERE om.organization_id = ? AND om.role = 'org_owner'
         AND u.email IS NOT NULL AND u.email <> ''`,
    )
    .all(organizationId);
}

// ---- PDF ---------------------------------------------------------------

function slug(s) {
  return String(s || 'report').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40) || 'report';
}

// Renders the summary's by-content breakdown as a proof-of-play PDF (reuses the shared
// renderPdf table renderer). Totals go in the title line.
function renderSummaryPdf(titlePrefix, periodLabel, summary) {
  const o = summary.overall;
  const title = `${titlePrefix} — ${periodLabel}   (${o.total_plays} plays · ${o.total_hours}h · ${o.unique_content} items · ${o.unique_devices} devices)`;
  const headers = ['Content', 'Plays', 'Total Hours', 'Completion %'];
  const rows = summary.by_content.map((c) => [
    c.content_name || 'Unknown',
    c.plays,
    (c.total_seconds / 3600).toFixed(1),
    c.plays > 0 ? Math.round((c.completed_plays / c.plays) * 100) + '%' : '0%',
  ]);
  if (!rows.length) rows.push(['(no plays recorded in this period)', '0', '0.0', '0%']);
  return renderPdf(title, headers, rows);
}

// ---- core ------------------------------------------------------------

async function runDailyDigests(db, email, now) {
  const target = ymd(new Date(now.getTime() - 86400_000)); // yesterday (UTC)
  const last = await getSetting(db, DAILY_KEY);
  if (last && last >= target) return { ran: false, target, sent: 0 };

  const { startEpoch, endEpoch } = utcDayRange(target);
  const workspaces = await db.prepare('SELECT id, name, organization_id FROM workspaces').all();
  let sent = 0;

  for (const ws of workspaces) {
    try {
      const admins = await resolveWorkspaceAdmins(db, ws.id);
      if (!admins.length) continue;

      const summary = await getProofOfPlaySummary({
        scopeSql: ' AND device_id IN (SELECT id FROM devices WHERE workspace_id = ?)',
        scopeParams: [ws.id],
        startEpoch,
        endEpoch,
      });
      const pdf = await renderSummaryPdf(`Proof of Play — ${ws.name}`, target, summary);
      const filename = `proof-of-play-${slug(ws.name)}-${target}.pdf`;

      for (const a of admins) {
        await email.sendEmail({
          to: a.email,
          subject: `Daily proof-of-play — ${ws.name} — ${target}`,
          text:
            `Attached is the proof-of-play summary for "${ws.name}" on ${target} (UTC).\n\n` +
            `${summary.overall.total_plays} plays across ${summary.overall.unique_devices} device(s), ` +
            `${summary.overall.total_hours} hours total.`,
          attachments: [{ filename, content: pdf, contentType: 'application/pdf' }],
        });
        sent++;
      }
    } catch (e) {
      console.error(`[report-digest] daily digest for workspace ${ws.id} failed: ${e.message}`);
    }
  }

  await setSetting(db, DAILY_KEY, target);
  console.log(`[report-digest] daily digests for ${target}: ${sent} email(s) across ${workspaces.length} workspace(s)`);
  return { ran: true, target, sent };
}

async function runMonthlyRollups(db, email, now) {
  // Previous calendar month.
  const firstOfThisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const target = ym(new Date(firstOfThisMonth.getTime() - 86400_000));
  const last = await getSetting(db, MONTHLY_KEY);
  if (last && last >= target) return { ran: false, target, sent: 0 };

  const { startEpoch, endEpoch } = utcMonthRange(target);
  const orgs = await db.prepare('SELECT id, name FROM organizations').all();
  let sent = 0;

  for (const org of orgs) {
    try {
      const owners = await resolveOrgOwners(db, org.id);
      if (!owners.length) continue;

      const summary = await getProofOfPlaySummary({
        scopeSql:
          ' AND device_id IN (SELECT d.id FROM devices d JOIN workspaces w ON d.workspace_id = w.id WHERE w.organization_id = ?)',
        scopeParams: [org.id],
        startEpoch,
        endEpoch,
      });
      const pdf = await renderSummaryPdf(`Proof of Play — ${org.name} (org-wide)`, target, summary);
      const filename = `proof-of-play-${slug(org.name)}-${target}.pdf`;

      for (const o of owners) {
        await email.sendEmail({
          to: o.email,
          subject: `Monthly proof-of-play roll-up — ${org.name} — ${target}`,
          text:
            `Attached is the org-wide proof-of-play roll-up for "${org.name}" for ${target} (UTC), ` +
            `across every workspace in the organization.\n\n` +
            `${summary.overall.total_plays} plays across ${summary.overall.unique_devices} device(s), ` +
            `${summary.overall.total_hours} hours total.`,
          attachments: [{ filename, content: pdf, contentType: 'application/pdf' }],
        });
        sent++;
      }
    } catch (e) {
      console.error(`[report-digest] monthly rollup for org ${org.id} failed: ${e.message}`);
    }
  }

  await setSetting(db, MONTHLY_KEY, target);
  console.log(`[report-digest] monthly rollups for ${target}: ${sent} email(s) across ${orgs.length} org(s)`);
  return { ran: true, target, sent };
}

// Testable core: pass a db handle, an email impl ({ sendEmail }), and optionally a fixed
// `now` (ms or Date).
//
// Never throws: the daily and monthly runs are each wrapped here, so a failure in one
// (including the outer watermark getSetting / SELECT / setSetting queries that live
// outside runDaily/runMonthly's per-item try/catch) is logged with its full stack and
// reported as { ran: false, error } — without aborting the other run or crashing the tick.
//
// Always logs a one-line `[report-digest] tick: ...` summary, whether or not any work
// happened, so a healthy "nothing due" tick is visibly distinguishable in the logs from
// a dead / crash-looping service.
async function runReportDigests(db = defaultDb, email = defaultEmail, opts = {}) {
  const now = opts.now ? new Date(opts.now) : new Date();

  let daily;
  try {
    daily = await runDailyDigests(db, email, now);
  } catch (e) {
    console.error(`[report-digest] daily run failed: ${e.stack || e.message}`);
    daily = { ran: false, target: null, sent: 0, error: e.message };
  }

  let monthly;
  try {
    monthly = await runMonthlyRollups(db, email, now);
  } catch (e) {
    console.error(`[report-digest] monthly run failed: ${e.stack || e.message}`);
    monthly = { ran: false, target: null, sent: 0, error: e.message };
  }

  const part = (r) => (r.error ? `error (${r.error})` : r.ran ? `sent ${r.sent}` : 'skipped');
  console.log(`[report-digest] tick: daily ${part(daily)}, monthly ${part(monthly)}`);

  return { daily, monthly };
}

function startReportDigests() {
  const interval = config.reportDigestIntervalMs;
  setInterval(() => {
    // runReportDigests never throws; keep the guard as a backstop and log the full stack
    // (not just the message) if it somehow ever does.
    runReportDigests().catch((e) => console.error(`[report-digest] tick failed: ${e.stack || e.message}`));
  }, interval);
  console.log(`Report digest service started (every ${Math.round(interval / 1000)}s)`);
}

module.exports = {
  startReportDigests,
  runReportDigests,
  runDailyDigests,
  runMonthlyRollups,
  resolveWorkspaceAdmins,
  resolveOrgOwners,
  renderSummaryPdf,
  DAILY_KEY,
  MONTHLY_KEY,
};
