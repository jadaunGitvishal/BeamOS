'use strict';

// Ref 48 (pending installation follow-up reporting), Stage A — a per-workspace
// report that surfaces registration codes generated ahead of an install that
// were never claimed (pending and abandoned; see lib/pending-installations.js)
// and emails a PDF + XLSX, exactly like the Ref 49 reconciliation report.
//
// SCHEDULING is the SAME watermark-based sweep as services/reconciliation-report.js
// / services/report-digest.js: a short-interval tick asks "have
// `pending_installation_report_frequency_days` days passed since the last send?"
// - a single 'YYYY-MM-DD' watermark in app_settings
// (pending_installation_report_through) makes it idempotent and restart-safe.
// The cadence is admin-configurable to ANY integer via the app_settings key
// `pending_installation_report_frequency_days` (config.js supplies the default).
//
// DELIVERY goes to each workspace_admin AND to the creator ("installer") of any
// flagged code - the person who started that installation and can act on it -
// even when that person is not a workspace_admin. Recipients are de-duplicated
// by email. A workspace with nothing pending / abandoned (or with no one to
// notify) is skipped. All dates are UTC.

const { db: defaultDb } = require('../db/database');
const defaultEmail = require('./email');
const config = require('../config');
const { getPendingInstallations } = require('../lib/pending-installations');
const { renderSectionedPdf, renderSectionedXlsx } = require('../lib/report-export');
const { resolveWorkspaceAdmins } = require('./report-digest');

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PENDING_KEY = 'pending_installation_report_through'; // 'YYYY-MM-DD' of the last run
const FREQ_KEY = 'pending_installation_report_frequency_days';

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
function fmtTs(sec, fallback = 'unknown') {
  if (!sec) return fallback;
  return new Date(Number(sec) * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}
function daysLabel(n) {
  if (n == null) return 'n/a';
  return `${n} day${n === 1 ? '' : 's'}`;
}

// ---- settings watermark (identical to the sibling reports' proven helpers) --

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
  const n = raw == null ? config.pendingInstallationFrequencyDays : parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1
    ? Math.floor(n)
    : Math.max(1, config.pendingInstallationFrequencyDays);
}

// Scheduling state, for surfaces that show WHEN the next report fires without
// triggering a send. Mirrors reconciliation-report.getReportStatus().
async function getReportStatus(db, now = new Date()) {
  const freqDays = await resolveFrequencyDays(db);
  const last = await getSetting(db, PENDING_KEY);
  let nextDate = null;
  let overdue = false;
  if (last) {
    const d = new Date(last + 'T00:00:00.000Z');
    d.setUTCDate(d.getUTCDate() + freqDays);
    nextDate = ymd(d);
    overdue = daysBetween(last, ymd(now)) >= freqDays;
  }
  return { frequency_days: freqDays, last_report_date: last, next_report_date: nextDate, overdue };
}

// ---- recipients -------------------------------------------------------

// The installers: the distinct creators of the flagged codes, resolved to an
// { email, name } list. A creator with no usable email is dropped.
async function resolveInstallers(db, codeRows) {
  const ids = [...new Set(codeRows.map((r) => r.created_by).filter(Boolean))];
  if (!ids.length) return [];
  return db
    .prepare(
      `SELECT DISTINCT u.email, u.name FROM users u
        WHERE u.id IN (${ids.map(() => '?').join(',')})
          AND u.email IS NOT NULL AND u.email <> ''`,
    )
    .all(...ids);
}

// Merge recipient lists, first occurrence wins, de-duplicated case-insensitively
// by email (an admin who also cut a code gets one email, not two).
function dedupeRecipients(...lists) {
  const seen = new Set();
  const out = [];
  for (const r of lists.flat()) {
    const key = String(r.email || '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

// ---- report rendering -------------------------------------------------

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
function buildPendingSections(data) {
  const pendingRows = data.pending.map((p) => [
    p.code,
    p.planned_device_name || '(unnamed)',
    daysLabel(p.days_pending),
    fmtTs(p.expires_at, 'no expiry'),
    p.days_until_expiry == null ? 'no expiry' : daysLabel(Math.max(0, p.days_until_expiry)),
  ]);
  if (!pendingRows.length) {
    pendingRows.push(['(none — every recent code has been activated or has expired)', '', '', '', '']);
  }

  const abandonedRows = data.abandoned.map((a) => [
    a.code,
    a.planned_device_name || '(unnamed)',
    fmtTs(a.created_at, 'unknown'),
    fmtTs(a.expires_at, 'unknown'),
  ]);
  if (!abandonedRows.length) {
    abandonedRows.push(['(none — no code expired unclaimed)', '', '', '']);
  }

  return [
    {
      heading: `Pending Installations (code generated > ${data.grace_days}d ago, no device activated)`,
      headers: ['Code', 'Planned Device', 'Pending For', 'Expires', 'Time Left'],
      rows: pendingRows,
    },
    {
      heading: 'Abandoned Installations (expired, never activated)',
      headers: ['Code', 'Planned Device', 'Generated', 'Expired'],
      rows: abandonedRows,
    },
  ];
}

async function renderPendingFiles(workspaceName, dayStr, data) {
  const title =
    `Pending Installations — ${workspaceName} — ${dayStr}   ` +
    `(${data.pending.length} pending · ${data.abandoned.length} abandoned)`;
  const sections = buildPendingSections(data);
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

function summaryLines(data, limit = 10) {
  const lines = [];
  const p = data.pending.slice(0, limit);
  const a = data.abandoned.slice(0, limit);
  if (p.length) {
    lines.push('', `Pending (awaiting activation): ${data.pending.length}`);
    for (const c of p) {
      lines.push(
        `  - code ${c.code}${c.planned_device_name ? ` ("${c.planned_device_name}")` : ''}: ` +
          `pending ${daysLabel(c.days_pending)}, expires ${fmtTs(c.expires_at, 'no expiry')}` +
          `${c.days_until_expiry == null ? '' : ` (${daysLabel(Math.max(0, c.days_until_expiry))} left to act)`}`,
      );
    }
    if (data.pending.length > p.length) {
      lines.push(`  ... and ${data.pending.length - p.length} more (see attachment)`);
    }
  }
  if (a.length) {
    lines.push('', `Abandoned (expired, never activated): ${data.abandoned.length}`);
    for (const c of a) {
      lines.push(
        `  - code ${c.code}${c.planned_device_name ? ` ("${c.planned_device_name}")` : ''}: ` +
          `generated ${fmtTs(c.created_at, 'unknown')}, expired ${fmtTs(c.expires_at, 'unknown')}`,
      );
    }
    if (data.abandoned.length > a.length) {
      lines.push(`  ... and ${data.abandoned.length - a.length} more (see attachment)`);
    }
  }
  return lines;
}

// ---- core -----------------------------------------------------------

async function runPendingInstallationReport(db, email, now) {
  const today = ymd(now);
  const freqDays = await resolveFrequencyDays(db);
  const last = await getSetting(db, PENDING_KEY);

  if (last && daysBetween(last, today) < freqDays) {
    return { ran: false, today, freqDays, sent: 0, workspacesWithFindings: 0 };
  }

  const workspaces = await db.prepare('SELECT id, name FROM workspaces').all();
  let sent = 0;
  let workspacesWithFindings = 0;

  for (const ws of workspaces) {
    try {
      const data = await getPendingInstallations(db, { workspaceId: ws.id, now });
      if (!data.pending.length && !data.abandoned.length) continue;
      workspacesWithFindings++;

      const flagged = [...data.pending, ...data.abandoned];
      const recipients = dedupeRecipients(
        await resolveWorkspaceAdmins(db, ws.id),
        await resolveInstallers(db, flagged),
      );
      if (!recipients.length) {
        console.warn(
          `[pending-installation-report] workspace ${ws.id} has ${data.pending.length} pending / ` +
            `${data.abandoned.length} abandoned code(s) but no admin or reachable creator to notify`,
        );
        continue;
      }

      const { pdf, xlsx } = await renderPendingFiles(ws.name, today, data);
      const base = `pending-installations-${slug(ws.name)}-${today}`;

      for (const r of recipients) {
        await email.sendEmail({
          to: r.email,
          subject: `Pending installations — ${ws.name} — ${today}`,
          text:
            `Attached (PDF + Excel) is the pending-installation report for "${ws.name}" as of ${today} (UTC).\n\n` +
            `${data.pending.length} installation(s) are still pending (a registration code was generated ` +
            `more than ${data.grace_days} day(s) ago but no device has been activated against it) and ` +
            `${data.abandoned.length} code(s) expired without ever being activated.` +
            summaryLines(data).join('\n') +
            `\n\nThis report runs every ${freqDays} day(s) (Settings › pending_installation_report_frequency_days).`,
          attachments: reportAttachments(base, pdf, xlsx),
        });
        sent++;
      }
    } catch (e) {
      console.error(`[pending-installation-report] workspace ${ws.id} failed: ${e.message}`);
    }
  }

  await setSetting(db, PENDING_KEY, today);
  console.log(
    `[pending-installation-report] ${today} (every ${freqDays}d): ${sent} email(s) (pdf+xlsx) across ` +
      `${workspacesWithFindings}/${workspaces.length} workspace(s) with findings`,
  );
  return { ran: true, today, freqDays, sent, workspacesWithFindings };
}

// Testable wrapper: never throws, always logs exactly one tick summary line so a
// healthy "nothing due" tick is distinguishable from a dead service.
async function runPendingInstallationReports(db = defaultDb, email = defaultEmail, opts = {}) {
  const now = opts.now ? new Date(opts.now) : new Date();
  let result;
  try {
    result = await runPendingInstallationReport(db, email, now);
  } catch (e) {
    console.error(`[pending-installation-report] run failed: ${e.stack || e.message}`);
    result = { ran: false, today: null, sent: 0, error: e.message };
  }
  const part = result.error
    ? `error (${result.error})`
    : result.ran
      ? `sent ${result.sent} (pdf+xlsx)`
      : 'skipped';
  console.log(`[pending-installation-report] tick: ${part}`);
  return result;
}

function startPendingInstallationReport() {
  const interval = config.pendingInstallationReportIntervalMs;
  setInterval(() => {
    runPendingInstallationReports().catch((e) =>
      console.error(`[pending-installation-report] tick failed: ${e.stack || e.message}`),
    );
  }, interval);
  console.log(
    `Pending installation report service started (every ${Math.round(interval / 1000)}s)`,
  );
}

module.exports = {
  startPendingInstallationReport,
  runPendingInstallationReports,
  runPendingInstallationReport,
  resolveFrequencyDays,
  getReportStatus,
  resolveInstallers,
  dedupeRecipients,
  buildPendingSections,
  renderPendingFiles,
  PENDING_KEY,
  FREQ_KEY,
};
