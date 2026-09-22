'use strict';

const express = require('express');
const router = express.Router();
const { db } = require('../db/database');
const { asyncHandler } = require('../lib/async-handler');
const {
  TICKET_STATUSES,
  TICKET_PRIORITIES,
  TICKET_CATEGORIES,
  TICKET_SELECT,
  ticketRow,
} = require('../lib/ticket-query');
const { ticketSlaTargets, summariseTicketSla } = require('../lib/ticket-sla');

// Ref 73 — read-only ticket surface for the public API-token door (Power BI /
// Tableau / any external reader). GET-only by construction: ticket creation
// and every mutation (status/owner_category/priority/ticket_category) stay
// exclusively on POST/PATCH /api/workspaces/:id/tickets, which is JWT-only
// (config/api-surface.js's MUST_BE_PRIVATE list) and untouched by this file.
// A read-scope token reaching this router can only ever GET.
//
// Targets the caller's BOUND workspace via resolveTenancy (req.workspaceId),
// not a :id URL param - the same shape routes/sim-inventory.js already uses
// for its own token-reachable GETs, and the natural fit for a token that is
// bound to exactly one workspace (middleware/apiToken.js). Row shaping
// (TICKET_SELECT/ticketRow) is imported from lib/ticket-query.js, the SAME
// module routes/workspaces.js's own ticket GET routes use - one query, one
// shape, both surfaces, no drift.

// GET /api/tickets?status=&priority=&owner_category=&ticket_category=
router.get(
  '/',
  asyncHandler(async (req, res) => {
    if (!req.workspaceId) return res.json([]);

    const filters = ['t.workspace_id = ?'];
    const params = [req.workspaceId];

    if (req.query.status !== undefined) {
      if (!TICKET_STATUSES.includes(req.query.status)) {
        return res.status(400).json({ error: `status filter must be one of: ${TICKET_STATUSES.join(', ')}` });
      }
      filters.push('t.status = ?');
      params.push(req.query.status);
    }
    if (req.query.priority !== undefined) {
      if (!TICKET_PRIORITIES.includes(req.query.priority)) {
        return res.status(400).json({ error: `priority filter must be one of: ${TICKET_PRIORITIES.join(', ')}` });
      }
      filters.push('t.priority = ?');
      params.push(req.query.priority);
    }
    if (req.query.owner_category !== undefined) {
      filters.push('t.owner_category = ?');
      params.push(String(req.query.owner_category));
    }
    if (req.query.ticket_category !== undefined) {
      if (!TICKET_CATEGORIES.includes(req.query.ticket_category)) {
        return res.status(400).json({ error: `ticket_category filter must be one of: ${TICKET_CATEGORIES.join(', ')}` });
      }
      filters.push('t.ticket_category = ?');
      params.push(req.query.ticket_category);
    }

    const rows = await db
      .prepare(`${TICKET_SELECT} WHERE ${filters.join(' AND ')} ORDER BY t.created_at DESC, t.id DESC`)
      .all(...params);
    const nowSec = Math.floor(Date.now() / 1000);
    res.json(rows.map((r) => ticketRow(r, nowSec)));
  }),
);

// GET /api/tickets/sla-summary - identical rollup to
// /api/workspaces/:id/tickets/sla-summary, scoped to the token's bound
// workspace. Registered BEFORE /:ticketId so it can't be shadowed as a param.
router.get(
  '/sla-summary',
  asyncHandler(async (req, res) => {
    if (!req.workspaceId) return res.status(403).json({ error: 'No workspace context' });
    const openTickets = await db
      .prepare(
        "SELECT priority, status, created_at FROM tickets WHERE workspace_id = ? AND status IN ('open', 'in_progress')",
      )
      .all(req.workspaceId);
    const nowSec = Math.floor(Date.now() / 1000);
    const counts = summariseTicketSla(openTickets, nowSec);
    res.json({
      workspace_id: req.workspaceId,
      targets: ticketSlaTargets(),
      counts,
      total_open: counts.breached + counts.due_today + counts.within_sla,
    });
  }),
);

// GET /api/tickets/:ticketId - single ticket, scoped to the token's bound workspace.
router.get(
  '/:ticketId',
  asyncHandler(async (req, res) => {
    if (!req.workspaceId) return res.status(403).json({ error: 'No workspace context' });
    const row = await db
      .prepare(`${TICKET_SELECT} WHERE t.id = ? AND t.workspace_id = ?`)
      .get(req.params.ticketId, req.workspaceId);
    if (!row) return res.status(404).json({ error: 'Ticket not found' });
    res.json(ticketRow(row));
  }),
);

module.exports = router;
