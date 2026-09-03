'use strict';

// Phase 4 Stage C — ticket response-time SLA: a per-priority target (hours) and
// a derived Breached / Due today / Within SLA status for OPEN and IN_PROGRESS
// tickets. Matches the demo's "Service discipline" section.
//
// Everything here is COMPUTED ON READ (like live_breach in dashboard-reports.js):
// a ticket's age moves continuously, so a stored status would be stale the next
// second. Nothing is written.
//
// The clock: a ticket's SLA runs from created_at, not updated_at — editing a
// ticket must not reset its response-time budget.
//
// Categories scale with each priority's OWN target — the "due today" band is the
// final 50% of the budget, so it's usable at every priority level, not just low
// (secondsRemaining = created_at + target - now):
//   breached    secondsRemaining <= 0                  already at or past target
//   due_today   0 < secondsRemaining <= target * 0.5   in the second half of the budget
//   within_sla  secondsRemaining > target * 0.5        more than half the budget left
// e.g. high (4h target): within_sla until 2h remain, then due_today, breach at 4h.
// resolved / closed tickets are not "due" anything -> response_status is null.

const config = require('../config');
const appSettings = require('./app-settings');

// Fraction of a priority's target that marks the start of the "due today" band.
const DUE_SOON_FRACTION = 0.5;

// Priority -> env-default hours. Unknown priority falls back to the medium
// target rather than throwing (priority is a validated VARCHAR, but be safe).
const TICKET_SLA_DEFAULT_HOURS = {
  high: config.ticketSlaHoursHigh,
  medium: config.ticketSlaHoursMedium,
  low: config.ticketSlaHoursLow,
};

// Hours target for a priority. Persisted app_settings wins; else the config
// env default. A stored non-number falls back too (getNum handles that).
function ticketSlaTargetHours(priority) {
  const envDefault = TICKET_SLA_DEFAULT_HOURS[priority] ?? config.ticketSlaHoursMedium;
  return appSettings.getNum(`ticket_sla_hours_${priority}`, envDefault);
}

// The full { high, medium, low } target map, for the summary endpoint.
function ticketSlaTargets() {
  return {
    high: ticketSlaTargetHours('high'),
    medium: ticketSlaTargetHours('medium'),
    low: ticketSlaTargetHours('low'),
  };
}

// Epoch second the ticket is due by (created_at + target). Always computable;
// meaningful for the UI even on a done ticket ("was due ...").
function ticketSlaDueAt(ticket) {
  return ticket.created_at + Math.round(ticketSlaTargetHours(ticket.priority) * 3600);
}

// 'breached' | 'due_today' | 'within_sla', or null when the ticket is not in a
// state that can be "due" (resolved / closed). The due_today band is the final
// DUE_SOON_FRACTION of the priority's target, so it scales per priority.
function ticketResponseStatus(ticket, nowSec = Math.floor(Date.now() / 1000)) {
  if (ticket.status !== 'open' && ticket.status !== 'in_progress') return null;
  const secondsRemaining = ticketSlaDueAt(ticket) - nowSec;
  if (secondsRemaining <= 0) return 'breached';
  const dueSoonSec = ticketSlaTargetHours(ticket.priority) * 3600 * DUE_SOON_FRACTION;
  if (secondsRemaining <= dueSoonSec) return 'due_today';
  return 'within_sla';
}

// { breached, due_today, within_sla } counts over a list of ticket rows,
// ignoring the ones whose response_status is null (resolved / closed).
function summariseTicketSla(tickets, nowSec = Math.floor(Date.now() / 1000)) {
  const counts = { breached: 0, due_today: 0, within_sla: 0 };
  for (const t of tickets) {
    const s = ticketResponseStatus(t, nowSec);
    if (s) counts[s] += 1;
  }
  return counts;
}

module.exports = {
  TICKET_SLA_DEFAULT_HOURS,
  ticketSlaTargetHours,
  ticketSlaTargets,
  ticketSlaDueAt,
  ticketResponseStatus,
  summariseTicketSla,
};
