'use strict';

// Ref 5: per-organization "SSO only" mode (organizations.sso_only).
//
// A user is SSO-only when they belong to ANY organization with sso_only = 1,
// either directly (organization_members) or through a workspace of that org
// (workspace_members -> workspaces.organization_id). Strictest wins: one
// SSO-only membership is enough, regardless of other, non-SSO-only orgs.
//
// Platform admins (isPlatformRole) are always exempt - they are the recovery
// path if the org's Entra tenant is misconfigured or unavailable.
//
// Enforced in routes/auth.js on the password (/login) and Google (/google)
// paths, and used by /microsoft to link an existing password account on a
// verified tenant id_token. Field-technician SMS OTP (routes/field-auth.js),
// existing sessions, API / SCIM tokens and Entra service principals are
// deliberately NOT covered.

const { isPlatformRole } = require('../middleware/auth');

async function isSsoOnlyUser(db, user) {
  if (!user || !user.id) return false;
  if (isPlatformRole(user.role)) return false;
  const row = await db
    .prepare(
      `SELECT 1 AS hit FROM organizations o
       WHERE o.sso_only = 1 AND (
         EXISTS (SELECT 1 FROM organization_members om
                 WHERE om.organization_id = o.id AND om.user_id = ?)
         OR EXISTS (SELECT 1 FROM workspaces w
                    JOIN workspace_members wm ON wm.workspace_id = w.id
                    WHERE w.organization_id = o.id AND wm.user_id = ?)
       )
       LIMIT 1`,
    )
    .get(user.id, user.id);
  return !!row;
}

module.exports = { isSsoOnlyUser };
