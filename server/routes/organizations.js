const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const { db } = require("../db/database");
const { canAdminOrg, canAccessOrg, canManageOrgRegions } = require("../lib/permissions");
const { accessibleWorkspaceIds } = require("../lib/tenancy");
const { isoDate, slaUptimeTarget, deviceAvailabilityRows, meanAvailability, slaStatus } = require("../lib/sla");
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

// ===================== Regions (Phase 3 Stage A) =====================
// Per-org regional structure. Tier: org_owner / org_admin of THIS org, or a
// platform owner-role (canManageOrgRegions — deliberately broader than the
// owner-only canAdminOrg used for membership, narrower than canAccessOrg which
// also admits platform_operator). URL param is :orgId here (nested resource);
// the members routes above use :id — both resolve on this one router fine.

const REGION_NAME_MAX = 80;

async function loadOrgForRegions(req, res) {
  const org = await db
    .prepare("SELECT * FROM organizations WHERE id = ?")
    .get(req.params.orgId);
  if (!org) {
    res.status(404).json({ error: "Organization not found" });
    return null;
  }
  if (!(await canManageOrgRegions(db, req.user, org))) {
    res.status(403).json({ error: "Organization admin access required" });
    return null;
  }
  return org;
}

function validRegionName(res, raw) {
  const name = String(raw || "").trim();
  if (!name) {
    res.status(400).json({ error: "Name required" });
    return null;
  }
  if (name.length > REGION_NAME_MAX) {
    res.status(400).json({ error: `Name must be ${REGION_NAME_MAX} characters or fewer` });
    return null;
  }
  return name;
}

// GET /:orgId/regions — list this org's regions + how many workspaces each holds.
router.get(
  "/:orgId/regions",
  asyncHandler(async (req, res) => {
    const org = await loadOrgForRegions(req, res);
    if (!org) return;
    const regions = await db
      .prepare(
        `SELECT r.id, r.name, r.created_at, r.updated_at,
                (SELECT COUNT(*) FROM workspaces w WHERE w.region_id = r.id) AS workspace_count
         FROM regions r WHERE r.organization_id = ? ORDER BY r.name`,
      )
      .all(org.id);
    res.json(regions);
  }),
);

// GET /:orgId/regions/sla-overview?start=YYYY-MM-DD&end=YYYY-MM-DD
// Phase 3 Stage B — per-region SLA rollup. Spans workspaces, so it is NOT gated
// on a single-workspace role: any user who can reach at least one workspace in
// this org sees it, and the numbers are scoped to exactly the workspaces they
// can reach (accessibleWorkspaceIds — the same cross-org access logic /me and
// socket-room scoping use). Not org-admin-only: a plain workspace_member gets a
// correct rollup covering only their workspace(s), never a leak of the rest.
// Uses the shared lib/sla.js uptime calc so the numbers agree with the
// per-device SLA overview. "Unassigned" is a bucket for region-less workspaces
// (only shown if the caller can see one). A region with no visible workspace is
// omitted entirely.
router.get(
  "/:orgId/regions/sla-overview",
  asyncHandler(async (req, res) => {
    const org = await db
      .prepare("SELECT id, name FROM organizations WHERE id = ?")
      .get(req.params.orgId);
    if (!org) return res.status(404).json({ error: "Organization not found" });

    const accessible = new Set(await accessibleWorkspaceIds(req.user.id, req.user.role));
    const orgWorkspaces = await db
      .prepare(
        `SELECT w.id, w.region_id, r.name AS region_name
         FROM workspaces w LEFT JOIN regions r ON r.id = w.region_id
         WHERE w.organization_id = ?`,
      )
      .all(org.id);
    const visible = orgWorkspaces.filter((w) => accessible.has(w.id));
    if (!visible.length) {
      return res.status(403).json({ error: "No accessible workspaces in this organization" });
    }

    const startDate = req.query.start || isoDate(new Date(Date.now() - 30 * 86400000));
    const endDate = req.query.end || isoDate(new Date());
    const target = slaUptimeTarget();

    const visibleIds = visible.map((w) => w.id);
    const ph = visibleIds.map(() => "?").join(",");

    const deviceRows = await db
      .prepare(`SELECT id, workspace_id FROM devices WHERE workspace_id IN (${ph})`)
      .all(...visibleIds);
    const availRows = await deviceAvailabilityRows(db, {
      startDate,
      endDate,
      scope: {
        sql: ` AND device_id IN (SELECT id FROM devices WHERE workspace_id IN (${ph}))`,
        params: visibleIds,
      },
    });
    const availByDevice = new Map(availRows.map((r) => [r.device_id, r]));
    const wsRegionKey = new Map(visible.map((w) => [w.id, w.region_id || "__unassigned__"]));

    const buckets = new Map();
    for (const w of visible) {
      const key = w.region_id || "__unassigned__";
      if (!buckets.has(key)) {
        buckets.set(key, {
          region_id: w.region_id || null,
          region_name: w.region_id ? w.region_name : "Unassigned",
          workspaceCount: 0,
          deviceIds: [],
        });
      }
      buckets.get(key).workspaceCount += 1;
    }
    for (const d of deviceRows) {
      buckets.get(wsRegionKey.get(d.workspace_id)).deviceIds.push(d.id);
    }

    const regions = [...buckets.values()]
      .map((b) => {
        const rows = b.deviceIds.map((id) => availByDevice.get(id)).filter(Boolean);
        const { avgPct, devicesWithData } = meanAvailability(rows);
        return {
          region_id: b.region_id,
          region_name: b.region_name,
          workspace_count: b.workspaceCount,
          device_count: b.deviceIds.length,
          devices_with_data: devicesWithData,
          avg_uptime_pct: avgPct,
          sla_status: slaStatus(avgPct, target),
        };
      })
      .sort(
        (a, b) =>
          (a.region_id === null) - (b.region_id === null) ||
          a.region_name.localeCompare(b.region_name),
      );

    res.json({
      organization_id: org.id,
      target: { uptime_target_pct: target },
      period: { start: startDate, end: endDate },
      regions,
    });
  }),
);

// POST /:orgId/regions  { name }
router.post(
  "/:orgId/regions",
  asyncHandler(async (req, res) => {
    const org = await loadOrgForRegions(req, res);
    if (!org) return;
    const name = validRegionName(res, req.body?.name);
    if (!name) return;

    const dup = await db
      .prepare("SELECT 1 FROM regions WHERE organization_id = ? AND name = ?")
      .get(org.id, name);
    if (dup) return res.status(409).json({ error: "A region with that name already exists" });

    const id = crypto.randomUUID();
    await db
      .prepare("INSERT INTO regions (id, organization_id, name) VALUES (?, ?, ?)")
      .run(id, org.id, name);
    logActivity(
      req.user.id,
      "region_created",
      `org: ${org.name} (${org.id}), region: ${name}`,
      null,
      getClientIp(req),
      null,
    );
    res.status(201).json({ id, organization_id: org.id, name, workspace_count: 0 });
  }),
);

// PATCH /:orgId/regions/:id  { name } — rename
router.patch(
  "/:orgId/regions/:id",
  asyncHandler(async (req, res) => {
    const org = await loadOrgForRegions(req, res);
    if (!org) return;
    const region = await db
      .prepare("SELECT * FROM regions WHERE id = ? AND organization_id = ?")
      .get(req.params.id, org.id);
    if (!region) return res.status(404).json({ error: "Region not found" });

    const name = validRegionName(res, req.body?.name);
    if (!name) return;
    if (name !== region.name) {
      const dup = await db
        .prepare("SELECT 1 FROM regions WHERE organization_id = ? AND name = ? AND id <> ?")
        .get(org.id, name, region.id);
      if (dup) return res.status(409).json({ error: "A region with that name already exists" });
    }

    await db
      .prepare("UPDATE regions SET name = ?, updated_at = UNIX_TIMESTAMP() WHERE id = ?")
      .run(name, region.id);
    logActivity(
      req.user.id,
      "region_renamed",
      `org: ${org.name} (${org.id}), region: ${region.name} -> ${name}`,
      null,
      getClientIp(req),
      null,
    );
    res.json({ id: region.id, organization_id: org.id, name });
  }),
);

// DELETE /:orgId/regions/:id — workspaces assigned to it are UNASSIGNED
// (region_id -> NULL), never deleted. The explicit UPDATE below is the contract;
// the workspaces.region_id ON DELETE SET NULL FK is a backstop for other delete
// paths (e.g. org cascade).
router.delete(
  "/:orgId/regions/:id",
  asyncHandler(async (req, res) => {
    const org = await loadOrgForRegions(req, res);
    if (!org) return;
    const region = await db
      .prepare("SELECT * FROM regions WHERE id = ? AND organization_id = ?")
      .get(req.params.id, org.id);
    if (!region) return res.status(404).json({ error: "Region not found" });

    const unassigned = (
      await db.prepare("SELECT COUNT(*) AS c FROM workspaces WHERE region_id = ?").get(region.id)
    ).c;
    await db.prepare("UPDATE workspaces SET region_id = NULL WHERE region_id = ?").run(region.id);
    await db.prepare("DELETE FROM regions WHERE id = ?").run(region.id);

    logActivity(
      req.user.id,
      "region_deleted",
      `org: ${org.name} (${org.id}), region: ${region.name}, workspaces unassigned: ${unassigned}`,
      null,
      getClientIp(req),
      null,
    );
    res.json({ success: true, workspaces_unassigned: unassigned });
  }),
);

module.exports = router;
