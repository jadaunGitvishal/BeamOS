'use strict';

// PMI Ref 71 (Part 1): GET /api/dashboard/runtime end to end over real HTTP against the
// REAL local MySQL (helpers/inprocess-app.js). Disposable, randomly tagged fixtures, all
// deleted in after() (usage rows and devices explicitly, then users; their orgs and
// workspaces cascade).
//
// Fixed clock: Thursday 2026-09-10 10:00 UTC (Date only is mocked), so
//   24h -> 2026-09-09 (the Ref 66 daily report's day), 7d -> 09-03..09-09,
//   30d -> 08-11..09-09. Today (09-10) has usage rows that must never count.
//
// Org A (ownerA): wsA in region RA (the dashboard's workspace), wsA2 in region RX
//   (same org, must never leak into wsA), plus ownerA's own empty default workspace.
// Org B (ownerB): wsB (must never leak), plus ownerB's own empty default workspace.

const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { initDb } = require('../db/database');
const { generateToken, hashToken, displayPrefix } = require('../middleware/apiToken');
const { startInProcessApp } = require('./helpers/inprocess-app');
const { randTag, cleanupUsers, cleanupRows } = require('./helpers/disposable');
const rs = require('../lib/runtime-summary');
const rr = require('../services/regional-report');

const TAG = randTag();
const PASSWORD = 'ref71-runtime-pass-1';
const FOREIGN = `FOREIGN-${TAG}`;
const NOW = Date.UTC(2026, 8, 10, 10); // Thu 2026-09-10 10:00 UTC
const T = (y, m, d, h = 0) => Date.UTC(y, m - 1, d, h) / 1000;
const LONG_AGO = T(2026, 6, 1);
const DAY = 86400;

let app;
const cleanup = [];
let ownerA, ownerB, member, orgAdmin, tech, rvIn, rvOut, noAccess, apiToken;
const W = {};
const R = {};
const D = {};
const ZERO_KEYS = 'abcdefghijkl'.split(''); // 12 old zero-runtime screens in wsA

async function j(method, url, { token, ws, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (ws) headers['X-Workspace-Id'] = ws;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${app.base}${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, text, json };
}

async function registerUser(prefix, createOrg = false) {
  const email = `${prefix}-${randTag()}@ref71rt.local`;
  const r = await j('POST', '/api/auth/register', { body: { email, password: PASSWORD, name: `${prefix} ${TAG}`, createOrg } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  cleanup.push(r.json.user.id);
  const ws = r.json.current_workspace_id
    ? await app.db.prepare('SELECT organization_id FROM workspaces WHERE id = ?').get(r.json.current_workspace_id)
    : null;
  return { id: r.json.user.id, email, token: r.json.token, workspaceId: r.json.current_workspace_id, orgId: ws?.organization_id };
}

const addOrgMember = (orgId, userId, role) =>
  app.db.prepare('INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, ?)').run(orgId, userId, role);

async function addWorkspace(key, orgId, regionId = null) {
  W[key] = crypto.randomUUID();
  await app.db.prepare('INSERT INTO workspaces (id, organization_id, name, region_id) VALUES (?, ?, ?, ?)')
    .run(W[key], orgId, `ref71-ws-${key}-${TAG}`, regionId);
}

async function addDevice(key, wsKey, createdAt, { blocked = 0, status = 'online', name } = {}) {
  D[key] = crypto.randomUUID();
  await app.db.prepare('INSERT INTO devices (id, user_id, workspace_id, name, status, blocked, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(D[key], ownerA.id, W[wsKey], name || `ref71-${key}-${TAG}`, status, blocked, createdAt);
}

const addUsage = (key, day, seconds) =>
  app.db.prepare('INSERT INTO device_usage_daily (device_id, day, online_seconds) VALUES (?, ?, ?)').run(D[key], day, seconds);

const Q = (period) => `/api/dashboard/runtime${period === undefined ? '' : `?period=${encodeURIComponent(period)}`}`;

// What the endpoint must return, computed straight from lib/runtime-summary.js for
// wsA and the given complete-day range.
async function expected(range) {
  const s = await rs.getRuntimeSummary(app.db, {
    organizationId: ownerA.orgId,
    workspaceIds: [W.A],
    startEpoch: range.startEpoch,
    endEpoch: range.endEpoch,
  });
  return { s, o: s.overall, hours: rs.avgRuntimeHoursPerDay(s.overall) };
}

before(async () => {
  mock.timers.enable({ apis: ['Date'], now: NOW });
  await initDb();
  app = await startInProcessApp({ only: ['/api/dashboard/runtime', '/api/dashboard/overview', '/api/organizations'] });

  ownerA = await registerUser('ref71aown', true);
  ownerB = await registerUser('ref71bown', true);
  member = await registerUser('ref71member');
  orgAdmin = await registerUser('ref71orgadm');
  tech = await registerUser('ref71tech');
  rvIn = await registerUser('ref71rvin');
  rvOut = await registerUser('ref71rvout');
  noAccess = await registerUser('ref71none');

  for (const key of ['RA', 'RX']) {
    const r = await j('POST', `/api/organizations/${ownerA.orgId}/regions`, { token: ownerA.token, body: { name: `${key}-${TAG}`, level: 'territory' } });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    R[key] = r.json.id;
  }
  await addWorkspace('A', ownerA.orgId, R.RA);
  await addWorkspace('A2', ownerA.orgId, R.RX);
  await addWorkspace('B', ownerB.orgId);

  await app.db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_viewer')").run(W.A, member.id);
  await addOrgMember(ownerA.orgId, orgAdmin.id, 'org_admin');
  await addOrgMember(ownerA.orgId, tech.id, 'field_technician');
  await addOrgMember(ownerA.orgId, rvIn.id, 'regional_viewer');
  await addOrgMember(ownerA.orgId, rvOut.id, 'regional_viewer');
  for (const [u, region] of [[rvIn, R.RA], [rvOut, R.RX]]) {
    const r = await j('PUT', `/api/organizations/${ownerA.orgId}/members/${u.id}/region-scopes`, { token: ownerA.token, body: { region_ids: [region] } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
  }

  // wsA. Zero-runtime screens are inserted in REVERSE name order (the list must sort).
  for (const k of [...ZERO_KEYS].reverse()) await addDevice(`zero-${k}`, 'A', LONG_AGO);
  await addDevice('edge', 'A', T(2026, 9, 9)); // registered exactly at the 24h period start: eligible
  await addDevice('runA', 'A', LONG_AGO);
  await addDevice('runB', 'A', LONG_AGO);
  await addDevice('new', 'A', T(2026, 9, 9, 12)); // registered mid-yesterday: "new" for 24h
  await addDevice('later', 'A', T(2026, 9, 10)); // registered at the 24h period end: not loaded
  await addDevice('blocked', 'A', LONG_AGO, { blocked: 1 });
  await addDevice('prov', 'A', LONG_AGO, { status: 'provisioning' });
  await addUsage('runA', '2026-09-09', DAY);
  await addUsage('runA', '2026-09-08', 3600); // in 7d/30d only
  await addUsage('runA', '2026-08-11', 7200); // first day of 30d
  await addUsage('runA', '2026-08-10', 9999); // the day before 30d: never counted
  await addUsage('runB', '2026-09-09', DAY / 2);
  await addUsage('runB', '2026-09-10', DAY); // TODAY: must never be counted
  await addUsage('edge', '2026-09-10', 5000); // TODAY: edge stays zero-runtime yesterday
  await addUsage('blocked', '2026-09-09', DAY);
  await addUsage('later', '2026-09-10', 4000);

  // Foreign: same org, another workspace; and another org. Names sort FIRST, so a
  // leak would show up at the top of the zero-runtime list.
  await addDevice('foreignA2', 'A2', LONG_AGO, { name: `aaa-${FOREIGN}-A2` });
  await addDevice('foreignA2run', 'A2', LONG_AGO, { name: `aab-${FOREIGN}-A2run` });
  await addUsage('foreignA2run', '2026-09-09', DAY);
  await addDevice('foreignB', 'B', LONG_AGO, { name: `aaa-${FOREIGN}-B` });

  const raw = generateToken();
  await app.db
    .prepare("INSERT INTO api_tokens (id, token_hash, prefix, name, user_id, workspace_id, scope) VALUES (?, ?, ?, ?, ?, ?, 'read')")
    .run(`tok-${randTag()}`, hashToken(raw), displayPrefix(raw), 'ref71-test', ownerA.id, W.A);
  apiToken = raw;
});

after(async () => {
  const ids = Object.values(D);
  for (const id of ids) await app.db.prepare('DELETE FROM device_usage_daily WHERE device_id = ?').run(id);
  await cleanupRows(app.db, 'devices', ids);
  const owners = [ownerA.id, ownerB.id];
  await cleanupUsers(app.db, [...cleanup.filter((id) => !owners.includes(id)).reverse(), ...owners]);
  await app.stop();
  mock.timers.reset();
});

test('period mapping: complete UTC days ending at today\'s midnight, never today', async () => {
  const now = new Date(NOW);
  const cases = [
    ['1', 1, '2026-09-09', '2026-09-09', 'last complete day (UTC)'],
    ['24h', 1, '2026-09-09', '2026-09-09', 'last complete day (UTC)'],
    ['7', 7, '2026-09-03', '2026-09-09', 'last 7 complete days (UTC)'],
    ['7d', 7, '2026-09-03', '2026-09-09', 'last 7 complete days (UTC)'],
    ['30', 30, '2026-08-11', '2026-09-09', 'last 30 complete days (UTC)'],
    ['30d', 30, '2026-08-11', '2026-09-09', 'last 30 complete days (UTC)'],
  ];
  for (const [p, days, first, last, label] of cases) {
    const r = rs.completeUtcDays(p, now);
    assert.equal(r.days, days, p);
    assert.equal(r.defaulted, false, p);
    assert.equal(r.first_day, first, p);
    assert.equal(r.last_day, last, p);
    assert.equal(r.label, label, p);
    assert.equal(r.endEpoch, T(2026, 9, 10), `${p}: ends at today's UTC midnight (today excluded)`);
    assert.equal(r.startEpoch, T(2026, 9, 10) - days * DAY, p);

    const h = await j('GET', Q(p), { token: ownerA.token, ws: W.A });
    assert.equal(h.status, 200, p);
    assert.deepEqual(h.json.period, {
      days, defaulted: false, first_day: first, last_day: last,
      start: new Date(r.startEpoch * 1000).toISOString(), end: '2026-09-10T00:00:00.000Z', label,
    }, p);
  }

  // midnight boundaries: one second before / at / after 00:00 UTC
  const at = (iso) => rs.completeUtcDays('24h', new Date(iso));
  assert.equal(at('2026-09-09T23:59:59.999Z').first_day, '2026-09-08');
  assert.equal(at('2026-09-10T00:00:00.000Z').first_day, '2026-09-09');
  assert.equal(at('2026-09-10T00:00:00.000Z').last_day, '2026-09-09');
  assert.equal(at('2026-09-10T23:59:59.999Z').first_day, '2026-09-09');
  // across a month end
  assert.equal(rs.completeUtcDays('7d', new Date('2026-10-02T03:00:00Z')).first_day, '2026-09-25');

  // unknown / missing -> 30 complete days, the other dashboard routes' default window; never a 400
  for (const p of [undefined, '', 'bogus', '14', '0', '-7', '365']) {
    const r = rs.completeUtcDays(p, now);
    assert.equal(r.days, 30, String(p));
    assert.equal(r.defaulted, true, String(p));
    const h = await j('GET', Q(p), { token: ownerA.token, ws: W.A });
    assert.equal(h.status, 200, String(p));
    assert.equal(h.json.period.days, 30, String(p));
    assert.equal(h.json.period.defaulted, true, String(p));
    assert.equal(h.json.period.last_day, '2026-09-09', String(p));
  }
});

test('figures (24h): today is never counted; hand-checked numbers', async () => {
  const r = await j('GET', Q('24h'), { token: ownerA.token, ws: W.A });
  assert.equal(r.status, 200);
  const b = r.json;
  // eligible = 12 zero + edge + runA + runB = 15 (new, later, blocked, prov excluded)
  assert.equal(b.zero_runtime_eligible, 15);
  assert.equal(b.zero_runtime_count, 13); // 12 + edge (its usage is today's)
  assert.equal(b.zero_runtime_pct, 86.7);
  assert.equal(b.screens, 16); // + new
  assert.equal(b.new_screens, 1);
  // runtime = runA 86400 + runB 43200 (not runB's 86400 today);
  // available = 15 x 86400 + new's 43200 = 1,339,200
  assert.equal(b.avg_uptime_pct, 9.7);
  assert.equal(b.avg_runtime_hours, rs.round1((129600 / 1339200) * 24)); // 2.3
  assert.equal(b.avg_runtime_hours, 2.3);
});

test('parity: endpoint == lib/runtime-summary for 24h, 7d and 30d', async () => {
  for (const p of ['24h', '7d', '30d']) {
    const range = rs.completeUtcDays(p, new Date(NOW));
    const { s, o, hours } = await expected(range);
    const b = (await j('GET', Q(p), { token: ownerA.token, ws: W.A })).json;
    assert.equal(b.avg_runtime_hours, hours, p);
    assert.equal(b.avg_uptime_pct, o.avg_uptime_pct, p);
    assert.equal(b.zero_runtime_count, o.zero_runtime_count, p);
    assert.equal(b.zero_runtime_eligible, o.zero_runtime_eligible, p);
    assert.equal(b.zero_runtime_pct, o.zero_runtime_pct, p);
    assert.equal(b.screens, o.screens, p);
    const zeroIds = new Set(s.screens.filter((x) => x.zero_runtime).map((x) => x.id));
    for (const z of b.zero_runtime_screens) assert.ok(zeroIds.has(z.id), `${p}: ${z.name} is zero-runtime per runtime-summary`);
  }
});

test('parity: endpoint (24h) == the Ref 66 daily regional report for the same workspace and day', async () => {
  const period = rr.targetPeriod('daily', new Date(NOW));
  const range = rs.completeUtcDays('24h', new Date(NOW));
  assert.equal(period.startEpoch, range.startEpoch);
  assert.equal(period.endEpoch, range.endEpoch);

  const sent = [];
  const mail = { isConfigured: () => true, sendEmail: async (m) => { sent.push(m); return { sent: true }; } };
  const out = await rr.sendRegionalReport(app.db, mail, { cadence: 'daily', period, userId: rvIn.id, organizationId: ownerA.orgId });
  assert.equal(out, 'sent');
  assert.equal(sent.length, 1);
  const text = sent[0].text;

  const b = (await j('GET', Q('24h'), { token: rvIn.token, ws: W.A })).json;
  assert.match(text, new RegExp(`Average uptime: ${String(b.avg_uptime_pct).replace('.', '\\.')}%`));
  assert.ok(text.includes(`Zero-runtime screens: ${b.zero_runtime_count} of ${b.zero_runtime_eligible} (${b.zero_runtime_pct}%)`), text);
  assert.ok(text.includes(`Screens: ${b.screens} (${b.new_screens} new in this period)`), text);
  assert.ok(!text.includes(FOREIGN), 'the report covers wsA only too');
  // the report's own summary, reworked to hours, matches the endpoint
  const { hours } = await expected(range);
  assert.equal(b.avg_runtime_hours, hours);
});

test('eligibility: blocked / provisioning / not-yet-registered never listed; mid-range registration not zero-runtime', async () => {
  const b = (await j('GET', Q('24h'), { token: ownerA.token, ws: W.A })).json;
  const ids = new Set(b.zero_runtime_screens.map((s) => s.id));
  for (const k of ['blocked', 'prov', 'new', 'later', 'runA', 'runB']) assert.ok(!ids.has(D[k]), `${k} not in the zero list`);
  // over 7d "new" (registered 09-09 12:00) and "edge" (09-09 00:00) are both new -> out of M
  const w = (await j('GET', Q('7d'), { token: ownerA.token, ws: W.A })).json;
  assert.equal(w.zero_runtime_eligible, 14); // 12 zero + runA + runB
  assert.equal(w.zero_runtime_count, 12);
  assert.equal(w.new_screens, 2);
  assert.ok(!w.zero_runtime_screens.some((s) => s.id === D.edge || s.id === D.new));
});

test('top-10 zero-runtime list: capped at 10, sorted by name', async () => {
  const b = (await j('GET', Q('24h'), { token: ownerA.token, ws: W.A })).json;
  assert.equal(b.zero_runtime_list_limit, 10);
  assert.equal(b.zero_runtime_count, 13);
  assert.equal(b.zero_runtime_screens.length, 10);
  const all = ['edge', ...ZERO_KEYS.map((k) => `zero-${k}`)].map((k) => ({ id: D[k], name: `ref71-${k}-${TAG}` }));
  all.sort((x, y) => x.name.localeCompare(y.name));
  assert.deepEqual(b.zero_runtime_screens, all.slice(0, 10));
  assert.deepEqual(Object.keys(b.zero_runtime_screens[0]).sort(), ['id', 'name']);
});

test('isolation: no other-workspace or other-org screen, for any period or caller', async () => {
  for (const u of [ownerA, orgAdmin, rvIn, member]) {
    for (const p of ['24h', '7d', '30d']) {
      const r = await j('GET', Q(p), { token: u.token, ws: W.A });
      assert.equal(r.status, 200);
      assert.equal(r.json.workspace_id, W.A);
      assert.ok(!r.text.includes(FOREIGN), `${u.email} ${p}: no foreign screen`);
      for (const k of ['foreignA2', 'foreignA2run', 'foreignB']) assert.ok(!r.text.includes(D[k]), `${k} absent`);
    }
  }
  // the 24h figures are wsA's alone (a leak of wsA2 would add 2 eligible screens)
  const b = (await j('GET', Q('24h'), { token: ownerA.token, ws: W.A })).json;
  assert.equal(b.zero_runtime_eligible, 15);
  assert.equal(b.zero_runtime_count, 13);
});

test('access: the same allow/deny as GET /api/dashboard/overview', async () => {
  const callers = [
    ['owner', ownerA], ['direct member', member], ['org admin', orgAdmin], ['in-scope regional viewer', rvIn],
    ['field technician', tech], ['out-of-scope regional viewer', rvOut], ["another org's owner", ownerB], ['no access', noAccess],
  ];
  const statuses = {};
  for (const [label, u] of callers) {
    for (const ws of [W.A, undefined]) {
      const ov = await j('GET', '/api/dashboard/overview', { token: u.token, ws });
      const rt = await j('GET', Q('7d'), { token: u.token, ws });
      assert.equal(rt.status, ov.status, `${label} ws=${ws ? 'A' : 'none'}: runtime ${rt.status} vs overview ${ov.status}`);
      if (ws) statuses[label] = rt.status;
      const wsAIds = ['edge', ...ZERO_KEYS.map((k) => `zero-${k}`)].map((k) => D[k]);
      if (rt.status === 200) {
        // with no header a caller lands in their own workspace (e.g. the out-of-scope
        // regional viewer in wsA2); only callers resolved to wsA may see wsA's screens
        if (rt.json.workspace_id !== W.A) {
          for (const id of wsAIds) assert.ok(!rt.text.includes(id), `${label}: no wsA screen outside wsA`);
        }
      } else {
        assert.ok(!rt.text.includes(TAG), `${label}: nothing in the refusal`);
      }
    }
  }
  // field technician: 200, as on /overview - lib/tenancy accessContext (Ref 43) gives a
  // field_technician read-only 'workspace_viewer' reach into every workspace of their org
  assert.deepEqual(statuses, {
    owner: 200, 'direct member': 200, 'org admin': 200, 'in-scope regional viewer': 200,
    'field technician': 200, 'out-of-scope regional viewer': 403, "another org's owner": 403, 'no access': 403,
  });

  // API tokens: both are JWT-only, so a token gets 401 from requireAuth
  const tokOv = await j('GET', '/api/dashboard/overview', { token: apiToken });
  const tokRt = await j('GET', Q('7d'), { token: apiToken });
  assert.equal(tokRt.status, tokOv.status);
  assert.equal(tokRt.status, 401);
  // no auth at all
  assert.equal((await j('GET', Q('7d'))).status, 401);
});

test('empty workspace / no workspace -> 200 with n/a (null) figures', async () => {
  for (const [label, u, ws] of [['ownerA default ws', ownerA, ownerA.workspaceId], ['ownerB default ws', ownerB, ownerB.workspaceId], ['no workspace', noAccess, undefined]]) {
    const r = await j('GET', Q('7d'), { token: u.token, ws });
    assert.equal(r.status, 200, label);
    const b = r.json;
    assert.equal(b.avg_runtime_hours, null, label);
    assert.equal(b.avg_uptime_pct, null, label);
    assert.equal(b.zero_runtime_pct, null, label);
    assert.equal(b.zero_runtime_count, 0, label);
    assert.equal(b.zero_runtime_eligible, 0, label);
    assert.equal(b.screens, 0, label);
    assert.deepEqual(b.zero_runtime_screens, [], label);
    assert.equal(b.period.last_day, '2026-09-09', label);
  }
});

test('avgRuntimeHoursPerDay: unrounded ratio x 24, capped, null without a denominator', () => {
  assert.equal(rs.avgRuntimeHoursPerDay(null), null);
  assert.equal(rs.avgRuntimeHoursPerDay({ runtime_seconds: 0, available_seconds: 0 }), null);
  assert.equal(rs.avgRuntimeHoursPerDay({ runtime_seconds: 0, available_seconds: DAY }), 0);
  assert.equal(rs.avgRuntimeHoursPerDay({ runtime_seconds: DAY, available_seconds: DAY }), 24);
  assert.equal(rs.avgRuntimeHoursPerDay({ runtime_seconds: 2 * DAY, available_seconds: DAY }), 24);
  assert.equal(rs.avgRuntimeHoursPerDay({ runtime_seconds: DAY / 4, available_seconds: DAY }), 6);
});
