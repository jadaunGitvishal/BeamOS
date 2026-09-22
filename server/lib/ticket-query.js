'use strict';

// Shared ticket read-query pieces, factored out of routes/workspaces.js so
// Ref 73's read-only public API-token router (routes/tickets-readonly.js)
// can return byte-identical shapes without a second implementation to drift
// from the JWT-facing /:id/tickets routes. Write validation (title/description
// length caps, TICKET_DONE_STATUSES) stays in workspaces.js - it's write-only
// and this module is deliberately read-only.

const { ticketResponseStatus, ticketSlaDueAt, ticketSlaTargetHours } = require('./ticket-sla');

// Plain VARCHAR in the schema, not an ENUM - the route validates against this
// known set (see schema.sql's tickets note). Adding a value is a one-line
// change with no migration.
const TICKET_OWNER_CATEGORIES = ['customer_it', 'store_staff', 'platform', 'hardware', 'unassigned'];
const TICKET_STATUSES = ['open', 'in_progress', 'resolved', 'closed'];
const TICKET_PRIORITIES = ['low', 'medium', 'high'];
// Ref 58: 'reactive' (default - a human filed it) | 'proactive' (the system
// found it first) | 'emergency' (a manual override, independent of source).
const TICKET_CATEGORIES = ['reactive', 'proactive', 'emergency'];

const TICKET_SELECT = `
  SELECT t.*, u.email AS created_by_email, d.name AS device_name,
         oh.likely_cause AS likely_cause
  FROM tickets t
  LEFT JOIN users u ON u.id = t.created_by
  LEFT JOIN devices d ON d.id = t.device_id
  LEFT JOIN outage_history oh
    ON oh.device_id = t.device_id AND oh.started_at = t.source_outage_start
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
    ticket_category: t.ticket_category,
    created_by: t.created_by,
    created_by_email: t.created_by_email ?? null,
    auto_source: t.auto_source ?? null,
    source_outage_start: t.source_outage_start ?? null,
    likely_cause: t.likely_cause ?? null,
    created_at: t.created_at,
    updated_at: t.updated_at,
    resolved_at: t.resolved_at ?? null,
    response_status: ticketResponseStatus(t, nowSec),
    sla_due_at: ticketSlaDueAt(t),
    sla_target_hours: ticketSlaTargetHours(t.priority),
  };
}

module.exports = {
  TICKET_OWNER_CATEGORIES,
  TICKET_STATUSES,
  TICKET_PRIORITIES,
  TICKET_CATEGORIES,
  TICKET_SELECT,
  ticketRow,
};
