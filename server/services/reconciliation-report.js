'use strict';

// Ref 49 (reconciliation reporting), Stage A — a per-workspace "device
// reconciliation" report that surfaces long-lived discrepancies (ghost and
// stale devices; see lib/reconciliation.js) and emails the workspace_admin(s)
// a PDF + XLSX, exactly like the Ref 46 proof-of-play digest.
//
// SCHEDULING is the SAME watermark-based sweep as services/report-digest.js:
// instead of a cron, a short-interval tick asks "have `reconciliation_frequency_days`
// days passed since the last send?" - a single 'YYYY-MM-DD' watermark in
// app_settings (reconciliation_report_through) makes it idempotent and
// restart-safe. The only difference from the digest is the CADENCE: the digest
// is fixed daily/monthly, this one runs every N days where N is
// admin-configurable to ANY integer via the app_settings key
// `reconciliation_frequency_days` (config.js supplies the default).
//
// A workspace with no discrepancies (and one with no workspace_admin) is
// skipped - the report only goes out when there's something actionable in it.
// All dates are UTC.

const { db: defaultDb } = require('../db/database');
const defaultEmail = require('./email');
const config = require('../config');
const { getReconciliation } = require('../lib/reconciliation');
const { renderSectionedPdf, renderSectionedXlsx } = require('../lib/report-export');
const { resolveWorkspaceAdmins } = require('./report-digest');

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const RECON_KEY = 'reconciliation_report_through'; // 'YYYY-MM-DD' of the last run
const FREQ_KEY = 'reconciliation_frequency_days';

// ---- date helpers (UTC) --------------------------------------------------

function ymd(d) {
  return d.toISOString().slice(0, 10);
}
function daysBetween(fromYmd, toYmd) {
  return Math.round(
    (Date.parse(toYmd + 'T00:00:00.000Z') - Date.parse(fromYmd + 'T00:00:00.000Z')) / 86400000,
  );
}
// epoch seconds -> "YYYY-MM-DD HH:MM UTC" (or a caller-supplied fallback)
function fmtTs(sec, fallback = 'never') {
  if (!sec) return fallback;
  return new Date(Number(sec) * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

// ---- settings watermark (identical to report-digest's proven helpers) ---

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

// The effective frequency: the app_settings key wins once set, else the
// config.js env default; clamped to a sane floor of 1 day.
async function resolveFrequencyDays(db) {
  const raw = await getSetting(db, FREQ_KEY);
  const n = raw == null ? config.reconciliationFrequencyDays : parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : Math.max(1, config.reconciliationFrequencyDays);
}

// The scheduling state, for surfaces that show WHEN the next report fires (the
// dashboard's Reconciliation view) without waiting for or triggering a send.
//   frequency_days   - the effective cadence (resolveFrequencyDays)
//   last_report_date - watermark 'YYYY-MM-DD', or null if it has never run
//   next_report_date - last_report_date + frequency_days, or null if never run
//                      (a never-run report fires on the next sweep)
//   overdue          - true if the interval has already elapsed (the next
//                      hourly sweep will send it)
async function getReportStatus(db, now = new Date()) {
  const freqDays = await resolveFrequencyDays(db);
  const last = await getSetting(db, RECON_KEY);
  let nextDate = null;
  let overdue = false;
  if (last) {
    const d = new Date(last + 'T00:00:00.000Z');
    d.setUTCDate(d.getUTCDate() + freqDays);
    nextDate = ymd(d);
    overdue = daysBetween(last, ymd(now)) >= freqDays;
  }
  return {
    frequency_days: freqDays,
    last_report_date: last,
    next_report_date: nextDate,
    overdue,
  };
}

// ---- report rendering --------------------------------------------------

function slug(s) {
  return (
    String(s || 'report')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 40) || 'report'
  );
}

// The two sections shared by the PDF and the XLSX rendering.
function buildReconciliationSections(recon) {
  const ghostRows = recon.ghosts.map((g) => [
    g.name || g.device_id,
    fmtTs(g.registered_at, 'unknown'),
    fmtTs(g.last_heartbeat, 'never'),
  ]);
  if (!ghostRows.length) ghostRows.push(['(none — every registered device has reported at least once)', '', '']);

  const staleRows = recon.stale.map((s) => [
    s.name || s.device_id,
    fmtTs(s.registered_at, 'unknown'),
    fmtTs(s.last_heartbeat, 'never'),
    s.days_since_heartbeat == null ? 'n/a' : String(s.days_since_heartbeat),
  ]);
  if (!staleRows.length) staleRows.push([`(none — no device silent for ${recon.stale_after_days}+ days)`, '', '', '']);

  return [
    {
      heading: 'Ghost Devices (never reported)',
      headers: ['Device', 'Registered', 'Last Heartbeat'],
      rows: ghostRows,
    },
    {
      heading: `Stale Devices (no heartbeat in ${recon.stale_after_days}+ days)`,
      headers: ['Device', 'Registered', 'Last Heartbeat', 'Days Since'],
      rows: staleRows,
    },
  ];
}

async function renderReconciliationFiles(workspaceName, dayStr, recon) {
  const title =
    `Device Reconciliation — ${workspaceName} — ${dayStr}   ` +
    `(${recon.ghosts.length} ghost · ${recon.stale.length} stale)`;
  const sections = buildReconciliationSections(recon);
  const [pdf, xlsx] = await Promise.all([
    renderSectionedPdf(title, sections),
    renderSectionedXlsx(sections),
  ]);
  return { pdf, xlsx };
}

function reportAttachments(base, pdf, xlsx) {
  return [
    { filename: `${base}.pdf`, content: pdf, contentType: 'application/pdf' },
    { filename: `${base}.xlsx`, content: xlsx, contentType: XLSX_MIME },
  ];
}

function summaryLines(recon, limit = 8) {
  const lines = [];
  const g = recon.ghosts.slice(0, limit);
  const s = recon.stale.slice(0, limit);
  if (g.length) {
    lines.push('', `Ghost devices (registered, never reported): ${recon.ghosts.length}`);
    for (const d of g) lines.push(`  - ${d.name || d.device_id} (registered ${fmtTs(d.registered_at, 'unknown')})`);
    if (recon.ghosts.length > g.length) lines.push(`  ... and ${recon.ghosts.length - g.length} more (see attachment)`);
  }
  if (s.length) {
    lines.push('', `Stale devices (silent for ${recon.stale_after_days}+ days): ${recon.stale.length}`);
    for (const d of s)
      lines.push(
        `  - ${d.name || d.device_id} (last heartbeat ${fmtTs(d.last_heartbeat, 'never')}` +
          `${d.days_since_heartbeat == null ? '' : `, ${d.days_since_heartbeat}d ago`})`,
      );
    if (recon.stale.length > s.length) lines.push(`  ... and ${recon.stale.length - s.length} more (see attachment)`);
  }
  return lines;
}

// ---- core --------------------------------------------------------------

async function runReconciliationReport(db, email, now) {
  const today = ymd(now);
  const freqDays = await resolveFrequencyDays(db);
  const last = await getSetting(db, RECON_KEY);

  if (last && daysBetween(last, today) < freqDays) {
    return { ran: false, today, freqDays, sent: 0, workspacesWithFindings: 0 };
  }

  const workspaces = await db.prepare('SELECT id, name FROM workspaces').all();
  let sent = 0;
  let workspacesWithFindings = 0;

  for (const ws of workspaces) {
    try {
      const recon = await getReconciliation(db, { workspaceId: ws.id, now });
      if (!recon.ghosts.length && !recon.stale.length) continue;
      workspacesWithFindings++;

      const admins = await resolveWorkspaceAdmins(db, ws.id);
      if (!admins.length) {
        console.warn(
          `[reconciliation-report] workspace ${ws.id} has ${recon.ghosts.length} ghost / ${recon.stale.length} stale device(s) but no workspace_admin to notify`,
        );
        continue;
      }

      const { pdf, xlsx } = await renderReconciliationFiles(ws.name, today, recon);
      const base = `device-reconciliation-${slug(ws.name)}-${today}`;

      for (const a of admins) {
        await email.sendEmail({
          to: a.email,
          subject: `Device reconciliation — ${ws.name} — ${today}`,
          text:
            `Attached (PDF + Excel) is the device reconciliation report for "${ws.name}" as of ${today} (UTC).\n\n` +
            `${recon.ghosts.length} ghost device(s) (registered but never reported) and ` +
            `${recon.stale.length} stale device(s) (no heartbeat in ${recon.stale_after_days}+ days) were found.` +
            summaryLines(recon).join('\n') +
            `\n\nThis report runs every ${freqDays} day(s) (Settings › reconciliation_frequency_days).`,
          attachments: reportAttachments(base, pdf, xlsx),
        });
        sent++;
      }
    } catch (e) {
      console.error(`[reconciliation-report] workspace ${ws.id} failed: ${e.message}`);
    }
  }

  await setSetting(db, RECON_KEY, today);
  console.log(
    `[reconciliation-report] ${today} (every ${freqDays}d): ${sent} email(s) (pdf+xlsx) across ` +
      `${workspacesWithFindings}/${workspaces.length} workspace(s) with findings`,
  );
  return { ran: true, today, freqDays, sent, workspacesWithFindings };
}

// Testable wrapper: never throws, always logs exactly one tick summary line so a
// healthy "nothing due" tick is distinguishable from a dead service.
async function runReconciliationReports(db = defaultDb, email = defaultEmail, opts = {}) {
  const now = opts.now ? new Date(opts.now) : new Date();
  let result;
  try {
    result = await runReconciliationReport(db, email, now);
  } catch (e) {
    console.error(`[reconciliation-report] run failed: ${e.stack || e.message}`);
    result = { ran: false, today: null, sent: 0, error: e.message };
  }
  const part = result.error
    ? `error (${result.error})`
    : result.ran
      ? `sent ${result.sent} (pdf+xlsx)`
      : 'skipped';
  console.log(`[reconciliation-report] tick: ${part}`);
  return result;
}

function startReconciliationReport() {
  const interval = config.reconciliationReportIntervalMs;
  setInterval(() => {
    runReconciliationReports().catch((e) =>
      console.error(`[reconciliation-report] tick failed: ${e.stack || e.message}`),
    );
  }, interval);
  console.log(`Reconciliation report service started (every ${Math.round(interval / 1000)}s)`);
}

module.exports = {
  startReconciliationReport,
  runReconciliationReports,
  runReconciliationReport,
  resolveFrequencyDays,
  getReportStatus,
  buildReconciliationSections,
  renderReconciliationFiles,
  RECON_KEY,
  FREQ_KEY,
};
