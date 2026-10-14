'use strict';

// Last-active-platform-admin protection.
//
// A change that would leave the deployment with ZERO active platform admins (no one
// left to administer it, or to fix a misconfigured SCIM job) is refused. "Active" =
// a platform-owner role (isPlatformRole: platform_admin + legacy superadmin) and
// deactivated_at IS NULL.
//
// Paths that can remove an active platform admin - the platform role change and user
// deletion (routes/auth.js) and deactivation (lib/user-deactivation.js, used by SCIM) -
// all decide under ONE lock, the 'platform_admins' row of app_locks, so two removals
// running at the same time are decided one after the other and the second sees the
// first's result. Without it, two admins demoting / deleting / deactivating each
// other concurrently could both succeed (each counting the other as "still there").
//
// Every such transaction must:
//   1. call lockPlatformAdmins(tx) as its VERY FIRST statement. Under REPEATABLE READ a
//      transaction's snapshot is fixed by its first ordinary (non-locking) read; any
//      earlier ordinary read would make the count below see data from before the
//      lock was granted (missing the previous holder's change);
//   2. read the target row (SELECT ... FOR UPDATE);
//   3. call assertNotLastActivePlatformAdmin(tx, target) - an ordinary count, which
//      now reads after the lock was granted;
//   4. make the change, in the same transaction.

const { PLATFORM_ROLES, isPlatformRole } = require('../middleware/auth');

const PLATFORM_ADMINS_LOCK = 'platform_admins';
const LAST_PLATFORM_ADMIN_MESSAGE = 'Cannot remove the last active platform admin';

class LastPlatformAdminError extends Error {
  constructor() {
    super(LAST_PLATFORM_ADMIN_MESSAGE);
    this.name = 'LastPlatformAdminError';
  }
}

// Step 1 - blocks until any other platform-admin-removing transaction has committed.
async function lockPlatformAdmins(tx) {
  const row = await tx.prepare('SELECT name FROM app_locks WHERE name = ? FOR UPDATE').get(PLATFORM_ADMINS_LOCK);
  if (!row) {
    // Seeded by db/schema.sql and re-asserted by lib/schema-check.js at boot; refuse
    // rather than decide without the lock.
    throw new Error(`app_locks row '${PLATFORM_ADMINS_LOCK}' is missing - the startup schema repair should have created it`);
  }
}

async function countActivePlatformAdmins(tx) {
  const ph = PLATFORM_ROLES.map(() => '?').join(', ');
  const row = await tx
    .prepare(`SELECT COUNT(*) AS n FROM users WHERE role IN (${ph}) AND deactivated_at IS NULL`)
    .get(...PLATFORM_ROLES);
  return Number(row.n);
}

// Step 3 - `target` is the row being changed ({ role, deactivated_at }), read in this
// transaction after lockPlatformAdmins. Throws LastPlatformAdminError when it is an
// active platform admin and the only one. Call it only for changes that remove its
// active platform-admin status (demotion to a non-platform role, deletion,
// deactivation).
async function assertNotLastActivePlatformAdmin(tx, target) {
  if (!target || !isPlatformRole(target.role) || target.deactivated_at) return;
  if ((await countActivePlatformAdmins(tx)) <= 1) throw new LastPlatformAdminError();
}

module.exports = {
  PLATFORM_ADMINS_LOCK,
  LAST_PLATFORM_ADMIN_MESSAGE,
  LastPlatformAdminError,
  lockPlatformAdmins,
  countActivePlatformAdmins,
  assertNotLastActivePlatformAdmin,
};
