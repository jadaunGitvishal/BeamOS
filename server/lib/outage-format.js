'use strict';

// Small shared helpers for the outage sweeps (services/outage-escalation.js and
// services/sla-breach-ticket.js). They live here, not in either service, so the
// two services don't have to require each other (Stage B made that a cycle).

// MySQL ER_DUP_ENTRY (1062) / better-sqlite3 SQLITE_CONSTRAINT_* — the unique
// constraint firing is the expected "another tick already claimed this" path
// for the claim-by-INSERT idempotency pattern.
function isDuplicateKeyError(e) {
  const s = `${e && e.code} ${e && e.message}`;
  return /ER_DUP_ENTRY|SQLITE_CONSTRAINT|Duplicate entry|UNIQUE constraint failed/i.test(s);
}

// Seconds -> compact human span: "45m", "3h", "3h 20m", "2d 4h".
function humanOutage(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h >= 1) return m ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

module.exports = { isDuplicateKeyError, humanOutage };
