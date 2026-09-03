'use strict';

// Ref 51 (SLA Dashboard) Step 2+3 — automated SLA breach escalation emails.
//
// Every OUTAGE_ESCALATION_INTERVAL_MS (default 15 min) this sweep:
//   1. runs the SHARED detector (lib/outage-detection.js — the identical LAG/LEAD
//      query GET /sla-overview and the outage recorder use) to find CURRENT
//      ongoing outages (outage_end === null) platform-wide;
//   2. keeps only those already past the escalation threshold
//      (sla_escalation_threshold_hours from app_settings, config fallback);
//   3. for each, checks outage_escalations for a row matching
//      (device_id, outage_start) — present means "already alerted for THIS
//      incident", skip;
//   4. otherwise: resolves the device workspace's workspace_admin(s) (same
//      resolveWorkspaceAdmins() report-digest.js uses), CLAIMS the escalation by
//      inserting the outage_escalations row (the UNIQUE (device_id, outage_start)
//      constraint is the real anti-spam guard — claim-before-send so a
//      concurrent tick or a mid-send crash can't double-mail), then emails each
//      admin via the shared sendEmail().
//
// A device that recovers and breaks again gets a NEW outage_start from the
// detector, so a fresh escalation correctly fires — that is a genuinely new
// incident, by design.
//
// Follows report-digest.js / screenshot-scheduler.js / outage-history.js:
// setInterval, async tick, .catch-guarded, timer.unref(), started in
// server.js boot(). Never throws out of runOutageEscalations(). Always logs a
// one-line tick summary, healthy or not, so a dead sweep is visible in the logs.

const { db: defaultDb } = require('../db/database');
const config = require('../config');
const appSettings = require('../lib/app-settings');
const { detectOutages } = require('../lib/outage-detection');
const { sendEmail: defaultSendEmail } = require('./email');
const { resolveWorkspaceAdmins } = require('./report-digest');
const { buildAlertHtml } = require('./alerts');
const { autoCreateBreachTickets } = require('./sla-breach-ticket');
const { isDuplicateKeyError, humanOutage } = require('../lib/outage-format');

function deviceUrl(deviceId) {
  return `${config.publicBaseUrl}/dashboard#/device/${encodeURIComponent(deviceId)}`;
}

// Testable core. Injectables: `dbh` (defaults to shared pool handle),
// `opts.now` (ms|Date), `opts.thresholdHours`, `opts.sendEmail`.
// Returns { ongoing, breaching, sent, skipped, noRecipients, autoTickets }.
// Never throws. autoTickets is the Phase 4 Stage B ticket sweep's result
// ({ breaching, created, skipped, resolved }); it runs off the SAME detector
// pass and is guarded independently so a ticketing failure can't stop emails.
async function runOutageEscalations(dbh = defaultDb, opts = {}) {
  const sendEmail = opts.sendEmail || defaultSendEmail;
  const nowSec = Math.floor((opts.now ? new Date(opts.now).getTime() : Date.now()) / 1000);
  const thresholdHours =
    opts.thresholdHours != null
      ? opts.thresholdHours
      : appSettings.getNum('sla_escalation_threshold_hours', config.slaEscalationThresholdHours);
  const thresholdSec = thresholdHours * 3600;
  // An ongoing outage's transition rows are recent by definition; scan the
  // status-log retention horizon so none is missed.
  const sinceEpoch = nowSec - Math.round(config.statusLogRetentionDays * 86400);

  let ongoing = 0;
  let breaching = 0;
  let sent = 0;
  let skipped = 0;
  let noRecipients = 0;
  let autoTickets = { breaching: 0, created: 0, skipped: 0, resolved: 0 };

  try {
    const outages = await detectOutages(dbh, { sinceEpoch, untilEpoch: nowSec });

    // Phase 4 Stage B: open a ticket for each fresh live breach, and resolve
    // any untouched auto-ticket whose outage has recovered — off THIS detector
    // result, not a second scan. Independently guarded: a ticketing error is
    // logged and swallowed so it can never block the escalation emails below.
    try {
      autoTickets = await autoCreateBreachTickets(dbh, outages, { nowSec, thresholdSec, sinceEpoch });
      if (autoTickets.created || autoTickets.resolved) {
        console.log(
          `[sla-breach-ticket] tick: ${autoTickets.created} ticket(s) opened, ` +
            `${autoTickets.resolved} auto-resolved on recovery` +
            (autoTickets.skipped ? `, ${autoTickets.skipped} already open` : ''),
        );
      }
    } catch (e) {
      console.error(`[sla-breach-ticket] tick failed: ${e.stack || e.message}`);
    }

    const live = outages.filter((o) => o.outage_end == null && o.workspace_id != null);
    ongoing = live.length;

    const breaches = live.filter((o) => nowSec - o.outage_start > thresholdSec);
    breaching = breaches.length;
    if (breaches.length === 0) {
      console.log(
        `[outage-escalation] tick: ${ongoing} ongoing outage(s), 0 past the ${thresholdHours}h threshold`,
      );
      return { ongoing, breaching, sent, skipped, noRecipients, autoTickets };
    }

    // Prefilter: which (device_id, outage_start) are already escalated.
    const known = new Set(
      (
        await dbh
          .prepare('SELECT device_id, outage_start FROM outage_escalations WHERE outage_start >= ?')
          .all(sinceEpoch)
      ).map((r) => `${r.device_id} ${r.outage_start}`),
    );

    const claim = dbh.prepare(
      'INSERT INTO outage_escalations (device_id, workspace_id, outage_start, recipient_email) VALUES (?, ?, ?, ?)',
    );

    for (const o of breaches) {
      if (known.has(`${o.device_id} ${o.outage_start}`)) {
        skipped++;
        continue;
      }

      const dev = await dbh.prepare('SELECT name FROM devices WHERE id = ?').get(o.device_id);
      const deviceName = (dev && dev.name) || o.device_id;
      const admins = await resolveWorkspaceAdmins(dbh, o.workspace_id);
      if (!admins.length) {
        // No one to tell — don't claim, so a later tick can still escalate once
        // an admin is added to the workspace.
        noRecipients++;
        continue;
      }

      const recipients = admins.map((a) => a.email);
      // Claim BEFORE sending: the UNIQUE constraint makes this the atomic
      // "this incident is now escalated" flag. A dup here means a concurrent
      // tick beat us — treat as already-alerted.
      try {
        await claim.run(o.device_id, o.workspace_id, o.outage_start, recipients.join(', ').slice(0, 500));
      } catch (e) {
        if (isDuplicateKeyError(e)) {
          skipped++;
          continue;
        }
        throw e;
      }

      const offlineFor = humanOutage(nowSec - o.outage_start);
      const subject = `SLA Breach: ${deviceName} offline for ${offlineFor}`;
      const since = new Date(o.outage_start * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
      const body =
        `Display "${deviceName}" has been offline for ${offlineFor}, past the ` +
        `${thresholdHours}h SLA escalation threshold.\n\n` +
        `Outage started: ${since}\n` +
        `Device page: ${deviceUrl(o.device_id)}\n\n` +
        `This is an automated SLA alert. You will not get another email for this ` +
        `same outage; if the device recovers and breaks again, that is a new incident.`;

      for (const admin of admins) {
        await sendEmail({
          to: admin.email,
          subject,
          text: body,
          html: buildAlertHtml(admin.name, subject, body),
        }).catch((err) =>
          console.error(`[outage-escalation] sendEmail rejected unexpectedly for ${admin.email}: ${err.message}`),
        );
      }
      sent++;
    }

    console.log(
      `[outage-escalation] tick: ${sent} new alert(s) sent, ${skipped} already-alerted skipped` +
        (noRecipients ? `, ${noRecipients} with no workspace_admin` : '') +
        ` (${breaching} of ${ongoing} ongoing outage(s) past the ${thresholdHours}h threshold)`,
    );
  } catch (e) {
    console.error(`[outage-escalation] tick failed: ${e.stack || e.message}`);
  }

  return { ongoing, breaching, sent, skipped, noRecipients, autoTickets };
}

function startOutageEscalations() {
  const interval = config.outageEscalationIntervalMs;
  const timer = setInterval(() => {
    runOutageEscalations().catch((e) =>
      console.error(`[outage-escalation] tick failed: ${e.stack || e.message}`),
    );
  }, interval);
  if (timer.unref) timer.unref();
  console.log(`Outage escalation service started (every ${Math.round(interval / 1000)}s)`);
  return timer;
}

module.exports = { startOutageEscalations, runOutageEscalations, isDuplicateKeyError, humanOutage };
