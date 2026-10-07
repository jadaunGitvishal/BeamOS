'use strict';

// PMI Ref 66 / Ref 71: lib/runtime-summary.summarizeRuntime (pure, no DB).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { summarizeRuntime, round1 } = require('../lib/runtime-summary');

const DAY = 86400;
const start = Date.UTC(2026, 9, 5) / 1000; // 2026-10-05 00:00 UTC
const week = { startEpoch: start, endEpoch: start + 7 * DAY }; // 2026-10-05 .. 2026-10-11
const before = start - 30 * DAY;

const screen = (id, ws, registered_at = before, blocked = 0) => ({ id, name: `Screen ${id}`, workspace_id: ws, registered_at, blocked });
const use = (device_id, day, online_seconds) => ({ device_id, day, online_seconds });

test('totals and uptime maths (per screen, per workspace, overall)', () => {
  const r = summarizeRuntime({
    ...week,
    workspaces: [{ id: 'w1', name: 'WS 1' }, { id: 'w2', name: 'WS 2' }],
    screens: [screen('a', 'w1'), screen('b', 'w1'), screen('c', 'w2')],
    usage: [
      // a: 7 full days
      ...[5, 6, 7, 8, 9, 10, 11].map((d) => use('a', `2026-10-${String(d).padStart(2, '0')}`, DAY)),
      // b: 3.5 days in total
      use('b', '2026-10-05', DAY), use('b', '2026-10-06', DAY), use('b', '2026-10-07', DAY), use('b', '2026-10-08', DAY / 2),
      // c: 1 hour
      use('c', '2026-10-09', 3600),
      // outside the period: ignored
      use('a', '2026-10-04', DAY), use('b', '2026-10-12', DAY),
    ],
  });

  const by = Object.fromEntries(r.screens.map((s) => [s.id, s]));
  assert.equal(by.a.runtime_seconds, 7 * DAY);
  assert.equal(by.a.runtime_hours, 168);
  assert.equal(by.a.uptime_pct, 100);
  assert.equal(by.b.runtime_hours, 84);
  assert.equal(by.b.uptime_pct, 50);
  assert.equal(by.c.runtime_hours, 1);
  assert.equal(by.c.uptime_pct, round1((3600 / (7 * DAY)) * 100)); // 0.6
  assert.equal(by.c.uptime_pct, 0.6);

  const w1 = r.workspaces.find((w) => w.workspace_id === 'w1');
  assert.equal(w1.name, 'WS 1');
  assert.equal(w1.screens, 2);
  assert.equal(w1.runtime_hours, 252);
  assert.equal(w1.avg_uptime_pct, 75);

  assert.equal(r.overall.screens, 3);
  assert.equal(r.overall.runtime_seconds, 7 * DAY + 3.5 * DAY + 3600);
  assert.equal(r.overall.runtime_hours, 253);
  // (7 + 3.5 + 1/24) / 21 days
  assert.equal(r.overall.avg_uptime_pct, round1(((7 + 3.5 + 1 / 24) / 21) * 100)); // 50.2
  assert.equal(r.overall.zero_runtime_count, 0);
  assert.equal(r.overall.zero_runtime_pct, 0);
  assert.equal(r.period.first_day, '2026-10-05');
  assert.equal(r.period.last_day, '2026-10-11');
});

test('a screen registered before the period with no online seconds is zero-runtime', () => {
  const r = summarizeRuntime({
    ...week,
    screens: [screen('on', 'w1'), screen('dead', 'w1'), screen('dead-at-start', 'w1', start)],
    usage: [use('on', '2026-10-06', 3600), use('dead', '2026-10-06', 0)],
  });
  const by = Object.fromEntries(r.screens.map((s) => [s.id, s]));
  assert.equal(by.dead.zero_runtime, true);
  assert.equal(by.dead.uptime_pct, 0);
  assert.equal(by['dead-at-start'].zero_runtime, true, 'registered exactly at the period start counts as the whole period');
  assert.equal(by.on.zero_runtime, false);
  assert.equal(r.overall.zero_runtime_count, 2);
  assert.equal(r.overall.zero_runtime_eligible, 3);
  assert.equal(r.overall.zero_runtime_pct, 66.7);
});

test('a screen registered mid-period is not zero-runtime and its uptime uses time since registration', () => {
  const regAt = start + 5 * DAY; // 2 days left in the week
  const r = summarizeRuntime({
    ...week,
    screens: [screen('old', 'w1'), screen('new-idle', 'w1', regAt), screen('new-busy', 'w1', regAt)],
    usage: [use('new-busy', '2026-10-10', DAY)],
  });
  const by = Object.fromEntries(r.screens.map((s) => [s.id, s]));
  assert.equal(by['new-idle'].is_new, true);
  assert.equal(by['new-idle'].zero_runtime, false, 'new screens are never zero-runtime');
  assert.equal(by['new-busy'].available_seconds, 2 * DAY);
  assert.equal(by['new-busy'].uptime_pct, 50, '1 day online out of the 2 since registration');
  // only "old" is in the zero-runtime denominator (and numerator)
  assert.equal(r.overall.zero_runtime_count, 1);
  assert.equal(r.overall.zero_runtime_eligible, 1);
  assert.equal(r.overall.zero_runtime_pct, 100);
  assert.equal(r.overall.new_screens, 2);
  // time-weighted: 1 day / (7 + 2 + 2) days
  assert.equal(r.overall.avg_uptime_pct, round1((1 / 11) * 100));
});

test('screens registered at/after the period end, and blocked screens, are excluded entirely', () => {
  const r = summarizeRuntime({
    ...week,
    screens: [screen('ok', 'w1'), screen('blocked', 'w1', before, 1), screen('future', 'w1', week.endEpoch)],
    usage: [use('blocked', '2026-10-06', DAY)],
  });
  assert.deepEqual(r.screens.map((s) => s.id), ['ok']);
  assert.deepEqual(r.excluded, { blocked: 1, not_yet_registered: 1 });
  assert.equal(r.overall.screens, 1);
  assert.equal(r.overall.runtime_seconds, 0, "the blocked screen's usage is not counted");
  assert.equal(r.overall.zero_runtime_count, 1);
});

test('empty input: zeros and nulls, no throw', () => {
  const r = summarizeRuntime({ ...week });
  assert.deepEqual(r.screens, []);
  assert.deepEqual(r.workspaces, []);
  assert.equal(r.overall.screens, 0);
  assert.equal(r.overall.runtime_hours, 0);
  assert.equal(r.overall.avg_uptime_pct, null);
  assert.equal(r.overall.zero_runtime_pct, null);
  // a listed workspace with no screens still gets a (zero) row
  const r2 = summarizeRuntime({ ...week, workspaces: [{ id: 'w', name: 'Empty' }] });
  assert.equal(r2.workspaces.length, 1);
  assert.equal(r2.workspaces[0].screens, 0);
  assert.equal(r2.workspaces[0].avg_uptime_pct, null);
  assert.throws(() => summarizeRuntime({ startEpoch: start, endEpoch: start }), /startEpoch < endEpoch/);
});

test('rounding: half-up to one decimal, uptime capped at 100', () => {
  assert.equal(round1(0.05), 0.1);
  assert.equal(round1(1.25), 1.3);
  assert.equal(round1(2.349), 2.3);
  const day = { startEpoch: start, endEpoch: start + DAY };
  const r = summarizeRuntime({
    ...day,
    screens: [screen('x', 'w'), screen('y', 'w'), screen('over', 'w', start + DAY - 60)],
    usage: [use('x', '2026-10-05', 180), use('y', '2026-10-05', 43200 + 43), use('over', '2026-10-05', 600)],
  });
  const by = Object.fromEntries(r.screens.map((s) => [s.id, s]));
  assert.equal(by.x.runtime_hours, 0.1, '180 s = 0.05 h rounds up');
  assert.equal(by.x.uptime_pct, 0.2); // 0.208
  assert.equal(by.y.uptime_pct, 50); // 50.0497...
  assert.equal(by.over.uptime_pct, 100, 'day accrual larger than time since registration is capped');
});
