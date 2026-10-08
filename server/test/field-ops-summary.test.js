'use strict';

// PMI Ref 68 / Ref 71: lib/field-ops-summary (pure parts: summarise, resolvePeriod,
// the config block and the export tables). No DB.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fo = require('../lib/field-ops-summary');
const { summarizeRuntime, NOT_A_SCREEN_STATUS } = require('../lib/runtime-summary');

const DAY = 86400;
const T = (y, m, d, h = 0, min = 0, s = 0) => Date.UTC(y, m - 1, d, h, min, s) / 1000;
const NOW = new Date(Date.UTC(2026, 9, 7, 10)); // Wed 2026-10-07 10:00 UTC
const WEEK = fo.resolvePeriod('week', '2026-09-30', NOW); // 2026-W40: Mon 09-28 .. Mon 10-05
const NOW_EPOCH = NOW.getTime() / 1000;

let seq = 0;
const visit = (over = {}) => ({
  id: `v${++seq}`,
  device_id: 'd1',
  device_name: 'Screen 1',
  technician_user_id: 'u1',
  technician_name: 'Tech One',
  visit_type: 'Routine check',
  device_status: 'working',
  remarks: 'ok',
  status: 'completed',
  created_at: T(2026, 9, 29, 9),
  completed_at: T(2026, 9, 29, 10),
  ...over,
});
const run = (visits, tickets = [], activations = [], period = WEEK, opts = {}) =>
  fo.summarise(visits, tickets, activations, period, { nowEpoch: NOW_EPOCH, ...opts });

test('config block: the mapping, OEM category, labels and the two PMI-pending assumptions', () => {
  const c = fo.FIELD_OPS_CONFIG;
  assert.deepEqual({ ...c.VISIT_TYPE_SECTIONS }, { Installation: 'installation', 'Routine check': 'rfs', Repair: 'rm' });
  assert.equal(c.OTHER_SECTION, 'other');
  assert.equal(c.OEM_TICKET_OWNER_CATEGORY, 'hardware');
  assert.deepEqual(Object.keys(c.PMI_CONFIRMATION_PENDING).sort(), ['oem', 'rfs']);
  for (const k of ['installation', 'rfs', 'rm', 'other', 'in_progress', 'oem']) assert.ok(c.SECTION_LABELS[k], `label ${k}`);
  assert.ok(Object.isFrozen(c) && Object.isFrozen(c.VISIT_TYPE_SECTIONS), 'config is frozen');
  const d = fo.definitions();
  assert.deepEqual(d.pmi_confirmation_pending.map((p) => p.section).sort(), ['oem', 'rfs']);
  assert.equal(d.oem_ticket_owner_category, 'hardware');
});

test('each visit type maps to its section; unknown, blank and near-miss types go to other', () => {
  assert.equal(fo.sectionForVisitType('Installation'), 'installation');
  assert.equal(fo.sectionForVisitType('Routine check'), 'rfs');
  assert.equal(fo.sectionForVisitType('  Repair '), 'rm');
  for (const x of ['routine check', 'Audit', '', null, undefined, 'toString', '__proto__']) {
    assert.equal(fo.sectionForVisitType(x), 'other', String(x));
  }
  const r = run([
    visit({ visit_type: 'Installation' }),
    visit({ visit_type: 'Routine check' }),
    visit({ visit_type: 'Repair' }),
    visit({ visit_type: 'Repair' }),
    visit({ visit_type: 'Audit' }),
  ]);
  assert.equal(r.sections.installation.completed_visits, 1);
  assert.equal(r.sections.rfs.completed_visits, 1);
  assert.equal(r.sections.rm.completed_visits, 2);
  assert.equal(r.sections.other.completed_visits, 1);
  assert.equal(r.sections.other.visits[0].visit_type, 'Audit');
  assert.deepEqual(
    [r.totals.installation_visits, r.totals.rfs_visits, r.totals.rm_visits, r.totals.other_visits],
    [1, 1, 2, 1],
  );
});

test('only completed visits count (by completed_at); in-progress listed separately, never counted', () => {
  const r = run([
    visit({ id: 'done-in', completed_at: T(2026, 10, 1, 12) }),
    // created before the period, completed inside it: counts (completed_at decides)
    visit({ id: 'done-late', created_at: T(2026, 9, 20), completed_at: T(2026, 9, 28, 0, 0, 0) }),
    // created inside, completed after the period: not this period's
    visit({ id: 'done-after', completed_at: T(2026, 10, 5, 0, 0, 0) }),
    // completed before the period: not counted
    visit({ id: 'done-before', completed_at: T(2026, 9, 27, 23, 59, 59) }),
    // in progress: created before / inside the period -> listed; after -> not
    visit({ id: 'ip-before', status: 'in_progress', created_at: T(2026, 9, 1), completed_at: null }),
    visit({ id: 'ip-inside', status: 'in_progress', visit_type: 'Repair', created_at: T(2026, 10, 4, 23), completed_at: null }),
    visit({ id: 'ip-after', status: 'in_progress', created_at: T(2026, 10, 5), completed_at: null }),
  ]);
  assert.deepEqual(r.sections.rfs.visits.map((v) => v.id), ['done-late', 'done-in']);
  assert.equal(r.sections.rfs.completed_visits, 2);
  assert.equal(r.sections.rm.completed_visits, 0, 'an in-progress Repair is not an R&M visit');
  assert.deepEqual(r.sections.in_progress.visits.map((v) => v.id), ['ip-before', 'ip-inside']);
  assert.equal(r.totals.in_progress_visits, 2);
  const counted = ['installation', 'rfs', 'rm', 'other'].flatMap((k) => r.sections[k].visits.map((v) => v.id));
  for (const id of ['ip-before', 'ip-inside', 'ip-after']) assert.ok(!counted.includes(id), `${id} not counted as completed`);
  const techTotal = ['installation', 'rfs', 'rm', 'other'].reduce((n, k) => n + r.sections[k].by_technician.reduce((a, b) => a + b.visits, 0), 0);
  assert.equal(techTotal, 2, 'by-technician totals exclude in-progress');
});

test('periods: UTC day, ISO week from Monday 00:00 UTC, calendar month; boundaries are half-open', () => {
  const day = fo.resolvePeriod('day', '2026-10-01', NOW);
  assert.deepEqual([day.startEpoch, day.endEpoch], [T(2026, 10, 1), T(2026, 10, 2)]);
  // every day of an ISO week resolves to the same Monday-start week
  for (const d of ['2026-09-28', '2026-10-01', '2026-10-04']) {
    const w = fo.resolvePeriod('week', d, NOW);
    assert.deepEqual([w.startEpoch, w.endEpoch, w.fileKey], [T(2026, 9, 28), T(2026, 10, 5), '2026-W40'], d);
  }
  assert.equal(new Date(WEEK.startEpoch * 1000).getUTCDay(), 1, 'week starts on a Monday');
  const yearEdge = fo.resolvePeriod('week', '2027-01-01', new Date(Date.UTC(2027, 0, 20)));
  assert.equal(yearEdge.fileKey, '2026-W53');
  const feb = fo.resolvePeriod('month', '2028-02-29', new Date(Date.UTC(2028, 5, 1)));
  assert.deepEqual([feb.startEpoch, feb.endEpoch], [T(2028, 2, 1), T(2028, 3, 1)]);
  // defaults = Ref 66's last complete periods
  assert.equal(fo.resolvePeriod('day', undefined, NOW).fileKey, '2026-10-06');
  assert.equal(fo.resolvePeriod('week', '', NOW).fileKey, '2026-W40');
  assert.equal(fo.resolvePeriod('month', null, NOW).fileKey, '2026-09');
  assert.equal(fo.resolvePeriod('week', '2026-10-07', NOW).complete, false, 'current week is flagged incomplete');
  for (const [k, d] of [['year', undefined], ['day', '2026-02-30'], ['day', '2026-1-1'], ['day', '2026-10-08'], ['week', 'monday']]) {
    assert.throws(() => fo.resolvePeriod(k, d, NOW), fo.PeriodError, `${k} ${d}`);
  }

  // summarise honours the bounds exactly: start inclusive, end exclusive
  const at = (completed_at) => visit({ completed_at });
  for (const [p, inside, outside] of [
    [day, [T(2026, 10, 1), T(2026, 10, 1, 23, 59, 59)], [T(2026, 9, 30, 23, 59, 59), T(2026, 10, 2)]],
    [WEEK, [T(2026, 9, 28), T(2026, 10, 4, 23, 59, 59)], [T(2026, 9, 27, 23, 59, 59), T(2026, 10, 5)]],
    [fo.resolvePeriod('month', '2026-09-15', NOW), [T(2026, 9, 1), T(2026, 9, 30, 23, 59, 59)], [T(2026, 8, 31, 23, 59, 59), T(2026, 10, 1)]],
  ]) {
    const r = run([...inside.map(at), ...outside.map(at)], [], [], p);
    assert.equal(r.sections.rfs.completed_visits, inside.length, `${p.kind} ${p.label}`);
  }
});

test('activation rule: paired in the period, not blocked, not provisioning (runtime-summary rule)', () => {
  const dev = (id, created_at, blocked = 0, status = 'online') => ({ id, name: `D ${id}`, created_at, blocked, status });
  const devices = [
    dev('in', T(2026, 9, 30, 8)),
    dev('at-start', WEEK.startEpoch),
    dev('blocked', T(2026, 9, 30), 1),
    dev('blocked-bool', T(2026, 9, 30), true),
    dev('provisioning', T(2026, 9, 30), 0, NOT_A_SCREEN_STATUS),
    dev('offline', T(2026, 10, 2), 0, 'offline'),
    dev('before', WEEK.startEpoch - 1),
    dev('at-end', WEEK.endEpoch),
  ];
  const r = run([], [], devices);
  assert.deepEqual(r.sections.installation.activated_screens.map((a) => a.device_id), ['at-start', 'in', 'offline']);
  assert.equal(r.totals.activations, 3);

  // Same eligibility as Ref 66: of the screens runtime-summary treats as registered
  // during the period (is_new, i.e. strictly after the start), the activated set is
  // identical. (Ref 66 loads only non-provisioning screens, so we drop those first,
  // exactly as its loader's NOT_A_SCREEN_STATUS filter does.)
  const rt = summarizeRuntime({
    startEpoch: WEEK.startEpoch,
    endEpoch: WEEK.endEpoch,
    screens: devices.filter((d) => d.status !== NOT_A_SCREEN_STATUS).map((d) => ({ id: d.id, name: d.name, workspace_id: 'w', registered_at: d.created_at, blocked: d.blocked })),
  });
  const rtNew = rt.screens.filter((s) => s.is_new).map((s) => s.id).sort();
  const ours = r.sections.installation.activated_screens.map((a) => a.device_id).filter((id) => id !== 'at-start').sort();
  assert.deepEqual(ours, rtNew);
});

test('OEM: hardware tickets opened / resolved in period, open now, average age of open ones', () => {
  const tk = (id, created_at, resolved_at = null, owner_category = 'hardware', status = resolved_at ? 'resolved' : 'open') => ({
    id, device_id: 'd1', device_name: 'Screen 1', title: `T ${id}`, description: 'desc', owner_category, status, priority: 'medium', created_at, resolved_at,
  });
  const r = run([], [
    tk('opened-open', T(2026, 9, 29)), // opened in period, still open
    tk('opened-resolved', T(2026, 9, 30), T(2026, 10, 2)), // opened + resolved in period
    tk('old-resolved', T(2026, 9, 1), T(2026, 10, 3), 'hardware', 'closed'), // resolved in period only
    tk('old-open', T(2026, 9, 7)), // open now, opened before
    tk('old-done', T(2026, 9, 1), T(2026, 9, 2)), // irrelevant: not in the list
    tk('platform', T(2026, 9, 29), null, 'platform'), // not hardware
  ]);
  const o = r.sections.oem;
  assert.equal(o.opened_in_period, 2);
  assert.equal(o.resolved_in_period, 2);
  assert.equal(o.open_now, 2);
  // ages at NOW (2026-10-07 10:00): opened-open 8.4166 d, old-open 30.4166 d -> mean 19.4166
  assert.equal(o.avg_open_age_days, 19.4);
  assert.deepEqual(o.cases.map((c) => c.id), ['old-resolved', 'old-open', 'opened-open', 'opened-resolved']);
  const byId = Object.fromEntries(o.cases.map((c) => [c.id, c]));
  assert.equal(byId['opened-open'].open_age_days, 8.4);
  assert.equal(byId['opened-resolved'].open_age_days, null);
  assert.deepEqual([byId['old-resolved'].opened_in_period, byId['old-resolved'].resolved_in_period, byId['old-resolved'].open_now], [false, true, false]);
  assert.deepEqual([r.totals.oem_opened, r.totals.oem_resolved, r.totals.oem_open_now, r.totals.oem_avg_open_age_days], [2, 2, 2, 19.4]);
  assert.equal(run([]).sections.oem.avg_open_age_days, null, 'no open cases -> null average');
});

test('deleted technician shows "Deleted user"; by-technician and by-screen breakdowns', () => {
  const r = run([
    visit({ technician_user_id: 'u1', technician_name: 'Tech One', device_id: 'd1', device_name: 'S1', device_status: 'faulty', completed_at: T(2026, 9, 29) }),
    visit({ technician_user_id: 'u1', technician_name: 'Tech One', device_id: 'd1', device_name: 'S1', device_status: 'working', completed_at: T(2026, 10, 1) }),
    visit({ technician_user_id: null, technician_name: null, device_id: 'd2', device_name: 'S2' }), // SET NULL on delete
    visit({ technician_user_id: 'gone', technician_name: null, device_id: 'd2', device_name: 'S2' }), // dangling id
  ]);
  const rfs = r.sections.rfs;
  assert.deepEqual(rfs.visits.filter((v) => v.technician_user_id !== 'u1').map((v) => v.technician_name), [fo.DELETED_USER, fo.DELETED_USER]);
  assert.equal(fo.DELETED_USER, 'Deleted user');
  assert.deepEqual(rfs.by_technician.find((t) => t.technician_user_id === 'u1'), { technician_user_id: 'u1', technician_name: 'Tech One', visits: 2 });
  assert.equal(rfs.by_technician.filter((t) => t.technician_name === 'Deleted user').reduce((a, b) => a + b.visits, 0), 2);
  const s1 = rfs.by_screen.find((s) => s.device_id === 'd1');
  assert.deepEqual([s1.visits, s1.last_device_status], [2, 'working'], 'device status at the latest completion');
  assert.equal(rfs.visits[0].remarks, 'ok', 'lists carry remarks');
});

test('changing the config mapping changes the sections (the mapping is centralised)', () => {
  const visits = [visit({ visit_type: 'Routine check' }), visit({ visit_type: 'Inspection' })];
  const tickets = [{ id: 't1', owner_category: 'oem_vendor', status: 'open', created_at: T(2026, 9, 29), resolved_at: null, title: 't' }];
  const base = run(visits, tickets);
  assert.deepEqual([base.sections.rfs.completed_visits, base.sections.other.completed_visits, base.sections.oem.open_now], [1, 1, 0]);

  const config = {
    ...fo.FIELD_OPS_CONFIG,
    VISIT_TYPE_SECTIONS: { Inspection: 'rfs', 'Routine check': 'rm' },
    OEM_TICKET_OWNER_CATEGORY: 'oem_vendor',
    PMI_CONFIRMATION_PENDING: { oem: 'x' },
  };
  const r = run(visits, tickets, [], WEEK, { config });
  assert.equal(r.sections.rfs.visits[0].visit_type, 'Inspection');
  assert.equal(r.sections.rm.visits[0].visit_type, 'Routine check');
  assert.equal(r.sections.other.completed_visits, 0);
  assert.equal(r.sections.oem.open_now, 1);
  assert.equal(r.sections.rfs.pmi_confirmation_pending, false);
  assert.deepEqual(r.definitions.visit_type_sections, config.VISIT_TYPE_SECTIONS);
  assert.deepEqual(r.definitions.pmi_confirmation_pending.map((p) => p.section), ['oem']);
});

test('no file that consumes the report hard-codes the mapping, OEM category or section labels', () => {
  // The consumers: the route, the portal modal and the reports view. Each must take
  // these values from lib/field-ops-summary (server) or the API's definitions (UI).
  const root = path.join(__dirname, '..', '..');
  const consumers = ['server/routes/reports.js', 'frontend/js/components/field-ops-report-modal.js', 'frontend/js/views/reports.js'];
  const c = fo.FIELD_OPS_CONFIG;
  const literals = [
    ...Object.keys(c.VISIT_TYPE_SECTIONS),
    c.OEM_TICKET_OWNER_CATEGORY,
    ...Object.values(c.SECTION_LABELS),
    ...Object.values(c.METRIC_LABELS),
    'RFS', 'R&M', 'OEM',
  ];
  const offenders = [];
  for (const rel of consumers) {
    const src = fs.readFileSync(path.join(root, rel), 'utf8');
    for (const lit of literals) {
      const quoted = new RegExp(`(['"\`])${lit.replace(/[.*+?^${}()|[\]\\&/]/g, '\\$&')}\\1`);
      if (quoted.test(src)) offenders.push(`${rel}: ${lit}`);
    }
  }
  assert.deepEqual(offenders, [], 'hard-coded field-ops definitions outside lib/field-ops-summary.js');
});

test('export tables: PDF caps every list at 200 rows with an "N more in the XLSX" heading and truncates remarks', () => {
  const many = Array.from({ length: 237 }, (_, i) => visit({ id: `m${i}`, completed_at: T(2026, 9, 29) + i, remarks: 'r'.repeat(500) }));
  const report = { workspace: { id: 'w', name: 'WS' }, ...run(many) };
  const xlsx = fo.exportTables(report);
  assert.equal(xlsx.find((t) => t.key === 'rfs').rows.length, 237);
  assert.equal(xlsx.find((t) => t.key === 'rfs').rows[0][5].length, 500, 'XLSX keeps full remarks');
  const pdf = fo.pdfTables(report);
  const rfs = pdf.find((t) => t.key === 'rfs');
  assert.equal(rfs.rows.length, fo.PDF_ROW_CAP);
  assert.match(rfs.heading, /37 more in the XLSX/);
  assert.ok(rfs.rows[0][5].length <= 120 && rfs.rows[0][5].endsWith('…'));
  assert.ok(!pdf.find((t) => t.key === 'rm').heading.includes('more in the XLSX'));
  const csv = fo.csvTable(report);
  assert.deepEqual(csv.headers.slice(0, 2), ['Section', 'Row']);
  assert.equal(csv.rows.filter((r) => r[0] === fo.FIELD_OPS_CONFIG.SECTION_LABELS.rfs && r[1] === 'data').length, 237);
  assert.equal(new Set(xlsx.map((t) => t.sheet)).size, xlsx.length, 'distinct sheet names');
  // "open now" is labelled as the current backlog, from the config, in every table
  const openNow = fo.FIELD_OPS_CONFIG.METRIC_LABELS.oem_open_now;
  assert.equal(openNow, 'Open now (as of today)');
  assert.deepEqual(report.definitions.metric_labels, { oem_open_now: openNow });
  assert.ok(xlsx.find((t) => t.key === 'summary').rows.some((r) => r[0].endsWith(`: ${openNow}`)));
  assert.ok(xlsx.find((t) => t.key === 'oem').headers.includes(openNow));
  assert.ok(!JSON.stringify(xlsx).match(/[:"]\s*[Oo]pen now"/), 'no bare "open now" label left');
  assert.ok(xlsx.every((t) => t.sheet.length <= 31));
});

test('summarise rejects a missing or empty period', () => {
  assert.throws(() => fo.summarise([], [], [], null));
  assert.throws(() => fo.summarise([], [], [], { startEpoch: 10, endEpoch: 10 }));
});
