'use strict';

// Ref 52 — 30-day-prior warranty-expiry alert emails.
//
// Every WARRANTY_ALERT_INTERVAL_MS (default 1h) this sweep:
//   1. finds every device with a warranty_expiry_date set, not already past,
//      and within `warranty_alert_days_before` days of expiring
//      (config.warrantyAlertDaysBefore, default 30);
//   2. for each, checks warranty_alerts for a row matching (device_id,
//      warranty_expiry_date) - present means "already alerted for THIS expiry
//      date", skip;
//   3. otherwise: resolves the device workspace's workspace_admin(s) (same
//      resolveWorkspaceAdmins() report-digest.js uses), CLAIMS the alert by
//      inserting the warranty_alerts row (the UNIQUE (device_id,
//      warranty_expiry_date) constraint is the real anti-spam guard -
//      claim-before-send so a concurrent tick or a mid-send crash can't
//      double-mail), then emails each admin via the shared sendEmail().
//
// A device stays within the 30-day window for 30 daily ticks, but the claimed
// row means it is only ever emailed ONCE per expiry date - not once per tick.
// If a technician later changes warranty_expiry_date (e.g. the warranty gets
// renewed, or a wrong date gets corrected), that is a NEW date and a fresh
// alert correctly fires when it re-enters the window - the same "recover then
// re-break" reasoning outage-escalation.js applies to a new outage_start.
//
// Follows outage-escalation.js exactly: setInterval, async tick,
// .catch-guarded, timer.unref(), started in server.js boot(). Never throws
// out of runWarrantyAlerts(). Always logs a one-line tick summary, healthy or
// not, so a dead sweep is visible in the logs.

const { db: defaultDb } = require('../db/database');
const config = require('../config');
const { sendEmail: defaultSendEmail } = require('./email');
const { resolveWorkspaceAdmins } = require('./report-digest');
const { buildAlertHtml } = require('./alerts');
const { isDuplicateKeyError } = require('../lib/outage-format');

function deviceUrl(deviceId) {
  return `${config.publicBaseUrl}/dashboard#/device/${encodeURIComponent(deviceId)}`;
}

function daysLabel(n) {
  return `${n} day${n === 1 ? '' : 's'}`;
}

// Testable core. Injectables: `dbh` (defaults to shared pool handle),
// `opts.now` (ms|Date), `opts.daysBefore`, `opts.sendEmail`.
// Returns { candidates, sent, skipped, noRecipients }. Never throws.
async function runWarrantyAlerts(dbh = defaultDb, opts = {}) {
  const sendEmail = opts.sendEmail || defaultSendEmail;
  const now = opts.now ? new Date(opts.now) : new Date();
  const today = now.toISOString().slice(0, 10);
  const daysBefore =
    opts.daysBefore != null ? opts.daysBefore : config.warrantyAlertDaysBefore;

  let candidates = 0;
  let sent = 0;
  let skipped = 0;
  let noRecipients = 0;

  try {
    // Devices whose warranty hasn't lapsed yet AND falls within the window.
    // DATEDIFF(expiry, today) <= daysBefore, AND expiry >= today so an
    // ALREADY-expired device is never treated as "newly 30 days out".
    const devices = await dbh
      .prepare(
        `SELECT id, name, workspace_id, warranty_expiry_date
           FROM devices
          WHERE warranty_expiry_date IS NOT NULL
            AND workspace_id IS NOT NULL
            AND warranty_expiry_date >= ?
            AND DATEDIFF(warranty_expiry_date, ?) <= ?`,
      )
      .all(today, today, daysBefore);
    candidates = devices.length;

    if (devices.length === 0) {
      console.log(`[warranty-alert] tick: 0 device(s) within ${daysLabel(daysBefore)} of warranty expiry`);
      return { candidates, sent, skipped, noRecipients };
    }

    // Prefilter: which (device_id, warranty_expiry_date) are already alerted.
    const known = new Set(
      (
        await dbh
          .prepare('SELECT device_id, warranty_expiry_date FROM warranty_alerts WHERE warranty_expiry_date >= ?')
          .all(today)
      ).map((r) => `${r.device_id} ${r.warranty_expiry_date}`),
    );

    const claim = dbh.prepare(
      'INSERT INTO warranty_alerts (device_id, workspace_id, warranty_expiry_date, recipient_email) VALUES (?, ?, ?, ?)',
    );

    for (const d of devices) {
      const key = `${d.id} ${d.warranty_expiry_date}`;
      if (known.has(key)) {
        skipped++;
        continue;
      }

      const admins = await resolveWorkspaceAdmins(dbh, d.workspace_id);
      if (!admins.length) {
        // No one to tell - don't claim, so a later tick can still alert once
        // an admin is added to the workspace.
        noRecipients++;
        continue;
      }

      const recipients = admins.map((a) => a.email);
      // Claim BEFORE sending: the UNIQUE constraint makes this the atomic
      // "this expiry is now alerted" flag. A dup here means a concurrent
      // tick beat us - treat as already-alerted.
      try {
        await claim.run(d.id, d.workspace_id, d.warranty_expiry_date, recipients.join(', ').slice(0, 500));
      } catch (e) {
        if (isDuplicateKeyError(e)) {
          skipped++;
          continue;
        }
        throw e;
      }

      const daysLeft = Math.round(
        (Date.parse(d.warranty_expiry_date + 'T00:00:00.000Z') - Date.parse(today + 'T00:00:00.000Z')) / 86400000,
      );
      const subject = `Warranty Expiring Soon: ${d.name}`;
      const body =
        `Display "${d.name}" is under warranty until ${d.warranty_expiry_date}, ` +
        `${daysLabel(daysLeft)} from today.\n\n` +
        `Device page: ${deviceUrl(d.id)}\n\n` +
        `This is an automated warranty alert. You will not get another email for ` +
        `this same expiry date; if the warranty is renewed or corrected to a new ` +
        `date, that will alert again on its own schedule.`;

      for (const admin of admins) {
        await sendEmail({
          to: admin.email,
          subject,
          text: body,
          html: buildAlertHtml(admin.name, subject, body),
        }).catch((err) =>
          console.error(`[warranty-alert] sendEmail rejected unexpectedly for ${admin.email}: ${err.message}`),
        );
      }
      sent++;
    }

    console.log(
      `[warranty-alert] tick: ${sent} new alert(s) sent, ${skipped} already-alerted skipped` +
        (noRecipients ? `, ${noRecipients} with no workspace_admin` : '') +
        ` (${candidates} device(s) within ${daysLabel(daysBefore)})`,
    );
  } catch (e) {
    console.error(`[warranty-alert] tick failed: ${e.stack || e.message}`);
  }

  return { candidates, sent, skipped, noRecipients };
}

function startWarrantyAlerts() {
  const interval = config.warrantyAlertIntervalMs;
  const timer = setInterval(() => {
    runWarrantyAlerts().catch((e) => console.error(`[warranty-alert] tick failed: ${e.stack || e.message}`));
  }, interval);
  if (timer.unref) timer.unref();
  console.log(`Warranty alert service started (every ${Math.round(interval / 1000)}s)`);
  return timer;
}

module.exports = { startWarrantyAlerts, runWarrantyAlerts };
