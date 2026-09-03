'use strict';

// Phase 4 Stage C — ticket response-time SLA categorisation (lib/ticket-sla.js).
// Pure functions, no DB: appSettings.getNum falls back to the config env
// defaults (high 4h / medium 24h / low 72h) when nothing is loaded.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ticketResponseStatus,
  ticketSlaDueAt,
  ticketSlaTargetHours,
  summariseTicketSla,
} = require('../lib/ticket-sla');

const H = 3600;
const NOW = 1_800_000_000;
// a ticket created `ageH` hours before NOW
const tk = (priority, ageH, status = 'open') => ({ priority, status, created_at: NOW - Math.round(ageH * H) });
const statusAt = (ticket) => ticketResponseStatus(ticket, NOW);

test('default targets: high 4h, medium 24h, low 72h', () => {
  assert.equal(ticketSlaTargetHours('high'), 4);
  assert.equal(ticketSlaTargetHours('medium'), 24);
  assert.equal(ticketSlaTargetHours('low'), 72);
  assert.equal(ticketSlaTargetHours('bogus'), 24, 'unknown priority -> medium target, no throw');
});

test('sla_due_at = created_at + target', () => {
  assert.equal(ticketSlaDueAt(tk('high', 0)), NOW + 4 * H);
  assert.equal(ticketSlaDueAt(tk('low', 10)), NOW - 10 * H + 72 * H);
});

// The due_today band is the final 50% of each priority's target, so every
// priority has all three states. Boundaries: high 2h remaining (age 2h),
// medium 12h remaining (age 12h), low 36h remaining (age 36h).

test('high (4h target): within_sla -> due_today at 2h remaining -> breached at 4h', () => {
  assert.equal(statusAt(tk('high', 0)), 'within_sla', 'fresh high ticket is within_sla now');
  assert.equal(statusAt(tk('high', 1.999)), 'within_sla', 'just over 2h left');
  assert.equal(statusAt(tk('high', 2)), 'due_today', 'EXACTLY 2h left (50% of 4h) -> due_today');
  assert.equal(statusAt(tk('high', 2.001)), 'due_today', 'under 2h left');
  assert.equal(statusAt(tk('high', 3.999)), 'due_today', 'a few seconds before target');
  assert.equal(statusAt(tk('high', 4)), 'breached', 'EXACTLY at the target -> breached');
  assert.equal(statusAt(tk('high', 4.001)), 'breached', 'just past');
  assert.equal(statusAt(tk('high', 50)), 'breached', 'long past');
});

test('medium (24h target): boundary at 12h remaining', () => {
  assert.equal(statusAt(tk('medium', 0)), 'within_sla', 'fresh medium ticket is within_sla');
  assert.equal(statusAt(tk('medium', 11.999)), 'within_sla', 'just over 12h left');
  assert.equal(statusAt(tk('medium', 12)), 'due_today', 'EXACTLY 12h left (50% of 24h) -> due_today');
  assert.equal(statusAt(tk('medium', 12.001)), 'due_today', 'under 12h left');
  assert.equal(statusAt(tk('medium', 24)), 'breached', 'at the target');
});

test('low (72h target): boundary at 36h remaining', () => {
  assert.equal(statusAt(tk('low', 0)), 'within_sla');
  assert.equal(statusAt(tk('low', 35.999)), 'within_sla', 'just over 36h left');
  assert.equal(statusAt(tk('low', 36)), 'due_today', 'EXACTLY 36h left (50% of 72h) -> due_today');
  assert.equal(statusAt(tk('low', 36.001)), 'due_today', 'under 36h left');
  assert.equal(statusAt(tk('low', 72)), 'breached', 'at the target');
  assert.equal(statusAt(tk('low', 100)), 'breached');
});

test('in_progress tickets are categorised the same as open', () => {
  assert.equal(statusAt(tk('high', 0.5, 'in_progress')), 'within_sla');
  assert.equal(statusAt(tk('high', 3, 'in_progress')), 'due_today');
  assert.equal(statusAt(tk('high', 9, 'in_progress')), 'breached');
});

test('resolved / closed tickets have no response_status regardless of age', () => {
  assert.equal(statusAt(tk('high', 100, 'resolved')), null);
  assert.equal(statusAt(tk('high', 100, 'closed')), null);
  assert.equal(statusAt(tk('low', 0, 'resolved')), null);
});

test('summariseTicketSla counts by category and ignores resolved/closed', () => {
  const tickets = [
    tk('high', 5),               // breached (age 5h > 4h)
    tk('high', 3),               // due_today (1h left <= 2h)
    tk('high', 0.5),             // within_sla (3.5h left > 2h)
    tk('medium', 30),            // breached
    tk('medium', 18),            // due_today (6h left <= 12h)
    tk('low', 10),               // within_sla (62h left > 36h)
    tk('low', 60),               // due_today (12h left <= 36h)
    tk('high', 100, 'resolved'), // ignored
    tk('medium', 100, 'closed'), // ignored
  ];
  assert.deepEqual(summariseTicketSla(tickets, NOW), { breached: 2, due_today: 3, within_sla: 2 });
});

test('empty list -> all zero', () => {
  assert.deepEqual(summariseTicketSla([], NOW), { breached: 0, due_today: 0, within_sla: 0 });
});
