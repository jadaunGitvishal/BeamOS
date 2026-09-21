// Ref 65 — SIM inventory vocabulary, shared wherever the SIM lifecycle is
// rendered (currently just SimInventoryView.jsx, same pattern as
// lib/tickets.js / lib/campaigns.js keeping this in one place).

export const SIM_STATUSES = ["in_stock", "assigned", "active", "retired"];

export const SIM_STATUS = {
  in_stock: { label: "In stock", color: "var(--ink3)" },
  assigned: { label: "Assigned", color: "var(--warn)" },
  active: { label: "Active", color: "var(--ok)" },
  retired: { label: "Retired", color: "var(--bad)" },
};
