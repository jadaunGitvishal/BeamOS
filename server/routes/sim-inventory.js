const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const { db } = require("../db/database");
const { asyncHandler } = require("../lib/async-handler");
const { requireWorkspaceAdmin } = require("../lib/permissions");
const { logActivity, getClientIp } = require("../services/activity");

// Ref 65 — SIM inventory: a stock ledger for physical SIM cards, entirely
// manual (no carrier API integration; status is admin/ops-set). Mounted at
// /api/sim-inventory (config/api-surface.js). req.workspaceId comes from
// resolveTenancy, so every route below is implicitly scoped to the caller's
// active workspace, the same mechanism dashboard-devices.js's GET routes use.
//
// Ref 73: this router is on the PUBLIC (token-reachable) door. Its GETs need
// only 'read' scope; POST/PATCH below are already gated by requireWorkspaceAdmin
// AND now additionally by tokenScopeGate (write/full scope) - a bare 'read'
// token cannot reach them.
//
// Read = any workspace member (tenancy alone gates it, same rationale as
// dashboard-devices.js: nothing here exposes more than a viewer could already
// see on the Devices page). Write (create/update) = workspace_admin+
// (requireWorkspaceAdmin) — a physical-asset/stock ledger with real carrier-
// billing exposure is closer to white-label.js's admin-gated branding config
// than to tickets/campaigns' editor+ bar, so this deliberately sits one tier
// above how devices.js itself is edited today (workspace_editor+).
//
// status is a plain VARCHAR in the schema (see schema.sql sim_inventory
// note), validated here against SIM_STATUSES - same "no migration to add a
// value" philosophy as TICKET_OWNER_CATEGORIES in routes/workspaces.js.
const SIM_STATUSES = ["in_stock", "assigned", "active", "retired"];
// Statuses that imply a live binding to a device; leaving BOTH clears
// assigned_device_id, entering either REQUIRES one (already-set or supplied).
const ASSIGNED_STATUSES = new Set(["assigned", "active"]);
const ICCID_MAX = 64;
const SERIAL_MAX = 128;
const CARRIER_MAX = 100;
const NOTES_MAX = 10000;

const SIM_SELECT = `
  SELECT s.*, d.name AS assigned_device_name, u.email AS created_by_email
  FROM sim_inventory s
  LEFT JOIN devices d ON d.id = s.assigned_device_id
  LEFT JOIN users u ON u.id = s.created_by
`;

function simRow(s) {
  return {
    id: s.id,
    workspace_id: s.workspace_id,
    iccid: s.iccid,
    serial_number: s.serial_number ?? null,
    carrier: s.carrier ?? null,
    status: s.status,
    assigned_device_id: s.assigned_device_id ?? null,
    assigned_device_name: s.assigned_device_name ?? null,
    notes: s.notes ?? null,
    created_by: s.created_by ?? null,
    created_by_email: s.created_by_email ?? null,
    created_at: s.created_at,
    updated_at: s.updated_at,
    status_changed_at: s.status_changed_at,
  };
}

// Resolves + validates a device_id against the caller's active workspace.
// Returns the device row, or null after sending the error response.
async function loadAssignableDevice(req, res, deviceId) {
  const device = await db.prepare("SELECT id, workspace_id FROM devices WHERE id = ?").get(deviceId);
  if (!device) {
    res.status(404).json({ error: "Device not found" });
    return null;
  }
  if (device.workspace_id !== req.workspaceId) {
    res.status(400).json({ error: "Device is not in this workspace" });
    return null;
  }
  return device;
}

// GET /api/dashboard/sim-inventory?status=&carrier= - list this workspace's SIMs.
router.get(
  "/",
  asyncHandler(async (req, res) => {
    if (!req.workspaceId) return res.json([]);

    let sql = `${SIM_SELECT} WHERE s.workspace_id = ?`;
    const params = [req.workspaceId];

    if (req.query.status !== undefined) {
      const status = String(req.query.status);
      if (!SIM_STATUSES.includes(status)) {
        return res.status(400).json({ error: `status must be one of: ${SIM_STATUSES.join(", ")}` });
      }
      sql += " AND s.status = ?";
      params.push(status);
    }
    if (req.query.carrier) {
      sql += " AND s.carrier = ?";
      params.push(String(req.query.carrier));
    }
    sql += " ORDER BY s.created_at DESC";

    const rows = await db.prepare(sql).all(...params);
    res.json(rows.map(simRow));
  }),
);

// GET /api/dashboard/sim-inventory/:id - single SIM. Any workspace member.
router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!req.workspaceId) return res.status(403).json({ error: "No workspace context" });
    const row = await db.prepare(`${SIM_SELECT} WHERE s.id = ? AND s.workspace_id = ?`).get(req.params.id, req.workspaceId);
    if (!row) return res.status(404).json({ error: "SIM not found" });
    res.json(simRow(row));
  }),
);

// POST /api/dashboard/sim-inventory - add a SIM to stock. Always starts
// 'in_stock' (the RFP's stated entry point); status is changed via the PATCH
// assignment/activation/retirement flow below, never set directly here.
router.post(
  "/",
  requireWorkspaceAdmin,
  asyncHandler(async (req, res) => {
    if (!req.workspaceId) return res.status(403).json({ error: "No workspace context" });

    const iccid = String(req.body?.iccid || "").trim();
    if (!iccid) return res.status(400).json({ error: "iccid is required" });
    if (iccid.length > ICCID_MAX) {
      return res.status(400).json({ error: `iccid must be ${ICCID_MAX} characters or fewer` });
    }

    let serialNumber = req.body?.serial_number;
    if (serialNumber === undefined || serialNumber === null || serialNumber === "") {
      serialNumber = null;
    } else {
      serialNumber = String(serialNumber).trim();
      if (serialNumber.length > SERIAL_MAX) {
        return res.status(400).json({ error: `serial_number must be ${SERIAL_MAX} characters or fewer` });
      }
    }

    let carrier = req.body?.carrier;
    if (carrier === undefined || carrier === null || carrier === "") {
      carrier = null;
    } else {
      carrier = String(carrier).trim();
      if (carrier.length > CARRIER_MAX) {
        return res.status(400).json({ error: `carrier must be ${CARRIER_MAX} characters or fewer` });
      }
    }

    let notes = req.body?.notes;
    if (notes === undefined || notes === null || notes === "") {
      notes = null;
    } else {
      notes = String(notes);
      if (notes.length > NOTES_MAX) {
        return res.status(400).json({ error: `notes must be ${NOTES_MAX} characters or fewer` });
      }
    }

    const id = crypto.randomUUID();
    try {
      await db
        .prepare(
          `INSERT INTO sim_inventory (id, workspace_id, iccid, serial_number, carrier, status, notes, created_by)
           VALUES (?, ?, ?, ?, ?, 'in_stock', ?, ?)`,
        )
        .run(id, req.workspaceId, iccid, serialNumber, carrier, notes, req.user.id);
    } catch (e) {
      if (e.code === "ER_DUP_ENTRY") {
        return res.status(409).json({ error: "A SIM with this ICCID already exists" });
      }
      throw e;
    }

    logActivity(
      req.user.id,
      "sim_inventory_created",
      `workspace: ${req.workspace?.name || req.workspaceId}, iccid: ${iccid}` + (carrier ? `, carrier: ${carrier}` : ""),
      null,
      getClientIp(req),
      req.workspaceId,
    );

    const row = await db.prepare(`${SIM_SELECT} WHERE s.id = ?`).get(id);
    res.status(201).json(simRow(row));
  }),
);

// PATCH /api/dashboard/sim-inventory/:id - update carrier/notes and/or drive
// the status lifecycle. Moving TO 'assigned'/'active' requires a valid
// assigned_device_id (already on the row, or supplied in this same body) in
// the caller's workspace; moving to 'in_stock'/'retired' always clears it.
router.patch(
  "/:id",
  requireWorkspaceAdmin,
  asyncHandler(async (req, res) => {
    if (!req.workspaceId) return res.status(403).json({ error: "No workspace context" });
    const row = await db.prepare("SELECT * FROM sim_inventory WHERE id = ? AND workspace_id = ?").get(req.params.id, req.workspaceId);
    if (!row) return res.status(404).json({ error: "SIM not found" });

    const updates = [];
    const values = [];

    if (req.body?.carrier !== undefined) {
      const carrier = req.body.carrier ? String(req.body.carrier).trim() : null;
      if (carrier && carrier.length > CARRIER_MAX) {
        return res.status(400).json({ error: `carrier must be ${CARRIER_MAX} characters or fewer` });
      }
      updates.push("carrier = ?");
      values.push(carrier);
    }
    if (req.body?.notes !== undefined) {
      const notes = req.body.notes ? String(req.body.notes) : null;
      if (notes && notes.length > NOTES_MAX) {
        return res.status(400).json({ error: `notes must be ${NOTES_MAX} characters or fewer` });
      }
      updates.push("notes = ?");
      values.push(notes);
    }

    let newAssignedDeviceId = row.assigned_device_id;
    let statusChanged = false;
    if (req.body?.status !== undefined) {
      const status = String(req.body.status);
      if (!SIM_STATUSES.includes(status)) {
        return res.status(400).json({ error: `status must be one of: ${SIM_STATUSES.join(", ")}` });
      }
      if (ASSIGNED_STATUSES.has(status)) {
        const deviceId = req.body.assigned_device_id !== undefined ? req.body.assigned_device_id : row.assigned_device_id;
        if (!deviceId) {
          return res.status(400).json({
            error: status === "assigned"
              ? "assigned_device_id is required when status is 'assigned'"
              : "SIM must be assigned to a device before it can be set active",
          });
        }
        const device = await loadAssignableDevice(req, res, String(deviceId));
        if (!device) return; // response already sent
        newAssignedDeviceId = device.id;
      } else {
        newAssignedDeviceId = null;
      }
      updates.push("status = ?", "status_changed_at = UNIX_TIMESTAMP()");
      values.push(status);
      statusChanged = status !== row.status;
    }

    if (newAssignedDeviceId !== row.assigned_device_id) {
      updates.push("assigned_device_id = ?");
      values.push(newAssignedDeviceId);
    }

    if (!updates.length) return res.status(400).json({ error: "Nothing to update" });

    updates.push("updated_at = UNIX_TIMESTAMP()");
    values.push(req.params.id);
    await db.prepare(`UPDATE sim_inventory SET ${updates.join(", ")} WHERE id = ?`).run(...values);

    if (statusChanged) {
      logActivity(
        req.user.id,
        "sim_inventory_status_changed",
        `iccid: ${row.iccid}, ${row.status} -> ${req.body.status}` +
          (newAssignedDeviceId ? `, device: ${newAssignedDeviceId}` : ""),
        newAssignedDeviceId || null,
        getClientIp(req),
        req.workspaceId,
      );
    }

    const updated = await db.prepare(`${SIM_SELECT} WHERE s.id = ?`).get(req.params.id);
    res.json(simRow(updated));
  }),
);

module.exports = router;
