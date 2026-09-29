'use strict';

// Ref 5/8: the ONE write path for users.deactivated_at, shared by SCIM
// (routes/scim.js - Entra's PATCH active:false / DELETE) and anything added later
// (e.g. an admin UI toggle), so every caller gets the same side effects.
//
// What "deactivate" revokes, and where each is enforced (all per-request reads of
// users.deactivated_at, none cached in a token):
//   - JWT sessions ............. middleware/auth.js requireAuth / optionalAuth
//   - st_ API tokens ........... middleware/apiToken.js apiTokenAuth (acts AS its owner)
//   - Entra SP registrations ... middleware/entraToken.js entraTokenAuth (acts AS created_by)
//   - JWT side doors ........... server.js /api/devices/:id/screenshot,
//                                routes/public-content.js, ws/dashboardSocket.js handshake
//   - new logins ............... routes/auth.js (password, TOTP verify, Google,
//                                Microsoft) and routes/field-auth.js (OTP)
// The one thing a per-request read can't reach is a dashboard socket that is ALREADY
// open (its auth ran once, at handshake) - disconnectUserSockets() closes those here.
//
// Deactivation is reversible and non-destructive: memberships, content, tokens and
// audit history are untouched, so reactivation restores exactly the prior access.

const { logActivity } = require('../services/activity');

// Close every live /dashboard socket authenticated as this user. `io` is the
// socket.io server (req.app.get('io')); optional so library callers without one
// (scripts, tests) still get the DB-level revocation. Returns the count closed.
function disconnectUserSockets(io, userId) {
  if (!io) return 0;
  let n = 0;
  for (const socket of io.of('/dashboard').sockets.values()) {
    if (socket.userId === userId) {
      socket.disconnect(true);
      n++;
    }
  }
  return n;
}

// Set (deactivated=true) or clear (false) users.deactivated_at. Idempotent: an
// already-deactivated user keeps their ORIGINAL deactivated_at timestamp. Returns
// { changed, deactivated_at }. `via` labels the audit row (e.g. 'scim').
async function setUserDeactivated(db, userId, deactivated, { io = null, via = 'admin', actorId = null, ip = null } = {}) {
  const before = await db.prepare('SELECT id, email, deactivated_at FROM users WHERE id = ?').get(userId);
  if (!before) return { changed: false, deactivated_at: null, notFound: true };

  if (deactivated) {
    if (!before.deactivated_at) {
      await db.prepare(
        'UPDATE users SET deactivated_at = UNIX_TIMESTAMP(), updated_at = UNIX_TIMESTAMP() WHERE id = ? AND deactivated_at IS NULL',
      ).run(userId);
    }
    // Close live sockets even on a repeat call - cheap, and covers a socket that
    // somehow survived an earlier call (e.g. a different process handled it).
    disconnectUserSockets(io, userId);
  } else if (before.deactivated_at) {
    await db.prepare(
      'UPDATE users SET deactivated_at = NULL, updated_at = UNIX_TIMESTAMP() WHERE id = ?',
    ).run(userId);
  }

  const after = await db.prepare('SELECT deactivated_at FROM users WHERE id = ?').get(userId);
  const changed = !!before.deactivated_at !== !!after.deactivated_at;
  if (changed) {
    // Ref 17: lands in the tamper-evident audit chain like every other auth event.
    await logActivity(
      actorId,
      deactivated ? 'user:deactivated' : 'user:reactivated',
      `${before.email} (via ${via})`,
      null,
      ip,
      null,
    );
  }
  return { changed, deactivated_at: after.deactivated_at || null };
}

module.exports = { setUserDeactivated, disconnectUserSockets };
