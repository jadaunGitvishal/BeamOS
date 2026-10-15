'use strict';

// Phase 1C: which audit policy a role change gets. A change to a STRICTLY LOWER role is a
// demotion - it always applies, with the awaited post-commit audit row (auditOrWarn).
// Anything else - higher, equal, or not comparable (e.g. field_technician <->
// regional_viewer: neither includes the other) - counts as a grant, written in the
// change's own transaction (auditInTx: no audit row, no change). Callers decide inside
// their transaction, from the locked "before" role.

// Each role's rank; a role includes everything every lower-ranked role can do. Roles of
// equal rank are NOT comparable (different, non-nested permissions).
const ORG_ROLE_RANK = { org_owner: 3, org_admin: 2, field_technician: 1, regional_viewer: 1 };
const WORKSPACE_ROLE_RANK = { workspace_admin: 3, workspace_editor: 2, workspace_viewer: 1 };

function strictlyLower(ranks, before, after) {
  const b = ranks[before];
  const a = ranks[after];
  return b != null && a != null && a < b;
}

// true when before -> after is a demotion (strictly fewer rights).
const isOrgDemotion = (before, after) => strictlyLower(ORG_ROLE_RANK, before, after);
const isWorkspaceDemotion = (before, after) => strictlyLower(WORKSPACE_ROLE_RANK, before, after);

module.exports = { isOrgDemotion, isWorkspaceDemotion, ORG_ROLE_RANK, WORKSPACE_ROLE_RANK };
