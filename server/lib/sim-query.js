'use strict';

// Shared SIM-inventory read-query pieces, factored out of routes/sim-inventory.js
// (same move lib/ticket-query.js made for tickets) so Ref 28's data-platform
// export (lib/data-platform-export.js) lands byte-identical rows to what
// GET /api/sim-inventory returns, without a second SELECT to drift from it.
//
// (This Ref 28 is the server-side "Extensibility & integrations" item - a
// separate, unrelated RFP row from the earlier Android offline-resilience
// Ref 28 work; the two share a number in the PMI tracking sheet.)

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

module.exports = { SIM_SELECT, simRow };
