'use strict';

// Ref 48 (pending installation follow-up reporting), Stage A — surfaces
// registration codes (server/routes/registration-codes.js) that were generated
// ahead of an install but never claimed by a device. Two categories, both about
// a started-but-not-finished installation:
//
//   pending    - status 'unused', NOT yet past expires_at, but generated more
//                than `graceDays` ago. Someone cut a code for a device and it
//                still has runway before the 30-day expiry, but nothing has
//                activated against it. The grace period keeps a code cut an
//                hour ago out of the report; it is deliberately far shorter
//                than the expiry so there is still real time to act.
//
//   abandoned  - status 'unused' and now past expires_at: the whole 30-day
//                window lapsed without a single claim. A genuinely failed /
//                dropped install attempt - distinct from "still pending"
//                because nothing more happens on this code without staff
//                regenerating it.
//
// A 'claimed' code is never flagged (the install succeeded). A code with a NULL
// expires_at (legacy rows minted before the TTL existed) can be pending but is
// never abandoned. Scoped per workspace - callers iterate workspaces.
//
// registration_codes.created_at / expires_at are epoch SECONDS (BIGINT
// UNIX_TIMESTAMP()), the convention for that table.

const config = require('../config');

// One workspace's pending-installation snapshot.
//   workspaceId - required
//   now         - Date | epoch-ms | epoch-seconds (default: Date.now())
//   graceDays   - override the config default (used by tests)
async function getPendingInstallations(
  db,
  { workspaceId, now = Date.now(), graceDays = config.pendingInstallationGraceDays } = {},
) {
  if (!workspaceId) throw new Error('getPendingInstallations requires a workspaceId');

  const nowSec = toEpochSec(now);
  const graceBefore = nowSec - Math.round(graceDays * 86400);

  const pendingRows = await db
    .prepare(
      `SELECT id, code, planned_device_name, created_by, created_at, expires_at
         FROM registration_codes
        WHERE workspace_id = ?
          AND status = 'unused'
          AND created_at <= ?
          AND (expires_at IS NULL OR expires_at > ?)
        ORDER BY created_at ASC, id ASC`,
    )
    .all(workspaceId, graceBefore, nowSec);

  const abandonedRows = await db
    .prepare(
      `SELECT id, code, planned_device_name, created_by, created_at, expires_at
         FROM registration_codes
        WHERE workspace_id = ?
          AND status = 'unused'
          AND expires_at IS NOT NULL
          AND expires_at <= ?
        ORDER BY expires_at ASC, id ASC`,
    )
    .all(workspaceId, nowSec);

  return {
    workspace_id: workspaceId,
    generated_at: nowSec,
    grace_days: graceDays,
    pending: pendingRows.map((r) => shape(r, nowSec)),
    abandoned: abandonedRows.map((r) => shape(r, nowSec)),
  };
}

function shape(r, nowSec) {
  const createdAt = numOrNull(r.created_at);
  const expiresAt = numOrNull(r.expires_at);
  return {
    code_id: r.id,
    code: r.code,
    planned_device_name: r.planned_device_name || null,
    created_by: r.created_by,
    created_at: createdAt,
    expires_at: expiresAt,
    days_pending: createdAt == null ? null : Math.floor((nowSec - createdAt) / 86400),
    // >0 for a pending code (time left to act); <=0 for an abandoned one.
    days_until_expiry: expiresAt == null ? null : Math.ceil((expiresAt - nowSec) / 86400),
  };
}

function toEpochSec(t) {
  if (t instanceof Date) return Math.floor(t.getTime() / 1000);
  const n = Number(t);
  return n > 1e11 ? Math.floor(n / 1000) : Math.floor(n);
}
function numOrNull(v) {
  return v == null ? null : Number(v);
}

module.exports = { getPendingInstallations };
