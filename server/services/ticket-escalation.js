'use strict';

// Ref 58 — ticket response-time SLA escalation emails.
//
// Every TICKET_ESCALATION_INTERVAL_MS (default 15 min, same cadence as
// outage-escalation.js) this sweep:
//   1. loads every OPEN / IN_PROGRESS ticket platform-wide;
//   2. computes each one's response_status via the SAME function the tickets
//      API and OperationsView use (lib/ticket-sla.js ticketResponseStatus) -
//      no separate threshold lives here, so a ticket escalates exactly when
//      the UI would show it as "Breached", never a different moment;
//   3. for each breaching ticket not already in ticket_escalations, CLAIMS it
//      (INSERT, ticket_id UNIQUE - claim-before-send so a concurrent tick or a
//      mid-send crash can't double-mail), then emails the ticket's workspace's
//      workspace_admin(s) via the shared sendEmail(). Unlike outage escalation,
//      this claim is keyed on ticket_id ALONE and is permanent: a ticket is
//      escalated at most once, ever (see schema.sql's ticket_escalations note
//      for why a ticket has no equivalent to an outage's fresh outage_start).
//
// Follows outage-escalation.js's shape deliberately (same claim-then-send
// idempotency pattern, same never-throws contract, same one-line tick log).
// A SEPARATE service/table from outage-escalation, not folded into its tick:
// that sweep is keyed off detectOutages() (device connectivity), this one off
// ticket response_status (a ticket-table read) - different trigger, different
// data source, no shared detector pass to reuse.

const config = require('../config');
const { db: defaultDb } = require('../db/database');
const { ticketResponseStatus } = require('../lib/ticket-sla');
const { sendEmail: defaultSendEmail } = require('./email');
const { resolveWorkspaceAdmins } = require('./report-digest');
const { buildAlertHtml } = require('./alerts');
const { isDuplicateKeyError, humanOutage } = require('../lib/outage-format');

function ticketUrl() {
  return `${config.publicBaseUrl}/dashboard#/operations`;
}

// Testable core. Injectables: `dbh` (defaults to shared pool handle),
// `opts.now` (ms|Date), `opts.sendEmail`.
// Returns { open, breaching, sent, skipped, noRecipients }. Never throws.
async function runTicketEscalations(dbh = defaultDb, opts = {}) {
  const sendEmail = opts.sendEmail || defaultSendEmail;
  const nowSec = Math.floor((opts.now ? new Date(opts.now).getTime() : Date.now()) / 1000);

  let open = 0;
  let breaching = 0;
  let sent = 0;
  let skipped = 0;
  let noRecipients = 0;

  try {
    const tickets = await dbh
      .prepare(
        `SELECT id, workspace_id, title, priority, status, created_at
           FROM tickets WHERE status IN ('open', 'in_progress')`,
      )
      .all();
    open = tickets.length;

    const breaches = tickets.filter((t) => ticketResponseStatus(t, nowSec) === 'breached');
    breaching = breaches.length;
    if (breaches.length === 0) {
      console.log(`[ticket-escalation] tick: ${open} open ticket(s), 0 breached`);
      return { open, breaching, sent, skipped, noRecipients };
    }

    // Prefilter: which of THESE tickets are already escalated (permanent claim
    // - no time bound, unlike outage_escalations' outage_start window).
    const known = new Set(
      (
        await dbh
          .prepare(
            `SELECT ticket_id FROM ticket_escalations WHERE ticket_id IN (${breaches.map(() => '?').join(',')})`,
          )
          .all(...breaches.map((t) => t.id))
      ).map((r) => r.ticket_id),
    );

    const claim = dbh.prepare(
      'INSERT INTO ticket_escalations (ticket_id, workspace_id, recipient_email) VALUES (?, ?, ?)',
    );

    for (const t of breaches) {
      if (known.has(t.id)) {
        skipped++;
        continue;
      }

      const admins = await resolveWorkspaceAdmins(dbh, t.workspace_id);
      if (!admins.length) {
        // No one to tell — don't claim, so a later tick can still escalate once
        // an admin is added to the workspace.
        noRecipients++;
        continue;
      }

      const recipients = admins.map((a) => a.email);
      // Claim BEFORE sending: the UNIQUE constraint makes this the atomic
      // "this ticket is now escalated" flag. A dup here means a concurrent
      // tick beat us — treat as already-alerted.
      try {
        await claim.run(t.id, t.workspace_id, recipients.join(', ').slice(0, 500));
      } catch (e) {
        if (isDuplicateKeyError(e)) {
          skipped++;
          continue;
        }
        throw e;
      }

      const openFor = humanOutage(nowSec - t.created_at);
      const subject = `Ticket SLA breach: ${t.title}`;
      const body =
        `Ticket "${t.title}" (priority: ${t.priority}) has been open for ${openFor}, past its ` +
        `response-time target.\n\n` +
        `Operations queue: ${ticketUrl()}\n\n` +
        `This is an automated SLA alert. You will not get another email for this same ticket.`;

      for (const admin of admins) {
        await sendEmail({
          to: admin.email,
          subject,
          text: body,
          html: buildAlertHtml(admin.name, subject, body),
        }).catch((err) =>
          console.error(`[ticket-escalation] sendEmail rejected unexpectedly for ${admin.email}: ${err.message}`),
        );
      }
      sent++;
    }

    console.log(
      `[ticket-escalation] tick: ${sent} new alert(s) sent, ${skipped} already-alerted skipped` +
        (noRecipients ? `, ${noRecipients} with no workspace_admin` : '') +
        ` (${breaching} of ${open} open ticket(s) breached)`,
    );
  } catch (e) {
    console.error(`[ticket-escalation] tick failed: ${e.stack || e.message}`);
  }

  return { open, breaching, sent, skipped, noRecipients };
}

function startTicketEscalations() {
  const interval = config.ticketEscalationIntervalMs;
  const timer = setInterval(() => {
    runTicketEscalations().catch((e) =>
      console.error(`[ticket-escalation] tick failed: ${e.stack || e.message}`),
    );
  }, interval);
  if (timer.unref) timer.unref();
  console.log(`Ticket escalation service started (every ${Math.round(interval / 1000)}s)`);
  return timer;
}

module.exports = { startTicketEscalations, runTicketEscalations };
