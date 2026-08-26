const express = require("express");
const router = express.Router();
const { db } = require("../db/database");
const { canAdminOrg, canAccessOrg } = require("../lib/permissions");
const { isPlatformRole } = require("../middleware/auth");
const { logActivity, getClientIp } = require("../services/activity");
const { asyncHandler } = require("../lib/async-handler");
const { toCsvRow } = require("../lib/csv");
const { renderXlsx, renderPdf } = require("../lib/report-export");

function formatTimestamp(epochSeconds) {
  if (epochSeconds === null || epochSeconds === undefined) return "";
  return new Date(epochSeconds * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

// Organization-member management. Operates on a target org specified by URL
// param, NOT the caller's currently active org - so this router does NOT use
// resolveTenancy. Permission is gated via canAdminOrg()/canAccessOrg() (mirrors
// routes/workspaces.js exactly, one tenancy layer up).
//
// Authorization tiers (see canAdminOrg/canAccessOrg in lib/permissions.js):
//   - platform_admin (owner tier, NOT platform_operator): full control, incl.
//     granting/revoking org_owner.
//   - org_owner of THIS org: can add/promote/demote/remove org_admin members
//     only. Cannot grant org_owner to anyone, cannot touch another org_owner
//     row (grantOwnerRole below gates this).
//   - org_admin: read-only (GET only - canAccessOrg, not canAdminOrg).

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ORG_ROLES = ["org_owner", "org_admin"];

// Load org by req.params.id and verify caller has the required level of
// access. Returns the org row on success. On failure, sends the appropriate
// response and returns null - caller bails on null. Mirrors loadWorkspace.
async function loadOrg(req, res, requireAdmin) {
  const org = await db
    .prepare("SELECT * FROM organizations WHERE id = ?")
    .get(req.params.id);
  if (!org) {
    res.status(404).json({ error: "Organization not found" });
    return null;
  }
  const allowed = requireAdmin
    ? await canAdminOrg(db, req.user, org)
    : await canAccessOrg(db, req.user, org);
  if (!allowed) {
    res.status(403).json({
      error: requireAdmin ? "Organization owner access required" : "Organization access required",
    });
    return null;
  }
  return org;
}

async function countOrgOwners(organizationId) {
  return (
    await db
      .prepare(
        "SELECT COUNT(*) AS c FROM organization_members WHERE organization_id = ? AND role = 'org_owner'",
      )
      .get(organizationId)
  ).c;
}

// Only platform_admin may grant/hold the org_owner role via this router - an
// org_owner caller is restricted to org_admin (see module doc above).
function callerMayGrantRole(req, role) {
  if (role !== "org_owner") return true;
  return isPlatformRole(req.user.role);
}

// GET /:id/members - any org member (org_owner/org_admin) or platform staff.
router.get(
  "/:id/members",
  asyncHandler(async (req, res) => {
    const org = await loadOrg(req, res, false);
    if (!org) return;
    const members = await db
      .prepare(
        `
    SELECT u.id AS user_id, u.email, u.name, u.role AS platform_role, om.role, om.joined_at,
           inv.email AS invited_by_email
    FROM organization_members om
    JOIN users u ON u.id = om.user_id
    LEFT JOIN users inv ON inv.id = om.invited_by
    WHERE om.organization_id = ?
    ORDER BY om.joined_at ASC
  `,
      )
      .all(org.id);
    res.json(members);
  }),
);

// GET /:id/members/export?format=csv|xlsx|pdf - same membership data as
// GET /:id/members, same access tier (any org member may read/export the
// roster), rendered as a downloadable file via the shared report-export lib.
router.get(
  "/:id/members/export",
  asyncHandler(async (req, res) => {
    const org = await loadOrg(req, res, false);
    if (!org) return;
    const members = await db
      .prepare(
        `
    SELECT u.id AS user_id, u.email, u.name, u.role AS platform_role, om.role, om.joined_at,
           inv.email AS invited_by_email
    FROM organization_members om
    JOIN users u ON u.id = om.user_id
    LEFT JOIN users inv ON inv.id = om.invited_by
    WHERE om.organization_id = ?
    ORDER BY om.joined_at ASC
  `,
      )
      .all(org.id);

    const format = ["csv", "xlsx", "pdf"].includes(req.query.format)
      ? req.query.format
      : "csv";

    const headers = ["Name", "Email", "Role", "Joined (UTC)", "Invited By", "User ID"];
    const dataRows = members.map((m) => [
      m.name || "",
      m.email,
      m.role,
      formatTimestamp(m.joined_at),
      m.invited_by_email || "",
      m.user_id,
    ]);

    const date = new Date().toISOString().slice(0, 10);
    const filenameBase = `org-members-${org.id}-${date}`;

    if (format === "xlsx") {
      const buffer = await renderXlsx("Org Members", headers, dataRows);
      res.set(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      res.set("Content-Disposition", `attachment; filename="${filenameBase}.xlsx"`);
      res.send(buffer);
      return;
    }

    if (format === "pdf") {
      const buffer = await renderPdf(`Org Members - ${org.name}`, headers, dataRows);
      res.set("Content-Type", "application/pdf");
      res.set("Content-Disposition", `attachment; filename="${filenameBase}.pdf"`);
      res.send(buffer);
      return;
    }

    const header = toCsvRow(headers);
    const csvRows = dataRows.map((row) => toCsvRow(row));
    res.set("Content-Type", "text/csv; charset=utf-8");
    res.set("Content-Disposition", `attachment; filename="${filenameBase}.csv"`);
    res.send("﻿" + [header, ...csvRows].join("\r\n"));
  }),
);

// POST /:id/members - add an EXISTING user (by email) to the org with a role.
// Owner-tier only (canAdminOrg). Does not create accounts and does not send an
// email invite - the target must already have a BeamOS account.
router.post(
  "/:id/members",
  asyncHandler(async (req, res) => {
    const org = await loadOrg(req, res, true);
    if (!org) return;

    const email = String(req.body?.email || "").trim().toLowerCase();
    const role = String(req.body?.role || "").trim();
    if (!email || !EMAIL_RE.test(email)) {
      return res.status(400).json({ error: "Valid email required" });
    }
    if (!ORG_ROLES.includes(role)) {
      return res.status(400).json({ error: "Role must be org_owner or org_admin" });
    }
    if (!callerMayGrantRole(req, role)) {
      return res.status(403).json({ error: "Only a platform admin can grant the organization owner role" });
    }

    const target = await db
      .prepare("SELECT id, email FROM users WHERE email = ?")
      .get(email);
    if (!target) {
      return res.status(404).json({ error: "User not found" });
    }

    const existing = await db
      .prepare(
        "SELECT 1 FROM organization_members WHERE organization_id = ? AND user_id = ?",
      )
      .get(org.id, target.id);
    if (existing) {
      return res.status(409).json({ error: "User is already a member of this organization" });
    }

    await db
      .prepare(
        "INSERT INTO organization_members (organization_id, user_id, role, invited_by) VALUES (?, ?, ?, ?)",
      )
      .run(org.id, target.id, role, req.user.id);

    logActivity(
      req.user.id,
      "org_member_added",
      `org: ${org.name} (${org.id}), target: ${target.email}, role: ${role}`,
      null,
      getClientIp(req),
      null,
    );

    res.status(201).json({ user_id: target.id, email: target.email, role });
  }),
);

// PUT /:id/members/:userId - change an existing member's role. Owner-tier only.
router.put(
  "/:id/members/:userId",
  asyncHandler(async (req, res) => {
    const org = await loadOrg(req, res, true);
    if (!org) return;

    const newRole = String(req.body?.role || "").trim();
    if (!ORG_ROLES.includes(newRole)) {
      return res.status(400).json({ error: "Role must be org_owner or org_admin" });
    }

    const member = await db
      .prepare(
        "SELECT role FROM organization_members WHERE organization_id = ? AND user_id = ?",
      )
      .get(org.id, req.params.userId);
    if (!member) return res.status(404).json({ error: "Member not found" });

    // Primary-owner lock: organizations.owner_user_id is a separate NOT NULL FK
    // (billing/cascade-delete authority - see lib/user-deletion.js) that this
    // router does not manage. Changing the role of that specific member would
    // desync RBAC from it, so it's blocked here regardless of caller tier.
    // Ownership transfer is a deliberately separate, not-yet-built feature.
    if (req.params.userId === org.owner_user_id) {
      return res.status(403).json({
        error: "Cannot change the organization's primary owner - transfer ownership first",
      });
    }

    if (!callerMayGrantRole(req, newRole)) {
      return res.status(403).json({ error: "Only a platform admin can grant the organization owner role" });
    }
    // An org_owner caller may only touch org_admin rows (not other org_owner
    // rows) - canAdminOrg already let them in, but role-scope them here too.
    if (member.role === "org_owner" && !isPlatformRole(req.user.role)) {
      return res.status(403).json({ error: "Only a platform admin can change another organization owner" });
    }

    if (member.role === "org_owner" && newRole !== "org_owner") {
      if ((await countOrgOwners(org.id)) <= 1) {
        return res.status(409).json({ error: "Cannot demote the last organization owner" });
      }
    }

    await db
      .prepare(
        "UPDATE organization_members SET role = ? WHERE organization_id = ? AND user_id = ?",
      )
      .run(newRole, org.id, req.params.userId);

    const target = await db.prepare("SELECT email FROM users WHERE id = ?").get(req.params.userId);
    logActivity(
      req.user.id,
      "org_member_role_changed",
      `org: ${org.name} (${org.id}), target: ${target?.email}, role: ${newRole}`,
      null,
      getClientIp(req),
      null,
    );

    res.json({ user_id: req.params.userId, role: newRole });
  }),
);

// DELETE /:id/members/:userId - remove a member. Owner-tier only.
router.delete(
  "/:id/members/:userId",
  asyncHandler(async (req, res) => {
    const org = await loadOrg(req, res, true);
    if (!org) return;

    const member = await db
      .prepare(
        "SELECT role FROM organization_members WHERE organization_id = ? AND user_id = ?",
      )
      .get(org.id, req.params.userId);
    if (!member) return res.status(404).json({ error: "Member not found" });

    // Same primary-owner lock as PUT.
    if (req.params.userId === org.owner_user_id) {
      return res.status(403).json({
        error: "Cannot remove the organization's primary owner - transfer ownership first",
      });
    }

    if (member.role === "org_owner" && !isPlatformRole(req.user.role)) {
      return res.status(403).json({ error: "Only a platform admin can remove another organization owner" });
    }

    if (member.role === "org_owner" && (await countOrgOwners(org.id)) <= 1) {
      return res.status(409).json({ error: "Cannot remove the last organization owner" });
    }

    await db
      .prepare(
        "DELETE FROM organization_members WHERE organization_id = ? AND user_id = ?",
      )
      .run(org.id, req.params.userId);

    const target = await db.prepare("SELECT email FROM users WHERE id = ?").get(req.params.userId);
    logActivity(
      req.user.id,
      "org_member_removed",
      `org: ${org.name} (${org.id}), target: ${target?.email}`,
      null,
      getClientIp(req),
      null,
    );

    res.json({ success: true });
  }),
);

module.exports = router;
