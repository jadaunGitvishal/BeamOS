'use strict';

// Shared disposable-fixture + cleanup discipline for tests that run in-process
// against the REAL MySQL database (see helpers/inprocess-app.js for why).
// Mirrors the pattern already proven in reconciliation.test.js /
// pending-installation-report.test.js: every row a test creates must be
// deletable by construction, and after() must actually delete it - these
// tests share the one real `beamos` database with everything else (including,
// during development, a human using the app), so leaving rows behind isn't a
// theoretical risk, it's observed: earlier work this session had to hand-clean
// leftover `u1@test.local`-style rows more than once.

const crypto = require('crypto');
const { deleteUserCascade } = require('../../lib/user-deletion');

// A short random tag for building collision-safe emails/ids, e.g.
// `billingauthz-${randTag()}@x.local`. Distinct per test FILE (pass a fixed
// prefix) so a leftover row from a failed cleanup is still traceable to which
// test produced it.
function randTag() {
  return crypto.randomBytes(4).toString('hex');
}

// Deletes a user and everything deleteUserCascade cascades from them (the
// org they own, its workspaces, and every workspace-scoped resource in it -
// devices, content with a workspace_id, playlists, layouts, api_tokens, ...).
// Safe to call even if the user only registered and created nothing else.
async function cleanupUser(db, userId) {
  if (!userId) return;
  try {
    await deleteUserCascade(db, { targetId: userId, actingAdminId: userId });
  } catch (e) {
    // Best-effort: a test failure shouldn't also mask itself behind a cleanup
    // error, but DO surface it loudly so an actually-broken cleanup isn't silent.
    console.warn(`[disposable] cleanupUser(${userId}) failed: ${e.message}`);
  }
}

async function cleanupUsers(db, userIds) {
  for (const id of (userIds || []).filter(Boolean)) await cleanupUser(db, id);
}

// For rows that do NOT cascade from a user/org/workspace deletion - most
// commonly `content` rows seeded with workspace_id left NULL (the platform-
// template shape, schema.sql), which is sometimes the simplest way to seed a
// fixture but means the row is invisible to cleanupUser(s). Delete by exact id.
async function cleanupContent(db, contentIds) {
  for (const id of (contentIds || []).filter(Boolean)) {
    try { await db.prepare('DELETE FROM content WHERE id = ?').run(id); } catch (e) { /* already gone */ }
  }
}

module.exports = { randTag, cleanupUser, cleanupUsers, cleanupContent };
