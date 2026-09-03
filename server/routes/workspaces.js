const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const { db } = require("../db/database");
const { canAdminWorkspace, canAccessWorkspace, canWriteWorkspace, canManageOrgRegions } = require("../lib/permissions");
const {
  ticketResponseStatus,
  ticketSlaDueAt,
  ticketSlaTargetHours,
  ticketSlaTargets,
  summariseTicketSla,
} = require("../lib/ticket-sla");
const { logActivity, getClientIp } = require("../services/activity");
const { sendEmail } = require("../services/email");
const { asyncHandler } = require("../lib/async-handler");
const { toCsvRow } = require("../lib/csv");
const { renderXlsx, renderPdf } = require("../lib/report-export");

function formatTimestamp(epochSeconds) {
  if (epochSeconds === null || epochSeconds === undefined) return "";
  return new Date(epochSeconds * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

// Workspace management routes. Operates on a target workspace specified by
// URL param, NOT the caller's currently active workspace - so this router
// does NOT use resolveTenancy. Permission is gated via canAdminWorkspace() /
// canAccessWorkspace() which evaluate against the target workspace, not
// req.workspaceRole.

const NAME_MAX = 80;
const SLUG_MAX = 60;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const WORKSPACE_ROLES = [
  "workspace_admin",
  "workspace_editor",
  "workspace_viewer",
];

// Operational policy - env-configurable with conservative defaults. Restart
// required to take effect. The guarded parseInt rejects garbage strings
// (e.g. INVITE_RATE_LIMIT_PER_HOUR=fifty) so an operator typo surfaces as
// "default fired" rather than silently sticking. Future cleanup: DB-backed
// platform_settings + admin UI for runtime tuning; env vars become fallback
// defaults when that lands. See handoff doc.
const INVITE_RATE_LIMIT_PER_HOUR = (() => {
  const parsed = parseInt(process.env.INVITE_RATE_LIMIT_PER_HOUR, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 50;
})();
const INVITE_EXPIRY_DAYS = (() => {
  const parsed = parseInt(process.env.INVITE_EXPIRY_DAYS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 7;
})();

// Rename a workspace. MVP scope: name + slug only. Permission: platform_admin,
// org_owner/admin of the parent org, or workspace_admin of the target ws.
router.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const ws = await db
      .prepare("SELECT * FROM workspaces WHERE id = ?")
      .get(req.params.id);
    if (!ws) return res.status(404).json({ error: "Workspace not found" });
    if (!(await canAdminWorkspace(db, req.user, ws))) {
      return res.status(403).json({ error: "Admin access required" });
    }

    // Stamp the target workspace_id so activityLogger captures the right
    // tenant attribution. This route doesn't use resolveTenancy (operates on
    // a URL-param target, not the caller's active workspace), so req.workspaceId
    // would otherwise be undefined and the audit row would have NULL workspace.
    req.workspaceId = ws.id;

    const updates = [];
    const values = [];

    if (req.body.name !== undefined) {
      const name = String(req.body.name).trim();
      if (!name) return res.status(400).json({ error: "Name cannot be empty" });
      if (name.length > NAME_MAX)
        return res
          .status(400)
          .json({ error: `Name must be ${NAME_MAX} characters or fewer` });
      updates.push("name = ?");
      values.push(name);
    }

    if (req.body.slug !== undefined) {
      // Empty string -> NULL (workspace has no slug). Otherwise normalize +
      // validate against the URL-safe segment pattern.
      const raw = String(req.body.slug || "")
        .trim()
        .toLowerCase();
      if (raw === "") {
        updates.push("slug = NULL");
      } else {
        if (raw.length > SLUG_MAX)
          return res
            .status(400)
            .json({ error: `Slug must be ${SLUG_MAX} characters or fewer` });
        if (!SLUG_RE.test(raw)) {
          return res.status(400).json({
            error:
              "Slug must be lowercase letters, digits, and hyphens (no leading/trailing/double hyphens)",
          });
        }
        updates.push("slug = ?");
        values.push(raw);
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    updates.push("updated_at = UNIX_TIMESTAMP()");
    values.push(req.params.id);

    try {
      await db
        .prepare(`UPDATE workspaces SET ${updates.join(", ")} WHERE id = ?`)
        .run(...values);
    } catch (e) {
      // MySQL's duplicate-key error code (ER_DUP_ENTRY), replacing SQLite's SQLITE_CONSTRAINT_UNIQUE.
      if (e.code === "ER_DUP_ENTRY" || /Duplicate entry/i.test(e.message)) {
        return res
          .status(409)
          .json({ error: "Slug already used in this organization" });
      }
      throw e;
    }

    const updated = await db
      .prepare(
        "SELECT id, name, slug, organization_id FROM workspaces WHERE id = ?",
      )
      .get(req.params.id);
    res.json(updated);
  }),
);

// ==================== Members / invites ====================

// Load workspace by req.params.id and verify caller has the required level
// of access. Returns the workspace row on success. On failure, sends the
// appropriate response and returns null - caller bails on null. Also stamps
// req.workspaceId so the activityLogger middleware captures the right
// tenant attribution (mirrors the rename pattern).
async function loadWorkspace(req, res, requireAdmin) {
  const ws = await db
    .prepare("SELECT * FROM workspaces WHERE id = ?")
    .get(req.params.id);
  if (!ws) {
    res.status(404).json({ error: "Workspace not found" });
    return null;
  }
  const allowed = requireAdmin
    ? await canAdminWorkspace(db, req.user, ws)
    : await canAccessWorkspace(db, req.user, ws);
  if (!allowed) {
    res.status(403).json({
      error: requireAdmin
        ? "Admin access required"
        : "Workspace access required",
    });
    return null;
  }
  req.workspaceId = ws.id;
  return ws;
}

async function countWorkspaceAdmins(workspaceId) {
  return (
    await db
      .prepare(
        "SELECT COUNT(*) AS c FROM workspace_members WHERE workspace_id = ? AND role = 'workspace_admin'",
      )
      .get(workspaceId)
  ).c;
}

// Members listing: direct workspace_members + the org_owner/admin users who
// reach this workspace via org-level access.
//
// Response shape contract: entries with via_org=true are READ-ONLY from the
// workspace context. They cannot have their role changed or be removed via
// these endpoints because they aren't managed via workspace_members - their
// access lives in organization_members. UI must render them with reduced
// affordances (no role select, no remove button). The role field on a
// via_org entry reflects their ORG role (org_owner / org_admin), not a
// workspace role - it's display-only.
async function listMembers(workspaceId, organizationId) {
  const direct = await db
    .prepare(
      `
    SELECT u.id AS user_id, u.email, u.name, u.role AS platform_role, wm.role, wm.joined_at, om.role AS org_role
    FROM workspace_members wm
    JOIN users u ON u.id = wm.user_id
    LEFT JOIN organization_members om ON om.organization_id = ? AND om.user_id = u.id
    WHERE wm.workspace_id = ?
    ORDER BY wm.joined_at ASC
  `,
    )
    .all(organizationId, workspaceId);
  const directIds = new Set(direct.map((r) => r.user_id));

  const viaOrg = await db
    .prepare(
      `
    SELECT u.id AS user_id, u.email, u.name, u.role AS platform_role, om.role, om.joined_at
    FROM organization_members om
    JOIN users u ON u.id = om.user_id
    WHERE om.organization_id = ? AND om.role IN ('org_owner', 'org_admin')
  `,
    )
    .all(organizationId);

  const out = direct.map((r) => ({ ...r, via_org: false }));
  for (const r of viaOrg) {
    if (directIds.has(r.user_id)) continue;
    out.push({ ...r, via_org: true });
  }
  return out;
}

function buildInviteEmail({
  workspaceName,
  organizationName,
  inviterName,
  role,
  acceptUrl,
}) {
  const subject = `You've been invited to ${workspaceName} on BeamOS`;
  const roleLabel = role.replace(/^workspace_/, "");
  const text = [
    `${inviterName || "A BeamOS user"} invited you to join ${workspaceName}` +
      (organizationName ? ` (${organizationName})` : "") +
      ` as ${roleLabel}.`,
    "",
    `To accept, sign in to BeamOS and open:`,
    acceptUrl,
    "",
    `This invite expires in ${INVITE_EXPIRY_DAYS} days.`,
  ].join("\n");
  return { subject, text };
}

// GET /:id/members - any member (or org-level/platform admin) of the workspace
router.get(
  "/:id/members",
  asyncHandler(async (req, res) => {
    const ws = await loadWorkspace(req, res, false);
    if (!ws) return;
    res.json(await listMembers(ws.id, ws.organization_id));
  }),
);

// GET /:id/members/export?format=csv|xlsx|pdf - same membership data (direct
// + via_org) and same access tier as GET /:id/members, rendered as a
// downloadable file via the shared report-export lib.
router.get(
  "/:id/members/export",
  asyncHandler(async (req, res) => {
    const ws = await loadWorkspace(req, res, false);
    if (!ws) return;
    const members = await listMembers(ws.id, ws.organization_id);

    const format = ["csv", "xlsx", "pdf"].includes(req.query.format)
      ? req.query.format
      : "csv";

    const headers = ["Name", "Email", "Role", "Membership", "Joined (UTC)", "User ID"];
    const dataRows = members.map((m) => [
      m.name || "",
      m.email,
      m.role,
      m.via_org ? "Via Org" : "Direct",
      formatTimestamp(m.joined_at),
      m.user_id,
    ]);

    const date = new Date().toISOString().slice(0, 10);
    const filenameBase = `workspace-members-${ws.id}-${date}`;

    if (format === "xlsx") {
      const buffer = await renderXlsx("Workspace Members", headers, dataRows);
      res.set(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      res.set("Content-Disposition", `attachment; filename="${filenameBase}.xlsx"`);
      res.send(buffer);
      return;
    }

    if (format === "pdf") {
      const buffer = await renderPdf(`Workspace Members - ${ws.name}`, headers, dataRows);
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

// GET /:id/invites - admin only. Pending (non-expired) rows.
router.get(
  "/:id/invites",
  asyncHandler(async (req, res) => {
    const ws = await loadWorkspace(req, res, true);
    if (!ws) return;
    const invites = await db
      .prepare(
        `
    SELECT i.id, i.email, i.role, i.expires_at, i.created_at,
           inv.email AS invited_by_email
    FROM workspace_invites i
    LEFT JOIN users inv ON inv.id = i.invited_by
    WHERE i.workspace_id = ? AND i.expires_at > UNIX_TIMESTAMP()
    ORDER BY i.created_at DESC
  `,
      )
      .all(ws.id);
    res.json(invites);
  }),
);

// POST /:id/invites - admin only. Rate-limited (per-user, per-workspace,
// hour window). Idempotent against in-flight duplicate invites via a
// transaction-bounded collision check (workspace_invites has no UNIQUE
// constraint on (workspace_id, email), so the txn is what prevents the
// TOCTOU race between two simultaneous POSTs).
router.post(
  "/:id/invites",
  asyncHandler(async (req, res) => {
    const ws = await loadWorkspace(req, res, true);
    if (!ws) return;

    const email = String(req.body?.email || "")
      .trim()
      .toLowerCase();
    const role = String(req.body?.role || "").trim();
    if (!email || !EMAIL_RE.test(email)) {
      return res.status(400).json({ error: "Valid email required" });
    }
    if (!WORKSPACE_ROLES.includes(role)) {
      return res.status(400).json({
        error:
          "Role must be workspace_admin, workspace_editor, or workspace_viewer",
      });
    }

    // Block invite to existing direct member of this workspace. (Org-level
    // members are not "members" of this specific workspace via workspace_members,
    // so they're allowed to also be invited as direct members if desired.)
    const existingMember = await db
      .prepare(
        `
    SELECT 1 FROM workspace_members wm
    JOIN users u ON u.id = wm.user_id
    WHERE wm.workspace_id = ? AND lower(u.email) = ?
  `,
      )
      .get(ws.id, email);
    if (existingMember) {
      return res
        .status(400)
        .json({ error: "User is already a member of this workspace" });
    }

    // Rate limit: per-(inviter, workspace), hour window, counts rows actually
    // created. Generic 429 message - don't echo the configured limit value
    // (info leak about deployment policy).
    const recentCount = (
      await db
        .prepare(
          `
    SELECT COUNT(*) AS c FROM workspace_invites
    WHERE invited_by = ? AND workspace_id = ?
      AND created_at > UNIX_TIMESTAMP() - 3600
  `,
        )
        .get(req.user.id, ws.id)
    ).c;
    if (recentCount >= INVITE_RATE_LIMIT_PER_HOUR) {
      return res
        .status(429)
        .json({ error: "Invite rate limit reached - try again later" });
    }

    // Transaction-bounded collision-check-then-insert. Closes the race where
    // two simultaneous POSTs both pass the SELECT and both INSERT. db.transaction()'s
    // callback gets a transaction-scoped handle (tx) - statements must be prepared
    // from it, not the outer db, to actually participate in the transaction.
    const inviteId = crypto.randomUUID();
    const expiresAt =
      Math.floor(Date.now() / 1000) + INVITE_EXPIRY_DAYS * 86400;
    const txn = db.transaction(async (tx) => {
      const dupe = await tx
        .prepare(
          `
      SELECT id FROM workspace_invites
      WHERE workspace_id = ? AND lower(email) = ? AND expires_at > UNIX_TIMESTAMP()
    `,
        )
        .get(ws.id, email);
      if (dupe) return { collision: true };
      await tx
        .prepare(
          `
      INSERT INTO workspace_invites (id, workspace_id, email, role, invited_by, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
        )
        .run(inviteId, ws.id, email, role, req.user.id, expiresAt);
      return { collision: false };
    });
    const txnResult = await txn();
    if (txnResult.collision) {
      return res
        .status(409)
        .json({ error: "An invite for this email is already pending" });
    }

    // Build accept URL. APP_URL env var (when set) pins the public-facing
    // origin regardless of how the request arrived - recommended in prod so
    // invites triggered from non-browser sources (curl, future API automation)
    // always carry the canonical origin. Same env var the rest of the codebase
    // uses for Stripe callbacks (see README env-var table). Falls back to
    // request-derived for local dev and when APP_URL isn't set; with trust
    // proxy on, req.protocol + req.get('host') reflect Cloudflare-forwarded
    // X-Forwarded-Proto + Host. Path is /app#/accept-invite/<id> - the SPA
    // lives at /app, so a bare /#/accept-invite/<id> would land on the
    // marketing landing page in dev (and rely on the DISABLE_HOMEPAGE
    // redirect in prod). /app is explicit.
    const publicBase =
      process.env.APP_URL || `${req.protocol}://${req.get("host")}`;
    const acceptUrl = `${publicBase}/app#/accept-invite/${inviteId}`;
    const org = await db
      .prepare("SELECT name FROM organizations WHERE id = ?")
      .get(ws.organization_id);
    const { subject, text } = buildInviteEmail({
      workspaceName: ws.name,
      organizationName: org?.name || "",
      inviterName: req.user.name || req.user.email,
      role,
      acceptUrl,
    });

    const sendResult = await sendEmail({ to: email, subject, text });

    // Rollback rule: only graph_error (real send attempted, Graph rejected)
    // deletes the row. not_configured and dev_restricted are intentional
    // non-sends - keep the row, count against the rate limit, allow local
    // accept-invite testing to proceed.
    if (sendResult.reason === "graph_error") {
      await db
        .prepare("DELETE FROM workspace_invites WHERE id = ?")
        .run(inviteId);
      return res
        .status(502)
        .json({ error: "Email send failed - invite not created" });
    }

    res.status(201).json({ id: inviteId, email, role, expires_at: expiresAt });
  }),
);

// DELETE /:id/invites/:inviteId - admin only. Cancels a pending invite.
router.delete(
  "/:id/invites/:inviteId",
  asyncHandler(async (req, res) => {
    const ws = await loadWorkspace(req, res, true);
    if (!ws) return;
    const invite = await db
      .prepare(
        "SELECT id FROM workspace_invites WHERE id = ? AND workspace_id = ?",
      )
      .get(req.params.inviteId, ws.id);
    if (!invite) return res.status(404).json({ error: "Invite not found" });
    await db
      .prepare("DELETE FROM workspace_invites WHERE id = ?")
      .run(invite.id);
    res.json({ success: true });
  }),
);

// PUT /:id/members/:userId - admin only. Change role.
router.put(
  "/:id/members/:userId",
  asyncHandler(async (req, res) => {
    const ws = await loadWorkspace(req, res, true);
    if (!ws) return;
    const newRole = String(req.body?.role || "").trim();
    if (!WORKSPACE_ROLES.includes(newRole)) {
      return res.status(400).json({
        error:
          "Role must be workspace_admin, workspace_editor, or workspace_viewer",
      });
    }
    const member = await db
      .prepare(
        "SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?",
      )
      .get(ws.id, req.params.userId);
    if (!member) return res.status(404).json({ error: "Member not found" });
    if (member.role === "workspace_admin" && newRole !== "workspace_admin") {
      if ((await countWorkspaceAdmins(ws.id)) <= 1) {
        return res.status(409).json({ error: "Cannot demote the last admin" });
      }
    }
    await db
      .prepare(
        "UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?",
      )
      .run(newRole, ws.id, req.params.userId);
    res.json({ user_id: req.params.userId, role: newRole });
  }),
);

// DELETE /:id/members/:userId - admin only. Removes the workspace_members
// row. Blocks (a) removing the parent-org's org_owner via the workspace path,
// since their access comes from org_members anyway, and (b) removing the
// last workspace_admin which would leave the workspace headless.
router.delete(
  "/:id/members/:userId",
  asyncHandler(async (req, res) => {
    const ws = await loadWorkspace(req, res, true);
    if (!ws) return;
    const member = await db
      .prepare(
        "SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?",
      )
      .get(ws.id, req.params.userId);
    if (!member) return res.status(404).json({ error: "Member not found" });
    const orgOwner = await db
      .prepare(
        "SELECT 1 FROM organization_members WHERE organization_id = ? AND user_id = ? AND role = 'org_owner'",
      )
      .get(ws.organization_id, req.params.userId);
    if (orgOwner) {
      return res
        .status(403)
        .json({ error: "Cannot remove the organization owner" });
    }
    if (
      member.role === "workspace_admin" &&
      (await countWorkspaceAdmins(ws.id)) <= 1
    ) {
      return res.status(409).json({ error: "Cannot remove the last admin" });
    }
    await db
      .prepare(
        "DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?",
      )
      .run(ws.id, req.params.userId);
    res.json({ success: true });
  }),
);

// PATCH /:id/region  { region_id: <id> | null } — assign/unassign a workspace to
// one of its ORG's regions. Phase 3 Stage A. Regions are an org-level concept:
// gated on canManageOrgRegions (org_owner/org_admin of the workspace's org, or
// platform owner-role) — a plain workspace_admin CANNOT change this.
router.patch(
  "/:id/region",
  asyncHandler(async (req, res) => {
    const ws = await db.prepare("SELECT * FROM workspaces WHERE id = ?").get(req.params.id);
    if (!ws) return res.status(404).json({ error: "Workspace not found" });
    const org = await db.prepare("SELECT * FROM organizations WHERE id = ?").get(ws.organization_id);
    if (!(await canManageOrgRegions(db, req.user, org))) {
      return res.status(403).json({ error: "Organization admin access required" });
    }
    req.workspaceId = ws.id; // audit attribution (no resolveTenancy on this router)

    if (!("region_id" in (req.body || {}))) {
      return res.status(400).json({ error: "region_id required (send null to unassign)" });
    }
    let regionId = req.body.region_id;
    if (regionId !== null) {
      regionId = String(regionId);
      const region = await db
        .prepare("SELECT id FROM regions WHERE id = ? AND organization_id = ?")
        .get(regionId, ws.organization_id);
      if (!region) {
        return res.status(400).json({ error: "Region not found in this workspace's organization" });
      }
    }

    await db
      .prepare("UPDATE workspaces SET region_id = ?, updated_at = UNIX_TIMESTAMP() WHERE id = ?")
      .run(regionId, ws.id);
    res.json({ id: ws.id, region_id: regionId });
  }),
);

// ==================== Tickets (Phase 4 Stage A) ====================
//
// Manual operational ticketing against a workspace (optionally a device). No
// automatic creation, no Operations UI yet - those are later Phase 4 stages.
// Read = any workspace member (canAccessWorkspace). Create/update =
// workspace_editor+ (canWriteWorkspace). Cross-workspace access is denied by
// those same checks (they evaluate against the URL-param workspace, and this
// router has no resolveTenancy). Every mutation also writes activity_log.

// owner_category is a plain VARCHAR in the schema (see schema.sql tickets note);
// this is the known set the API validates against today. Adding a value here is
// a one-line change with no migration.
const TICKET_OWNER_CATEGORIES = ["customer_it", "store_staff", "platform", "hardware", "unassigned"];
const TICKET_STATUSES = ["open", "in_progress", "resolved", "closed"];
const TICKET_PRIORITIES = ["low", "medium", "high"];
const TICKET_TITLE_MAX = 255;
const TICKET_DESC_MAX = 10000;
// Entering one of these stamps resolved_at; leaving it (back to open/in_progress) clears it.
const TICKET_DONE_STATUSES = new Set(["resolved", "closed"]);

const TICKET_SELECT = `
  SELECT t.*, u.email AS created_by_email, d.name AS device_name
  FROM tickets t
  LEFT JOIN users u ON u.id = t.created_by
  LEFT JOIN devices d ON d.id = t.device_id
`;

function ticketRow(t, nowSec = Math.floor(Date.now() / 1000)) {
  return {
    id: t.id,
    workspace_id: t.workspace_id,
    device_id: t.device_id,
    device_name: t.device_name ?? null,
    title: t.title,
    description: t.description ?? null,
    owner_category: t.owner_category,
    status: t.status,
    priority: t.priority,
    created_by: t.created_by,
    created_by_email: t.created_by_email ?? null,
    // Phase 4 Stage B: auto_source is null for hand-made tickets, 'sla_breach'
    // for one the SLA monitor opened (created_by is null for those too).
    auto_source: t.auto_source ?? null,
    source_outage_start: t.source_outage_start ?? null,
    created_at: t.created_at,
    updated_at: t.updated_at,
    resolved_at: t.resolved_at ?? null,
    // Phase 4 Stage C: response-time SLA, computed on read. response_status is
    // null for resolved/closed tickets (not "due" anything). sla_due_at /
    // sla_target_hours are facts about the ticket's priority + age, populated
    // regardless of status.
    response_status: ticketResponseStatus(t, nowSec),
    sla_due_at: ticketSlaDueAt(t),
    sla_target_hours: ticketSlaTargetHours(t.priority),
  };
}

// 404 unknown workspace, 403 unless caller is workspace_editor+ (or org/platform).
// Stamps req.workspaceId for audit attribution (no resolveTenancy on this router).
async function loadWorkspaceForTicketWrite(req, res) {
  const ws = await db.prepare("SELECT * FROM workspaces WHERE id = ?").get(req.params.id);
  if (!ws) {
    res.status(404).json({ error: "Workspace not found" });
    return null;
  }
  if (!(await canWriteWorkspace(db, req.user, ws))) {
    res.status(403).json({ error: "Workspace editor or admin required" });
    return null;
  }
  req.workspaceId = ws.id;
  return ws;
}

// POST /:id/tickets - create a ticket. workspace_editor+.
router.post(
  "/:id/tickets",
  asyncHandler(async (req, res) => {
    const ws = await loadWorkspaceForTicketWrite(req, res);
    if (!ws) return;

    const title = String(req.body?.title || "").trim();
    if (!title) return res.status(400).json({ error: "title is required" });
    if (title.length > TICKET_TITLE_MAX) {
      return res.status(400).json({ error: `title must be ${TICKET_TITLE_MAX} characters or fewer` });
    }

    let description = req.body?.description;
    if (description === undefined || description === null || description === "") {
      description = null;
    } else {
      description = String(description);
      if (description.length > TICKET_DESC_MAX) {
        return res.status(400).json({ error: `description must be ${TICKET_DESC_MAX} characters or fewer` });
      }
    }

    const ownerCategory =
      req.body?.owner_category === undefined ? "unassigned" : String(req.body.owner_category);
    if (!TICKET_OWNER_CATEGORIES.includes(ownerCategory)) {
      return res.status(400).json({ error: `owner_category must be one of: ${TICKET_OWNER_CATEGORIES.join(", ")}` });
    }
    const priority = req.body?.priority === undefined ? "medium" : String(req.body.priority);
    if (!TICKET_PRIORITIES.includes(priority)) {
      return res.status(400).json({ error: `priority must be one of: ${TICKET_PRIORITIES.join(", ")}` });
    }

    let deviceId = req.body?.device_id;
    if (deviceId === undefined || deviceId === null || deviceId === "") {
      deviceId = null;
    } else {
      deviceId = String(deviceId);
      const device = await db.prepare("SELECT id, workspace_id FROM devices WHERE id = ?").get(deviceId);
      if (!device) return res.status(404).json({ error: "Device not found" });
      if (device.workspace_id !== ws.id) {
        return res.status(400).json({ error: "Device is not in this workspace" });
      }
    }

    const id = crypto.randomUUID();
    await db
      .prepare(
        `INSERT INTO tickets (id, workspace_id, device_id, title, description, owner_category, status, priority, created_by)
         VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
      )
      .run(id, ws.id, deviceId, title, description, ownerCategory, priority, req.user.id);

    logActivity(
      req.user.id,
      "ticket_created",
      `workspace: ${ws.name} (${ws.id}), ticket: ${title}, priority: ${priority}, owner: ${ownerCategory}` +
        (deviceId ? `, device: ${deviceId}` : ""),
      deviceId,
      getClientIp(req),
      ws.id,
    );

    const row = await db.prepare(`${TICKET_SELECT} WHERE t.id = ?`).get(id);
    res.status(201).json(ticketRow(row));
  }),
);

// GET /:id/tickets - list tickets in a workspace. Any workspace member.
// Optional filters: ?status= ?owner_category= ?priority=
router.get(
  "/:id/tickets",
  asyncHandler(async (req, res) => {
    const ws = await loadWorkspace(req, res, false);
    if (!ws) return;

    const filters = ["t.workspace_id = ?"];
    const params = [ws.id];

    if (req.query.status !== undefined) {
      if (!TICKET_STATUSES.includes(req.query.status)) {
        return res.status(400).json({ error: `status filter must be one of: ${TICKET_STATUSES.join(", ")}` });
      }
      filters.push("t.status = ?");
      params.push(req.query.status);
    }
    if (req.query.priority !== undefined) {
      if (!TICKET_PRIORITIES.includes(req.query.priority)) {
        return res.status(400).json({ error: `priority filter must be one of: ${TICKET_PRIORITIES.join(", ")}` });
      }
      filters.push("t.priority = ?");
      params.push(req.query.priority);
    }
    // owner_category is open-ended - an unknown value simply matches nothing.
    if (req.query.owner_category !== undefined) {
      filters.push("t.owner_category = ?");
      params.push(String(req.query.owner_category));
    }

    const rows = await db
      .prepare(`${TICKET_SELECT} WHERE ${filters.join(" AND ")} ORDER BY t.created_at DESC, t.id DESC`)
      .all(...params);
    const nowSec = Math.floor(Date.now() / 1000);
    res.json(rows.map((r) => ticketRow(r, nowSec)));
  }),
);

// GET /:id/tickets/sla-summary - workspace-wide response-time rollup for the
// "Service discipline" tile. Own endpoint, not a query param on the list:
//   - it's a different shape (a rollup, not a list) and use case (the tile
//     renders 3 numbers without needing the tickets);
//   - it's over ALL open/in_progress tickets, never the list's filtered subset;
//   - keeps the list response a bare array for existing callers.
// Any workspace member (read).
router.get(
  "/:id/tickets/sla-summary",
  asyncHandler(async (req, res) => {
    const ws = await loadWorkspace(req, res, false);
    if (!ws) return;
    const openTickets = await db
      .prepare(
        "SELECT priority, status, created_at FROM tickets WHERE workspace_id = ? AND status IN ('open', 'in_progress')",
      )
      .all(ws.id);
    const nowSec = Math.floor(Date.now() / 1000);
    const counts = summariseTicketSla(openTickets, nowSec);
    res.json({
      workspace_id: ws.id,
      targets: ticketSlaTargets(),
      counts,
      total_open: counts.breached + counts.due_today + counts.within_sla,
    });
  }),
);

// GET /:id/tickets/:ticketId - single ticket. Any workspace member.
router.get(
  "/:id/tickets/:ticketId",
  asyncHandler(async (req, res) => {
    const ws = await loadWorkspace(req, res, false);
    if (!ws) return;
    const row = await db
      .prepare(`${TICKET_SELECT} WHERE t.id = ? AND t.workspace_id = ?`)
      .get(req.params.ticketId, ws.id);
    if (!row) return res.status(404).json({ error: "Ticket not found" });
    res.json(ticketRow(row));
  }),
);

// PATCH /:id/tickets/:ticketId - update status / owner_category / priority.
// workspace_editor+. resolved_at is managed off the status change.
router.patch(
  "/:id/tickets/:ticketId",
  asyncHandler(async (req, res) => {
    const ws = await loadWorkspaceForTicketWrite(req, res);
    if (!ws) return;
    const ticket = await db
      .prepare("SELECT * FROM tickets WHERE id = ? AND workspace_id = ?")
      .get(req.params.ticketId, ws.id);
    if (!ticket) return res.status(404).json({ error: "Ticket not found" });

    const sawKey = ["status", "owner_category", "priority"].some((k) => req.body?.[k] !== undefined);
    if (!sawKey) {
      return res.status(400).json({ error: "Send at least one of: status, owner_category, priority" });
    }

    const updates = [];
    const values = [];
    const changed = [];

    if (req.body?.status !== undefined) {
      const status = String(req.body.status);
      if (!TICKET_STATUSES.includes(status)) {
        return res.status(400).json({ error: `status must be one of: ${TICKET_STATUSES.join(", ")}` });
      }
      if (status !== ticket.status) {
        updates.push("status = ?");
        values.push(status);
        changed.push(`status: ${ticket.status} -> ${status}`);
        const wasDone = TICKET_DONE_STATUSES.has(ticket.status);
        const nowDone = TICKET_DONE_STATUSES.has(status);
        if (nowDone && !wasDone) updates.push("resolved_at = UNIX_TIMESTAMP()");
        else if (!nowDone && wasDone) updates.push("resolved_at = NULL");
      }
    }
    if (req.body?.owner_category !== undefined) {
      const oc = String(req.body.owner_category);
      if (!TICKET_OWNER_CATEGORIES.includes(oc)) {
        return res.status(400).json({ error: `owner_category must be one of: ${TICKET_OWNER_CATEGORIES.join(", ")}` });
      }
      if (oc !== ticket.owner_category) {
        updates.push("owner_category = ?");
        values.push(oc);
        changed.push(`owner: ${ticket.owner_category} -> ${oc}`);
      }
    }
    if (req.body?.priority !== undefined) {
      const p = String(req.body.priority);
      if (!TICKET_PRIORITIES.includes(p)) {
        return res.status(400).json({ error: `priority must be one of: ${TICKET_PRIORITIES.join(", ")}` });
      }
      if (p !== ticket.priority) {
        updates.push("priority = ?");
        values.push(p);
        changed.push(`priority: ${ticket.priority} -> ${p}`);
      }
    }

    if (!updates.length) {
      // Valid keys, but every value already matches - return the row unchanged.
      return res.json(ticketRow(await db.prepare(`${TICKET_SELECT} WHERE t.id = ?`).get(ticket.id)));
    }

    updates.push("updated_at = UNIX_TIMESTAMP()");
    values.push(ticket.id);
    await db.prepare(`UPDATE tickets SET ${updates.join(", ")} WHERE id = ?`).run(...values);

    logActivity(
      req.user.id,
      "ticket_updated",
      `workspace: ${ws.name} (${ws.id}), ticket: ${ticket.title}, ${changed.join(", ")}`,
      ticket.device_id,
      getClientIp(req),
      ws.id,
    );

    const row = await db.prepare(`${TICKET_SELECT} WHERE t.id = ?`).get(ticket.id);
    res.json(ticketRow(row));
  }),
);

module.exports = router;
