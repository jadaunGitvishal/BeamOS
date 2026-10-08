'use strict';

// PMI Ref 68: GET /api/reports/field-operations end to end over real HTTP against the
// REAL local MySQL (helpers/inprocess-app.js). Disposable, randomly tagged fixtures,
// all deleted in after() (users last; their orgs, workspaces, devices, visits and
// tickets cascade).
//
// Org A (owner ownerA): wsA (region RA, the report's workspace), wsA2 (same org, no
//   region: must never leak into wsA's report), wsCap (205 Repair visits, PDF cap).
// Org B (owner ownerB): wsB (must never leak either).
// Period under test: ISO week 2026-W40 (Mon 2026-09-28 .. Mon 2026-10-05 UTC).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');

const { initDb } = require('../db/database');
const { generateToken, hashToken, displayPrefix } = require('../middleware/apiToken');
const { startInProcessApp } = require('./helpers/inprocess-app');
const { randTag, cleanupUsers, cleanupUser } = require('./helpers/disposable');
const { extractCells } = require('../scripts/pdf-text-dump');
const { FIELD_OPS_CONFIG } = require('../lib/field-ops-summary');

const TAG = randTag();
const PASSWORD = 'ref68-fieldops-pass-1';
const SIM = `SIMSECRET-${TAG}`; // written to every visit's sim_network_info; must never be output
const FOREIGN = `FOREIGN-${TAG}`; // in every name/remark of another workspace's rows
const T = (y, m, d, h = 0) => Date.UTC(y, m - 1, d, h) / 1000;
const Q = '/api/reports/field-operations?period=week&date=2026-09-30';
const BASE_NAME = 'field-operations-week-2026-W40';

let app;
const cleanup = [];
let ownerA, ownerB, member, orgAdmin, tech, rvIn, rvOut, noAccess, deletedTech, apiToken;
const W = {};
const R = {};
const D = {};
const V = {}; // visit ids by key
const K = {}; // ticket ids by key

async function j(method, url, { token, ws, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (ws) headers['X-Workspace-Id'] = ws;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${app.base}${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buf.toString('utf8')); } catch { /* binary */ }
  return { status: res.status, headers: res.headers, buf, json };
}

async function registerUser(prefix, createOrg = false) {
  const email = `${prefix}-${randTag()}@ref68fo.local`;
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
    .run(W[key], orgId, `ref68-ws-${key}-${TAG}${key === 'A' || key === 'Cap' ? '' : ` ${FOREIGN}`}`, regionId);
}

async function addDevice(key, wsKey, createdAt, { blocked = 0, status = 'online' } = {}) {
  D[key] = crypto.randomUUID();
  const foreign = wsKey === 'A' ? '' : ` ${FOREIGN}`;
  await app.db.prepare('INSERT INTO devices (id, user_id, workspace_id, name, status, blocked, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(D[key], ownerA.id, W[wsKey], `ref68-dev-${key}${foreign}`, status, blocked, createdAt);
}

async function addVisit(key, wsKey, deviceKey, { type = 'Routine check', status = 'completed', created = T(2026, 9, 29, 9), completed = T(2026, 9, 29, 10), techId = tech.id, deviceStatus = 'working' } = {}) {
  V[key] = crypto.randomUUID();
  const foreign = wsKey === 'A' ? '' : ` ${FOREIGN}`;
  await app.db.prepare(
    `INSERT INTO field_visits (id, device_id, workspace_id, technician_user_id, visit_type, sim_network_info, device_status, remarks, status, created_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(V[key], D[deviceKey], W[wsKey], techId, type, SIM, deviceStatus, `remark ${key}${foreign}`, status, created, status === 'completed' ? completed : null);
}

async function addTicket(key, wsKey, { owner = FIELD_OPS_CONFIG.OEM_TICKET_OWNER_CATEGORY, created = T(2026, 9, 30), resolved = null } = {}) {
  K[key] = crypto.randomUUID();
  const foreign = wsKey === 'A' ? '' : ` ${FOREIGN}`;
  await app.db.prepare(
    `INSERT INTO tickets (id, workspace_id, device_id, title, owner_category, status, created_at, updated_at, resolved_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
  ).run(K[key], W[wsKey], `ticket ${key}${foreign}`, owner, resolved ? 'resolved' : 'open', created, created, resolved);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const maxActivityId = async () => Number((await app.db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM activity_log').get()).m);
async function exportRowsSince(marker, userId, expected) {
  const q = () => app.db.prepare("SELECT action, details, workspace_id FROM activity_log WHERE id > ? AND user_id = ? AND action LIKE 'EXPORT %' ORDER BY id").all(marker, userId);
  const deadline = Date.now() + 8000;
  let rows = await q();
  while (rows.length < expected && Date.now() < deadline) { await sleep(50); rows = await q(); }
  await sleep(400);
  return q();
}

function pdfText(buf) {
  assert.equal(buf.slice(0, 5).toString('latin1'), '%PDF-');
  const tmp = path.join(os.tmpdir(), `ref68-${randTag()}.pdf`);
  fs.writeFileSync(tmp, buf);
  try { return extractCells(tmp).map((c) => c.str).join(' '); } finally { fs.unlinkSync(tmp); }
}
async function xlsxSheets(buf) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const out = {};
  wb.eachSheet((ws) => {
    const rows = [];
    ws.eachRow((row) => rows.push(row.values.slice(1).map((v) => (v === null || v === undefined ? '' : String(v)))));
    out[ws.name] = rows;
  });
  return out;
}

test.before(async () => {
  await initDb();
  app = await startInProcessApp({ only: ['/api/reports', '/api/workspaces', '/api/organizations'] });

  ownerA = await registerUser('ref68aown', true);
  ownerB = await registerUser('ref68bown', true);
  member = await registerUser('ref68member');
  orgAdmin = await registerUser('ref68orgadm');
  tech = await registerUser('ref68tech');
  rvIn = await registerUser('ref68rvin');
  rvOut = await registerUser('ref68rvout');
  noAccess = await registerUser('ref68none');
  deletedTech = await registerUser('ref68deltech');

  for (const [key, name] of [['RA', 'RA'], ['RX', 'RX']]) {
    const r = await j('POST', `/api/organizations/${ownerA.orgId}/regions`, { token: ownerA.token, body: { name: `${name}-${TAG}`, level: 'region' } });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    R[key] = r.json.id;
  }
  await addWorkspace('A', ownerA.orgId, R.RA);
  await addWorkspace('A2', ownerA.orgId, R.RA);
  await addWorkspace('Cap', ownerA.orgId);
  await addWorkspace('B', ownerB.orgId);

  await app.db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_viewer')").run(W.A, member.id);
  await addOrgMember(ownerA.orgId, orgAdmin.id, 'org_admin');
  await addOrgMember(ownerA.orgId, tech.id, 'field_technician');
  await addOrgMember(ownerA.orgId, deletedTech.id, 'field_technician');
  await addOrgMember(ownerA.orgId, rvIn.id, 'regional_viewer');
  await addOrgMember(ownerA.orgId, rvOut.id, 'regional_viewer');
  for (const [u, region] of [[rvIn, R.RA], [rvOut, R.RX]]) {
    const r = await j('PUT', `/api/organizations/${ownerA.orgId}/members/${u.id}/region-scopes`, { token: ownerA.token, body: { region_ids: [region] } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
  }

  // wsA: the report's workspace
  await addDevice('new', 'A', T(2026, 9, 30, 8)); // activated in W40
  await addDevice('blocked', 'A', T(2026, 9, 30, 8), { blocked: 1 });
  await addDevice('prov', 'A', T(2026, 9, 30, 8), { status: 'provisioning' });
  await addDevice('old', 'A', T(2026, 8, 1));
  await addVisit('inst', 'A', 'new', { type: 'Installation' });
  await addVisit('rfs1', 'A', 'old', { deviceStatus: 'faulty' });
  await addVisit('rfs2', 'A', 'old', { completed: T(2026, 10, 2) });
  await addVisit('rm', 'A', 'old', { type: 'Repair' });
  await addVisit('other', 'A', 'old', { type: 'Audit' });
  await addVisit('ip', 'A', 'old', { status: 'in_progress' });
  await addVisit('nextweek', 'A', 'old', { completed: T(2026, 10, 5) });
  await addVisit('byDeleted', 'A', 'old', { type: 'Repair', techId: deletedTech.id });
  await addTicket('oemOpen', 'A');
  await addTicket('oemResolved', 'A', { created: T(2026, 9, 1), resolved: T(2026, 10, 1) });
  await addTicket('platform', 'A', { owner: 'platform' });

  // foreign rows: same org other workspace, and other org
  for (const ws of ['A2', 'B']) {
    await addDevice(`new${ws}`, ws, T(2026, 9, 30, 8));
    await addVisit(`rfs${ws}`, ws, `new${ws}`);
    await addVisit(`ip${ws}`, ws, `new${ws}`, { status: 'in_progress' });
    await addTicket(`oem${ws}`, ws);
  }

  // wsCap: 205 completed Repair visits in W40 for the PDF row cap
  await addDevice('cap', 'Cap', T(2026, 8, 1));
  const values = [];
  const params = [];
  for (let i = 0; i < 205; i++) {
    values.push("(?, ?, ?, ?, 'Repair', ?, 'working', ?, 'completed', ?, ?)");
    params.push(crypto.randomUUID(), D.cap, W.Cap, tech.id, SIM, `cap remark ${i}`, T(2026, 9, 29), T(2026, 9, 29) + i);
  }
  await app.db.prepare(
    `INSERT INTO field_visits (id, device_id, workspace_id, technician_user_id, visit_type, sim_network_info, device_status, remarks, status, created_at, completed_at) VALUES ${values.join(',')}`,
  ).run(...params);

  // a technician deleted after logging a visit (field_visits.technician_user_id -> NULL)
  await cleanupUser(app.db, deletedTech.id);

  const raw = generateToken();
  await app.db
    .prepare("INSERT INTO api_tokens (id, token_hash, prefix, name, user_id, workspace_id, scope) VALUES (?, ?, ?, ?, ?, ?, 'read')")
    .run(`tok-${randTag()}`, hashToken(raw), displayPrefix(raw), 'ref68-test', ownerA.id, W.A);
  apiToken = raw;
});

test.after(async () => {
  const owners = [ownerA.id, ownerB.id];
  await cleanupUsers(app.db, [...cleanup.filter((id) => !owners.includes(id)).reverse(), ...owners]);
  await app.stop();
});

test('access: members, org admins and in-scope regional viewers read; others are refused; a technician matches the field-visit endpoints', async () => {
  for (const [label, u] of [['owner', ownerA], ['direct member', member], ['org admin', orgAdmin], ['in-scope regional viewer', rvIn]]) {
    const r = await j('GET', Q, { token: u.token, ws: W.A });
    assert.equal(r.status, 200, `${label}: ${JSON.stringify(r.json)}`);
    assert.equal(r.json.workspace.id, W.A, label);
  }
  for (const [label, u] of [['out-of-scope regional viewer', rvOut], ["another org's user", ownerB], ['user with no access', noAccess]]) {
    const r = await j('GET', Q, { token: u.token, ws: W.A });
    assert.equal(r.status, 403, `${label}: ${r.status} ${JSON.stringify(r.json)}`);
    assert.ok(!r.buf.toString('utf8').includes(TAG), `${label}: no data in the refusal`);
  }
  // with no X-Workspace-Id the user with no workspace at all is still refused
  assert.equal((await j('GET', Q, { token: noAccess.token })).status, 403);

  // field technician: the same outcome as the existing field-visit READ endpoint
  const fv = await j('GET', `/api/workspaces/${W.A}/field-visits`, { token: tech.token });
  const rep = await j('GET', Q, { token: tech.token, ws: W.A });
  assert.equal(rep.status, fv.status, `technician: report ${rep.status} vs field-visits ${fv.status}`);
  // today that is 200: canLogFieldVisit grants a field_technician org-wide read
  assert.equal(rep.status, 200);
  // and the same for every other caller above, on the field-visit endpoint
  for (const u of [member, orgAdmin, rvIn, rvOut, ownerB, noAccess]) {
    const a = await j('GET', `/api/workspaces/${W.A}/field-visits`, { token: u.token });
    const b = await j('GET', Q, { token: u.token, ws: W.A });
    assert.equal(b.status, a.status, `${u.email}: report ${b.status} vs field-visits ${a.status}`);
  }

  // API tokens: field-visit data is JWT-only, so the token surface is refused
  const tok = await j('GET', Q, { token: apiToken });
  assert.equal(tok.status, 403, JSON.stringify(tok.json));
});

test('content and isolation: only the active workspace; nothing from another workspace or org', async () => {
  const r = await j('GET', Q, { token: ownerA.token, ws: W.A });
  assert.equal(r.status, 200);
  const body = r.json;
  const text = r.buf.toString('utf8');
  assert.ok(!text.includes(FOREIGN), 'no foreign workspace / org row in the JSON');
  for (const key of ['rfsA2', 'ipA2', 'rfsB', 'ipB']) assert.ok(!text.includes(V[key]), `visit ${key} absent`);
  for (const key of ['oemA2', 'oemB']) assert.ok(!text.includes(K[key]), `ticket ${key} absent`);
  for (const key of ['newA2', 'newB']) assert.ok(!text.includes(D[key]), `device ${key} absent`);

  const s = body.sections;
  const ids = (list) => list.map((v) => v.id).sort();
  assert.deepEqual(ids(s.installation.visits), [V.inst]);
  assert.deepEqual(s.installation.activated_screens.map((a) => a.device_id), [D.new], 'blocked + provisioning excluded');
  assert.deepEqual(ids(s.rfs.visits), [V.rfs1, V.rfs2].sort());
  assert.deepEqual(ids(s.rm.visits), [V.rm, V.byDeleted].sort());
  assert.deepEqual(ids(s.other.visits), [V.other]);
  assert.deepEqual(ids(s.in_progress.visits), [V.ip]);
  assert.deepEqual(ids(s.oem.cases), [K.oemOpen, K.oemResolved].sort());
  assert.deepEqual([s.oem.opened_in_period, s.oem.resolved_in_period, s.oem.open_now], [1, 1, 1]);
  assert.equal(s.rm.visits.find((v) => v.id === V.byDeleted).technician_name, 'Deleted user');
  assert.equal(s.rfs.visits.find((v) => v.id === V.rfs1).technician_name, `ref68tech ${TAG}`);
  assert.equal(s.rfs.by_screen[0].last_device_status, 'working');
  assert.equal(body.period.label, 'week 2026-W40 (2026-09-28 to 2026-10-04)');
  assert.equal(body.period.start, '2026-09-28T00:00:00.000Z');
  assert.equal(body.period.end, '2026-10-05T00:00:00.000Z');
});

test('definitions mark RFS and OEM as pending PMI confirmation', async () => {
  const r = await j('GET', Q, { token: member.token, ws: W.A });
  const d = r.json.definitions;
  assert.deepEqual(d.pmi_confirmation_pending.map((p) => p.section).sort(), ['oem', 'rfs']);
  assert.deepEqual(d.visit_type_sections, { Installation: 'installation', 'Routine check': 'rfs', Repair: 'rm' });
  assert.equal(d.oem_ticket_owner_category, 'hardware');
  assert.equal(r.json.sections.rfs.pmi_confirmation_pending, true);
  assert.equal(r.json.sections.oem.pmi_confirmation_pending, true);
  assert.equal(r.json.sections.rm.pmi_confirmation_pending, false);
});

test('formats: csv / xlsx / pdf download as attachments, one EXPORT audit row each; json writes none', async () => {
  const marker = await maxActivityId();
  const json = await j('GET', `${Q}&format=json`, { token: ownerA.token, ws: W.A });
  assert.equal(json.status, 200);
  assert.equal(json.headers.get('content-disposition'), null);

  const got = {};
  for (const fmt of ['csv', 'xlsx', 'pdf']) {
    const r = await j('GET', `${Q}&format=${fmt}`, { token: ownerA.token, ws: W.A });
    assert.equal(r.status, 200, `${fmt}: ${r.buf.toString('utf8').slice(0, 200)}`);
    assert.equal(r.headers.get('content-disposition'), `attachment; filename=${BASE_NAME}.${fmt}`);
    got[fmt] = r;
  }
  assert.match(got.csv.headers.get('content-type'), /text\/csv/);
  assert.match(got.xlsx.headers.get('content-type'), /spreadsheetml/);
  assert.equal(got.pdf.headers.get('content-type'), 'application/pdf');

  const csv = got.csv.buf.toString('utf8');
  assert.ok(csv.startsWith('﻿Section,Row,'), 'UTF-8 BOM + header');
  assert.ok(csv.includes(V.rfs1) && csv.includes(K.oemOpen) && csv.includes('remark rfs1'));

  const sheets = await xlsxSheets(got.xlsx.buf);
  assert.deepEqual(Object.keys(sheets), ['Summary', 'Installation visits', 'Activations', 'RFS', 'R&M', 'Other visits', 'In progress', 'OEM cases', 'By technician', 'By screen']);
  assert.equal(sheets.RFS.length, 3, 'header + 2 RFS visits');
  assert.ok(sheets.Summary.some((row) => row[1].includes('Routine check')), 'summary carries the pending definitions');

  const pdf = pdfText(got.pdf.buf);
  assert.ok(pdf.includes('Field operations') && pdf.includes('RFS visits'));

  // "open now" carries its as-of-today label in every format
  const openNow = FIELD_OPS_CONFIG.METRIC_LABELS.oem_open_now;
  assert.equal(json.json.definitions.metric_labels.oem_open_now, openNow);
  assert.ok(csv.includes(openNow), 'csv');
  assert.ok(sheets['OEM cases'][0].includes(openNow), 'xlsx OEM header');
  assert.ok(sheets.Summary.some((row) => row[0].endsWith(openNow)), 'xlsx summary');
  assert.ok(pdf.includes(openNow), 'pdf');

  const rows = await exportRowsSince(marker, ownerA.id, 3);
  assert.equal(rows.length, 3, JSON.stringify(rows));
  assert.deepEqual(rows.map((r) => /format=(\w+)/.exec(r.details)[1]), ['csv', 'xlsx', 'pdf']);
  for (const row of rows) {
    assert.equal(row.action, 'EXPORT /api/reports/field-operations');
    assert.equal(row.workspace_id, W.A);
  }
});

test('sim_network_info never appears in any format', async () => {
  for (const ws of [W.A, W.Cap]) {
    const json = await j('GET', Q, { token: ownerA.token, ws });
    assert.ok(!json.buf.toString('utf8').includes(SIM), 'json value');
    assert.ok(!json.buf.toString('utf8').includes('sim_network_info'), 'json key');
    const csv = await j('GET', `${Q}&format=csv`, { token: ownerA.token, ws });
    assert.ok(!csv.buf.toString('utf8').includes(SIM), 'csv');
    const xlsx = await xlsxSheets((await j('GET', `${Q}&format=xlsx`, { token: ownerA.token, ws })).buf);
    assert.ok(!JSON.stringify(xlsx).includes(SIM) && !JSON.stringify(xlsx).includes('sim_network_info'), 'xlsx');
    const pdf = pdfText((await j('GET', `${Q}&format=pdf`, { token: ownerA.token, ws })).buf);
    assert.ok(!pdf.includes(SIM), 'pdf');
  }
});

test('PDF caps each list at 200 rows with an "N more in the XLSX" line; XLSX has every row', async () => {
  const pdf = pdfText((await j('GET', `${Q}&format=pdf`, { token: ownerA.token, ws: W.Cap })).buf);
  assert.match(pdf, /first 200 of 205; 5 more in the XLSX/);
  assert.ok(pdf.includes('cap remark 199') && !pdf.includes('cap remark 200'));
  const sheets = await xlsxSheets((await j('GET', `${Q}&format=xlsx`, { token: ownerA.token, ws: W.Cap })).buf);
  assert.equal(sheets['R&M'].length, 206, 'header + 205 rows');
});

test('bad period / date / format -> 400', async () => {
  for (const qs of ['period=year', 'period=week&date=2026-13-01', 'period=day&date=2026-02-30', 'period=day&date=yesterday', 'period=day&date=2999-01-01', 'format=docx']) {
    const r = await j('GET', `/api/reports/field-operations?${qs}`, { token: ownerA.token, ws: W.A });
    assert.equal(r.status, 400, `${qs}: ${r.status} ${JSON.stringify(r.json)}`);
  }
  const def = await j('GET', '/api/reports/field-operations', { token: ownerA.token, ws: W.A });
  assert.equal(def.status, 200);
  assert.equal(def.json.period.kind, 'week');
  assert.equal(def.json.period.complete, true, 'default = last complete week');
});
