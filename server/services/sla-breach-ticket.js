'use strict';

// Phase 4 Stage B — auto-open a ticket when a live SLA breach is detected.
//
// This is NOT a separate scheduled service. It runs inside the existing
// outage-escalation tick (services/outage-escalation.js), which already:
//   - runs the shared detectOutages() detector once per tick, and
//   - computes exactly the "live outage past the SLA breach threshold" set that
//     a ticket should be opened for.
// Reason for folding in rather than a second setInterval: the two actions share
// one trigger. A second sweep on its own timer would call detectOutages() a
// second time and could observe a slightly different world (one tick at :00,
// the other at :07) — the same drift the "one detector, used verbatim" rule in
// lib/outage-detection.js exists to prevent. Keeping the logic in its own module
// (own try/catch at the call site, own tests) keeps the concerns separable
// without a second scan.
//
// Idempotency mirrors outage_escalations exactly: (device_id, source_outage_start)
// is a UNIQUE key on `tickets`. We prefilter against it, then claim-by-INSERT and
// treat a duplicate-key error as "another tick already opened this one".
//
// Auto-resolve on recovery — the flagged design question:
//   A ticket means "a human should look at / track this". Two failure modes:
//     (a) leave it open forever  -> the Operations queue fills with dead items
//         for outages that already fixed themselves; nobody trusts the queue.
//     (b) always auto-resolve    -> a flapping screen's tickets all silently
//         close; the human never sees the pattern; "resolved" (which is meant
//         to mean "someone dealt with it") gets diluted.
//   Chosen middle path: auto-resolve ONLY a ticket that is still untouched —
//   auto_source='sla_breach', still status='open', still created_by IS NULL.
//   The moment a human moves it off 'open' (starts work, closes it, whatever)
//   it is theirs and the sweep never touches it again. resolved_at is stamped
//   with the actual recovery time from the detector, so the history reads true.
//   Each distinct outage still gets its own ticket (new source_outage_start),
//   so a flapping device shows up as N auto-resolved SLA tickets — the pattern
//   is visible in the list even though the queue stays clean.

const crypto = require('crypto');
const config = require('../config');
const { humanOutage, isDuplicateKeyError } = require('../lib/outage-format');

const AUTO_SOURCE = 'sla_breach';

function isoUtcMinute(epochSec) {
  return new Date(epochSec * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

// dbh:     shared pool handle or a transaction-scoped one ({ prepare })
// outages: the FULL detectOutages() result for the tick (ongoing + completed)
// opts:    { nowSec, thresholdSec, sinceEpoch }
// Returns  { breaching, created, skipped, resolved }. Never throws for the
// per-outage cases it expects (duplicate key); a genuine DB error propagates so
// the caller's try/catch logs it.
async function autoCreateBreachTickets(dbh, outages, { nowSec, thresholdSec, sinceEpoch }) {
  const lowerBound =
    sinceEpoch != null
      ? sinceEpoch
      : nowSec - Math.round(config.statusLogRetentionDays * 86400);

  // Live outages, scoped to a workspace, that are past the breach threshold.
  const breaches = outages.filter(
    (o) =>
      o.outage_end == null &&
      o.workspace_id != null &&
      nowSec - o.outage_start > thresholdSec,
  );
  // Completed outages in-window — candidates for auto-resolving their ticket.
  const recovered = outages.filter((o) => o.outage_end != null && o.workspace_id != null);

  let created = 0;
  let skipped = 0;
  let resolved = 0;

  // --- create -------------------------------------------------------------
  const known = new Set(
    (
      await dbh
        .prepare(
          `SELECT device_id, source_outage_start FROM tickets
           WHERE auto_source = ? AND source_outage_start >= ?`,
        )
        .all(AUTO_SOURCE, lowerBound)
    ).map((r) => `${r.device_id} ${r.source_outage_start}`),
  );

  const insert = dbh.prepare(
    `INSERT INTO tickets
       (id, workspace_id, device_id, title, description, owner_category, status, priority, created_by, auto_source, source_outage_start)
     VALUES (?, ?, ?, ?, ?, 'unassigned', 'open', 'high', NULL, ?, ?)`,
  );

  for (const o of breaches) {
    if (known.has(`${o.device_id} ${o.outage_start}`)) {
      skipped++;
      continue;
    }
    const dev = await dbh.prepare('SELECT name FROM devices WHERE id = ?').get(o.device_id);
    const deviceName = (dev && dev.name) || o.device_id;
    const offlineFor = humanOutage(nowSec - o.outage_start);
    const title = `SLA breach: ${deviceName} offline ${offlineFor}`.slice(0, 255);
    const description =
      `Auto-created by SLA monitoring. Display "${deviceName}" has been offline since ` +
      `${isoUtcMinute(o.outage_start)} (${offlineFor} and counting), past the SLA breach threshold.\n\n` +
      `Owner is unassigned pending triage — root cause is not known automatically. ` +
      `This ticket was generated by the system; a human should confirm what happened and close it. ` +
      `If the device recovers before anyone picks this up, the system will resolve it automatically.`;

    try {
      await insert.run(
        crypto.randomUUID(),
        o.workspace_id,
        o.device_id,
        title,
        description,
        AUTO_SOURCE,
        o.outage_start,
      );
      created++;
    } catch (e) {
      if (isDuplicateKeyError(e)) {
        skipped++;
        continue;
      }
      throw e;
    }
  }

  // --- auto-resolve untouched tickets whose outage has recovered ----------
  // resolved_at = the real recovery time; updated_at = now (both passed in, no
  // reliance on a DB-side UNIX_TIMESTAMP()).
  const resolveStmt = dbh.prepare(
    `UPDATE tickets
        SET status = 'resolved', resolved_at = ?, updated_at = ?
      WHERE auto_source = ?
        AND device_id = ?
        AND source_outage_start = ?
        AND status = 'open'
        AND created_by IS NULL`,
  );
  for (const o of recovered) {
    const res = await resolveStmt.run(o.outage_end, nowSec, AUTO_SOURCE, o.device_id, o.outage_start);
    resolved += res.changes ?? res.affectedRows ?? 0;
  }

  return { breaching: breaches.length, created, skipped, resolved };
}

module.exports = { autoCreateBreachTickets, AUTO_SOURCE };
