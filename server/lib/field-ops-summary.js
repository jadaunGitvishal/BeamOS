'use strict';

// PMI Ref 68 (shared with Ref 71): the Field Operations report for ONE workspace over
// ONE UTC period - installations / activations, RFS visits, R&M visits, other visits,
// visits still in progress, and OEM / hardware cases.
//
//   FIELD_OPS_CONFIG          THE definitions (visit-type -> section mapping, the OEM
//                             ticket owner category, section labels, and which of them
//                             are still pending PMI confirmation). Nothing else in the
//                             codebase may hard-code these values: the route, the
//                             exports, the UI (via the API's `definitions`) and Ref 71
//                             all read them from here.
//
//   summarise(visits, tickets, activations, period, opts)
//                             PURE. No DB, no clock (pass opts.nowEpoch). Applies every
//                             rule below to already-loaded rows.
//
//   loadFieldOpsInputs(db, …) Loads exactly the rows summarise needs, every query
//                             constrained by the workspace id AND that workspace's
//                             organization_id. It does NOT decide who may read them:
//                             the caller does (routes/reports.js uses
//                             lib/permissions.canReadFieldVisits, the field-visit read
//                             gate).
//
//   resolvePeriod(kind, date, now)
//                             'day' | 'week' | 'month' + optional 'YYYY-MM-DD' -> the
//                             UTC period containing that date, built on Ref 66's
//                             services/regional-report.targetPeriod so the semantics
//                             (UTC day; ISO week Monday 00:00 -> next Monday 00:00 UTC;
//                             calendar month) are identical. No date = the last
//                             complete period, exactly Ref 66's default.
//
// RULES (change them here and nowhere else):
//   completed visit  status 'completed' with completed_at inside the period. It is
//                    counted in the section its visit_type maps to.
//   in progress      status not 'completed' and created_at before the period end
//                    (created in or before the period, still open NOW). Listed
//                    separately and never counted as completed anywhere.
//   activation       a device first paired (devices.created_at) inside the period that
//                    is not blocked and not still provisioning - the screen rule of
//                    lib/runtime-summary.js (NOT_A_SCREEN_STATUS / isBlockedScreen are
//                    imported from there, not restated). Ref 66 treats a screen paired
//                    at exactly the period start as existing for the whole period (an
//                    uptime-denominator question); here the period is half-open
//                    [start, end) so a midnight pairing is counted in exactly one day.
//   OEM case         a ticket whose owner_category is OEM_TICKET_OWNER_CATEGORY.
//                    opened = created_at in the period; resolved = resolved_at in the
//                    period; open now = resolved_at unset (the ticket PATCH sets it on
//                    every move to resolved/closed and clears it on reopen), as of the
//                    time the report is generated; average age is over open-now cases.
//   technician       users.name (else email). A technician whose user row is gone
//                    (ON DELETE SET NULL, or a dangling id) is "Deleted user".
//
// Never reads field_visits.sim_network_info (no SIM data in this report).

const { NOT_A_SCREEN_STATUS, isBlockedScreen, round1 } = require('./runtime-summary');

const DAY = 86400;

const FIELD_OPS_CONFIG = Object.freeze({
  // ASSUMED, PMI confirmation pending (decision a): which field_visits.visit_type
  // values (exact, after trimming; the field-tech app sends these three) feed which
  // section. Any other visit_type goes to OTHER_SECTION.
  VISIT_TYPE_SECTIONS: Object.freeze({
    Installation: 'installation',
    'Routine check': 'rfs',
    Repair: 'rm',
  }),
  OTHER_SECTION: 'other',
  // ASSUMED, PMI confirmation pending (decision b): an OEM / hardware case is a ticket
  // with this owner_category. There is no separate OEM field.
  OEM_TICKET_OWNER_CATEGORY: 'hardware',
  SECTION_LABELS: Object.freeze({
    installation: 'Installations and activations',
    rfs: 'RFS visits',
    rm: 'R&M visits',
    other: 'Other visits',
    in_progress: 'Visits in progress',
    oem: 'OEM / hardware cases',
  }),
  // Figure labels that must read the same everywhere (UI, PDF, XLSX, CSV). "Open now"
  // is the CURRENT backlog whatever period is selected, so its label says so.
  METRIC_LABELS: Object.freeze({
    oem_open_now: 'Open now (as of today)',
  }),
  // The two assumptions above, by the section whose heading carries the
  // "pending PMI confirmation" note. Remove an entry once PMI confirms it.
  PMI_CONFIRMATION_PENDING: Object.freeze({
    rfs: 'RFS = field visits with visit_type "Routine check" (and R&M = "Repair", Installation = "Installation")',
    oem: 'OEM / hardware case = ticket with owner_category "hardware"',
  }),
});

const VISIT_SECTIONS = ['installation', 'rfs', 'rm', 'other'];
const DELETED_USER = 'Deleted user';
const PERIOD_KINDS = { day: 'daily', week: 'weekly', month: 'monthly' };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function sectionForVisitType(visitType, config = FIELD_OPS_CONFIG) {
  const key = String(visitType ?? '').trim();
  return Object.prototype.hasOwnProperty.call(config.VISIT_TYPE_SECTIONS, key)
    ? config.VISIT_TYPE_SECTIONS[key]
    : config.OTHER_SECTION;
}

// The API's `definitions` object: the config as data, for the UI notes and for anyone
// reading an export without the docs.
function definitions(config = FIELD_OPS_CONFIG) {
  return {
    visit_type_sections: { ...config.VISIT_TYPE_SECTIONS },
    other_section: config.OTHER_SECTION,
    oem_ticket_owner_category: config.OEM_TICKET_OWNER_CATEGORY,
    section_labels: { ...config.SECTION_LABELS },
    metric_labels: { ...config.METRIC_LABELS },
    pmi_confirmation_pending: Object.entries(config.PMI_CONFIRMATION_PENDING).map(([section, assumption]) => ({ section, assumption })),
    rules: {
      completed: 'status completed, completed_at inside the period',
      in_progress: 'not completed, created before the period end; never counted as completed',
      activation: `devices.created_at inside the period, not blocked, status not '${NOT_A_SCREEN_STATUS}'`,
      oem_open_now: 'resolved_at unset, as of generated_at',
      periods: 'UTC; week = ISO week, Monday 00:00 UTC to the next Monday 00:00 UTC',
    },
  };
}

// ---- periods ----------------------------------------------------------------

class PeriodError extends Error {}

function parseDate(s) {
  if (!DATE_RE.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : d;
}

// -> { kind, key, label, fileKey, startEpoch, endEpoch, complete }. Throws PeriodError
// on a bad kind or date, or a date after today (UTC).
function resolvePeriod(kind, date, now = new Date()) {
  const cadence = PERIOD_KINDS[kind];
  if (!cadence) throw new PeriodError('period must be one of: day, week, month');
  // Lazy: Ref 66's module also carries its scheduler; summarise() callers don't need it.
  const { targetPeriod } = require('../services/regional-report');
  let anchor = now;
  if (date !== undefined && date !== null && date !== '') {
    const d = parseDate(String(date));
    if (!d) throw new PeriodError('date must be a real calendar date, YYYY-MM-DD');
    if (String(date) > now.toISOString().slice(0, 10)) throw new PeriodError('date cannot be in the future');
    // targetPeriod returns the last COMPLETE period before `anchor`, so anchor on the
    // first instant after the period that contains d.
    if (kind === 'day') anchor = new Date(d.getTime() + DAY * 1000);
    else if (kind === 'week') anchor = new Date(d.getTime() + 7 * DAY * 1000);
    else anchor = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  }
  const p = targetPeriod(cadence, anchor);
  return { kind, ...p, complete: p.endEpoch * 1000 <= now.getTime() };
}

// ---- pure summary -------------------------------------------------------------

function iso(epoch) {
  return epoch === null || epoch === undefined ? null : new Date(Number(epoch) * 1000).toISOString();
}
const inPeriod = (epoch, p) => epoch !== null && epoch !== undefined && Number(epoch) >= p.startEpoch && Number(epoch) < p.endEpoch;
const technicianName = (v) => (v.technician_name ? v.technician_name : DELETED_USER);

function visitItem(v) {
  return {
    id: v.id,
    device_id: v.device_id,
    device_name: v.device_name ?? null,
    technician_user_id: v.technician_user_id ?? null,
    technician_name: technicianName(v),
    visit_type: v.visit_type,
    device_status: v.device_status ?? null,
    status: v.status,
    remarks: v.remarks ?? null,
    created_at: Number(v.created_at),
    completed_at: v.completed_at === null || v.completed_at === undefined ? null : Number(v.completed_at),
  };
}

function byTechnician(items) {
  const m = new Map();
  for (const v of items) {
    const key = v.technician_name === DELETED_USER ? `deleted:${v.technician_user_id ?? ''}` : v.technician_user_id;
    const row = m.get(key) || { technician_user_id: v.technician_user_id, technician_name: v.technician_name, visits: 0 };
    row.visits++;
    m.set(key, row);
  }
  return [...m.values()].sort((a, b) => b.visits - a.visits || a.technician_name.localeCompare(b.technician_name));
}

// Per screen: visit count and the device_status recorded at the LATEST completion.
function byScreen(items) {
  const m = new Map();
  for (const v of items) {
    const row = m.get(v.device_id) || { device_id: v.device_id, device_name: v.device_name, visits: 0, last_completed_at: null, last_device_status: null };
    row.visits++;
    if (row.last_completed_at === null || v.completed_at > row.last_completed_at) {
      row.last_completed_at = v.completed_at;
      row.last_device_status = v.device_status;
    }
    m.set(v.device_id, row);
  }
  return [...m.values()].sort((a, b) => b.visits - a.visits || String(a.device_name).localeCompare(String(b.device_name)));
}

const byTime = (field) => (a, b) => (a[field] - b[field]) || String(a.id).localeCompare(String(b.id));

// visits:      [{ id, device_id, device_name, technician_user_id, technician_name
//                 (null when the user row is gone), visit_type, device_status, remarks,
//                 status, created_at, completed_at }]
// tickets:     [{ id, device_id, device_name, title, description, owner_category,
//                 status, priority, created_at, resolved_at }]
// activations: [{ id, name, created_at, blocked, status }] (candidate devices; the
//                 activation rule is applied here)
// period:      { startEpoch, endEpoch, ... } (half-open, UTC)
// opts:        { nowEpoch (required for OEM ages), config (defaults FIELD_OPS_CONFIG) }
function summarise(visits = [], tickets = [], activations = [], period, opts = {}) {
  if (!period || !Number.isFinite(period.startEpoch) || !Number.isFinite(period.endEpoch) || period.endEpoch <= period.startEpoch) {
    throw new Error('summarise needs a period with startEpoch < endEpoch');
  }
  const config = opts.config || FIELD_OPS_CONFIG;
  const nowEpoch = Number.isFinite(opts.nowEpoch) ? opts.nowEpoch : Math.floor(Date.now() / 1000);

  const completed = Object.fromEntries(VISIT_SECTIONS.map((s) => [s, []]));
  const inProgress = [];
  for (const v of visits) {
    if (v.status === 'completed') {
      if (!inPeriod(v.completed_at, period)) continue;
      const section = sectionForVisitType(v.visit_type, config);
      (completed[section] || completed[config.OTHER_SECTION] || completed.other).push(visitItem(v));
    } else if (Number(v.created_at) < period.endEpoch) {
      inProgress.push(visitItem(v));
    }
  }
  for (const s of VISIT_SECTIONS) completed[s].sort(byTime('completed_at'));
  inProgress.sort(byTime('created_at'));

  const activated = activations
    .filter((d) => inPeriod(d.created_at, period) && !isBlockedScreen(d) && d.status !== NOT_A_SCREEN_STATUS)
    .map((d) => ({ device_id: d.id, device_name: d.name ?? null, activated_at: Number(d.created_at) }))
    .sort((a, b) => a.activated_at - b.activated_at || String(a.device_id).localeCompare(String(b.device_id)));

  const oemItems = [];
  let opened = 0;
  let resolved = 0;
  let openNow = 0;
  let openAgeSum = 0;
  for (const t of tickets) {
    if (t.owner_category !== config.OEM_TICKET_OWNER_CATEGORY) continue;
    const created = Number(t.created_at);
    const resolvedAt = t.resolved_at === null || t.resolved_at === undefined ? null : Number(t.resolved_at);
    const flags = {
      opened_in_period: inPeriod(created, period),
      resolved_in_period: inPeriod(resolvedAt, period),
      open_now: resolvedAt === null,
    };
    if (!flags.opened_in_period && !flags.resolved_in_period && !flags.open_now) continue;
    const ageDays = flags.open_now ? round1(Math.max(0, nowEpoch - created) / DAY) : null;
    if (flags.opened_in_period) opened++;
    if (flags.resolved_in_period) resolved++;
    if (flags.open_now) {
      openNow++;
      openAgeSum += Math.max(0, nowEpoch - created);
    }
    oemItems.push({
      id: t.id,
      device_id: t.device_id ?? null,
      device_name: t.device_name ?? null,
      title: t.title,
      description: t.description ?? null,
      status: t.status,
      priority: t.priority,
      created_at: created,
      resolved_at: resolvedAt,
      open_age_days: ageDays,
      ...flags,
    });
  }
  oemItems.sort(byTime('created_at'));

  const visitSection = (key, withScreens) => ({
    label: config.SECTION_LABELS[key],
    pmi_confirmation_pending: Object.prototype.hasOwnProperty.call(config.PMI_CONFIRMATION_PENDING, key),
    completed_visits: completed[key].length,
    by_technician: byTechnician(completed[key]),
    ...(withScreens ? { by_screen: byScreen(completed[key]) } : {}),
    visits: completed[key],
  });

  const sections = {
    installation: {
      ...visitSection('installation', false),
      activations: activated.length,
      activated_screens: activated,
    },
    rfs: visitSection('rfs', true),
    rm: visitSection('rm', true),
    other: visitSection('other', false),
    in_progress: {
      label: config.SECTION_LABELS.in_progress,
      pmi_confirmation_pending: false,
      count: inProgress.length,
      visits: inProgress,
    },
    oem: {
      label: config.SECTION_LABELS.oem,
      pmi_confirmation_pending: Object.prototype.hasOwnProperty.call(config.PMI_CONFIRMATION_PENDING, 'oem'),
      opened_in_period: opened,
      resolved_in_period: resolved,
      open_now: openNow,
      avg_open_age_days: openNow ? round1(openAgeSum / openNow / DAY) : null,
      cases: oemItems,
    },
  };

  return {
    period: {
      kind: period.kind ?? null,
      label: period.label ?? null,
      start: iso(period.startEpoch),
      end: iso(period.endEpoch),
      start_epoch: period.startEpoch,
      end_epoch: period.endEpoch,
      complete: period.complete ?? null,
    },
    generated_at: iso(nowEpoch),
    totals: {
      installation_visits: sections.installation.completed_visits,
      activations: sections.installation.activations,
      rfs_visits: sections.rfs.completed_visits,
      rm_visits: sections.rm.completed_visits,
      other_visits: sections.other.completed_visits,
      in_progress_visits: sections.in_progress.count,
      oem_opened: opened,
      oem_resolved: resolved,
      oem_open_now: openNow,
      oem_avg_open_age_days: sections.oem.avg_open_age_days,
    },
    sections,
    definitions: definitions(config),
  };
}

// ---- loader ---------------------------------------------------------------------

// Loads summarise's inputs for ONE workspace. Every query joins workspaces and matches
// both the workspace id and its organization_id, so a stale or foreign id loads
// nothing. Returns { workspace: { id, name, organization_id } | null, visits, tickets,
// activations }.
async function loadFieldOpsInputs(db, { workspaceId, startEpoch, endEpoch, config = FIELD_OPS_CONFIG }) {
  const empty = { workspace: null, visits: [], tickets: [], activations: [] };
  if (!workspaceId) return empty;
  const workspace = await db.prepare('SELECT id, name, organization_id FROM workspaces WHERE id = ?').get(workspaceId);
  if (!workspace) return empty;
  const scope = [workspace.id, workspace.organization_id];

  const visits = await db
    .prepare(
      `SELECT fv.id, fv.device_id, d.name AS device_name, fv.technician_user_id,
              CASE WHEN u.id IS NULL THEN NULL ELSE COALESCE(NULLIF(u.name, ''), u.email) END AS technician_name,
              fv.visit_type, fv.device_status, fv.remarks, fv.status, fv.created_at, fv.completed_at
         FROM field_visits fv
         JOIN workspaces w ON w.id = fv.workspace_id
         LEFT JOIN devices d ON d.id = fv.device_id
         LEFT JOIN users u ON u.id = fv.technician_user_id
        WHERE fv.workspace_id = ? AND w.organization_id = ?
          AND ((fv.status = 'completed' AND fv.completed_at >= ? AND fv.completed_at < ?)
               OR (fv.status <> 'completed' AND fv.created_at < ?))`,
    )
    .all(...scope, startEpoch, endEpoch, endEpoch);

  const tickets = await db
    .prepare(
      `SELECT t.id, t.device_id, d.name AS device_name, t.title, t.description, t.owner_category,
              t.status, t.priority, t.created_at, t.resolved_at
         FROM tickets t
         JOIN workspaces w ON w.id = t.workspace_id
         LEFT JOIN devices d ON d.id = t.device_id
        WHERE t.workspace_id = ? AND w.organization_id = ? AND t.owner_category = ?
          AND ((t.created_at >= ? AND t.created_at < ?)
               OR (t.resolved_at >= ? AND t.resolved_at < ?)
               OR t.resolved_at IS NULL)`,
    )
    .all(...scope, config.OEM_TICKET_OWNER_CATEGORY, startEpoch, endEpoch, startEpoch, endEpoch);

  // Candidates only (paired in the period); summarise applies the blocked /
  // provisioning part of the rule so it lives in one place.
  const activations = await db
    .prepare(
      `SELECT d.id, d.name, d.created_at, d.blocked, d.status
         FROM devices d
         JOIN workspaces w ON w.id = d.workspace_id
        WHERE d.workspace_id = ? AND w.organization_id = ?
          AND d.created_at >= ? AND d.created_at < ?`,
    )
    .all(...scope, startEpoch, endEpoch);

  const num = (x) => (x === null || x === undefined ? null : Number(x));
  return {
    workspace,
    visits: visits.map((v) => ({ ...v, created_at: num(v.created_at), completed_at: num(v.completed_at) })),
    tickets: tickets.map((t) => ({ ...t, created_at: num(t.created_at), resolved_at: num(t.resolved_at) })),
    activations: activations.map((d) => ({ ...d, created_at: num(d.created_at), blocked: Number(d.blocked) })),
  };
}

// ---- export tables --------------------------------------------------------------

const PDF_ROW_CAP = 200;
const PDF_REMARKS_MAX = 120;
const fmt = (epoch) => (epoch === null || epoch === undefined ? '' : new Date(Number(epoch) * 1000).toISOString().slice(0, 16).replace('T', ' '));
const truncate = (s, max) => (s && s.length > max ? s.slice(0, max - 1) + '…' : s ?? '');

const VISIT_HEADERS = ['Completed (UTC)', 'Screen', 'Technician', 'Visit type', 'Device status', 'Remarks', 'Visit ID'];
const visitRow = (v) => [fmt(v.completed_at), v.device_name ?? v.device_id, v.technician_name, v.visit_type, v.device_status ?? '', v.remarks ?? '', v.id];

// The report as tables: [{ key, sheet (XLSX tab name), heading, headers, rows, remarksCol? }]. Summary first,
// then one table per section list, then the breakdowns. Used by every export format.
function exportTables(report) {
  const s = report.sections;
  const L = report.definitions.section_labels;
  const M = report.definitions.metric_labels;
  const t = report.totals;
  const tables = [];
  tables.push({
    key: 'summary',
    sheet: 'Summary',
    heading: 'Summary',
    headers: ['Metric', 'Value'],
    rows: [
      ['Workspace', report.workspace ? report.workspace.name : ''],
      ['Period', report.period.label ?? ''],
      ['Period start (UTC)', fmt(report.period.start_epoch)],
      ['Period end (UTC, exclusive)', fmt(report.period.end_epoch)],
      ['Generated (UTC)', fmt(Date.parse(report.generated_at) / 1000)],
      [`${L.installation}: completed installation visits`, t.installation_visits],
      [`${L.installation}: screens activated`, t.activations],
      [`${L.rfs}: completed`, t.rfs_visits],
      [`${L.rm}: completed`, t.rm_visits],
      [`${L.other}: completed`, t.other_visits],
      [L.in_progress, t.in_progress_visits],
      [`${L.oem}: opened in period`, t.oem_opened],
      [`${L.oem}: resolved in period`, t.oem_resolved],
      [`${L.oem}: ${M.oem_open_now}`, t.oem_open_now],
      [`${L.oem}: average age of open cases (days)`, t.oem_avg_open_age_days ?? ''],
      ...report.definitions.pmi_confirmation_pending.map((p) => [`Definition assumed, pending PMI confirmation (${L[p.section] || p.section})`, p.assumption]),
    ],
  });
  tables.push({ key: 'installation', sheet: 'Installation visits', heading: `${L.installation}: visits`, headers: VISIT_HEADERS, rows: s.installation.visits.map(visitRow), remarksCol: 5 });
  tables.push({
    key: 'activations',
    sheet: 'Activations',
    heading: `${L.installation}: screens activated`,
    headers: ['Activated (UTC)', 'Screen', 'Device ID'],
    rows: s.installation.activated_screens.map((a) => [fmt(a.activated_at), a.device_name ?? '', a.device_id]),
  });
  tables.push({ key: 'rfs', sheet: 'RFS', heading: L.rfs, headers: VISIT_HEADERS, rows: s.rfs.visits.map(visitRow), remarksCol: 5 });
  tables.push({ key: 'rm', sheet: 'R&M', heading: L.rm, headers: VISIT_HEADERS, rows: s.rm.visits.map(visitRow), remarksCol: 5 });
  tables.push({ key: 'other', sheet: 'Other visits', heading: L.other, headers: VISIT_HEADERS, rows: s.other.visits.map(visitRow), remarksCol: 5 });
  tables.push({
    key: 'in_progress',
    sheet: 'In progress',
    heading: L.in_progress,
    headers: ['Started (UTC)', 'Screen', 'Technician', 'Visit type', 'Remarks', 'Visit ID'],
    rows: s.in_progress.visits.map((v) => [fmt(v.created_at), v.device_name ?? v.device_id, v.technician_name, v.visit_type, v.remarks ?? '', v.id]),
    remarksCol: 4,
  });
  tables.push({
    key: 'oem',
    sheet: 'OEM cases',
    heading: L.oem,
    headers: ['Opened (UTC)', 'Resolved (UTC)', 'Screen', 'Title', 'Status', 'Priority', 'Open age (days)', 'Opened in period', 'Resolved in period', M.oem_open_now, 'Description', 'Ticket ID'],
    rows: s.oem.cases.map((c) => [
      fmt(c.created_at), fmt(c.resolved_at), c.device_name ?? '', c.title, c.status, c.priority, c.open_age_days ?? '',
      c.opened_in_period ? 'Yes' : 'No', c.resolved_in_period ? 'Yes' : 'No', c.open_now ? 'Yes' : 'No', c.description ?? '', c.id,
    ]),
    remarksCol: 10,
  });
  tables.push({
    key: 'by_technician',
    sheet: 'By technician',
    heading: 'Completed visits by technician',
    headers: ['Section', 'Technician', 'Completed visits'],
    rows: ['installation', 'rfs', 'rm', 'other'].flatMap((k) => s[k].by_technician.map((r) => [L[k], r.technician_name, r.visits])),
  });
  tables.push({
    key: 'by_screen',
    sheet: 'By screen',
    heading: 'RFS and R&M visits by screen',
    headers: ['Section', 'Screen', 'Completed visits', 'Device status at last completion', 'Last completed (UTC)'],
    rows: ['rfs', 'rm'].flatMap((k) => s[k].by_screen.map((r) => [L[k], r.device_name ?? r.device_id, r.visits, r.last_device_status ?? '', fmt(r.last_completed_at)])),
  });
  return tables;
}

// PDF variant: every list capped at PDF_ROW_CAP rows (the heading then says how many
// more are in the XLSX) and long remarks / descriptions truncated.
function pdfTables(report, cap = PDF_ROW_CAP) {
  return exportTables(report).map((tb) => {
    let rows = tb.rows;
    if (tb.remarksCol !== undefined) rows = rows.map((r) => r.map((c, i) => (i === tb.remarksCol ? truncate(String(c ?? ''), PDF_REMARKS_MAX) : c)));
    if (tb.key === 'summary' || rows.length <= cap) return { ...tb, rows };
    const more = rows.length - cap;
    return { ...tb, heading: `${tb.heading} (first ${cap} of ${rows.length}; ${more} more in the XLSX)`, rows: rows.slice(0, cap) };
  });
}

// One CSV for everything: Section and Row ('columns' = that section's column names,
// 'data' = a row) columns, then each table's own columns in order, padded to the
// widest table. Filter on Section to get one table back.
function csvTable(report) {
  const tables = exportTables(report);
  const width = Math.max(...tables.map((tb) => tb.headers.length));
  const pad = (r) => [...r, ...Array(width - r.length).fill('')];
  const headers = ['Section', 'Row', ...Array.from({ length: width }, (_, i) => `Column ${i + 1}`)];
  const rows = [];
  for (const tb of tables) {
    rows.push([tb.heading, 'columns', ...pad(tb.headers)]);
    for (const r of tb.rows) rows.push([tb.heading, 'data', ...pad(r)]);
  }
  return { headers, rows };
}

// load + summarise; adds `workspace: { id, name }`.
async function getFieldOpsReport(db, { workspaceId, period, nowEpoch, config = FIELD_OPS_CONFIG }) {
  const inputs = await loadFieldOpsInputs(db, { workspaceId, startEpoch: period.startEpoch, endEpoch: period.endEpoch, config });
  const report = summarise(inputs.visits, inputs.tickets, inputs.activations, period, { nowEpoch, config });
  return { workspace: inputs.workspace ? { id: inputs.workspace.id, name: inputs.workspace.name } : null, ...report };
}

module.exports = {
  FIELD_OPS_CONFIG,
  DELETED_USER,
  PeriodError,
  sectionForVisitType,
  definitions,
  resolvePeriod,
  summarise,
  loadFieldOpsInputs,
  getFieldOpsReport,
  exportTables,
  pdfTables,
  csvTable,
  PDF_ROW_CAP,
};
