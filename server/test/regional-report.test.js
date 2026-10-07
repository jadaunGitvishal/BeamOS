'use strict';

// PMI Ref 66: regional runtime reports (services/regional-report.js).
//
// Real local MySQL, fixed clock, fake email. Randomly tagged fixtures, all deleted in
// after(); the app_settings watermarks this touches (regional_report_* and the Ref 46
// report_digest_*) are saved first and restored afterwards.
//
// Org A tree:              R (region) > C (cluster) > A (area) > T1, T2 (territory)
//                                       C > A2 (area) > T3, Tempty (territory)
//                          R2 (region, separate)     TBig (territory, top level)
// Org A workspaces:        wT1 wT2 wA wC wT3 wR2 wBig, wNone (no region)
// Org B:                   RB (region) > TB (territory): wB
//                          wBad: an org-B workspace whose region_id names org A's T1
//
// Clock: Wednesday 2026-09-02 06:00 UTC -> daily = 2026-09-01, weekly = 2026-W35
// (2026-08-24 .. 2026-08-30), monthly = 2026-08.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');

const { db } = require('../db/database');
const rr = require('../services/regional-report');
const digest = require('../services/report-digest');
const { getRuntimeSummary } = require('../lib/runtime-summary');
const { extractCells } = require('../scripts/pdf-text-dump');

const RID = 'RR-' + crypto.randomBytes(4).toString('hex');
const id = (s) => `${RID}-${s}`;
const mailOf = (s) => `${RID}-${s}@test.local`.toLowerCase();

const NOW = Date.UTC(2026, 8, 2, 6); // Wed 2026-09-02 06:00 UTC
const T = (y, m, d, h = 0) => Date.UTC(y, m - 1, d, h) / 1000;
const LONG_AGO = T(2026, 7, 1);

const ORG_A = id('orgA');
const ORG_B = id('orgB');
const R = {};
const W = {};
const U = {};

const WATERMARK_KEYS = [...Object.values(rr.CADENCES).map((c) => c.key), digest.DAILY_KEY, digest.MONTHLY_KEY];
const savedSettings = new Map();

async function addUser(key, extra = {}) {
  U[key] = id(`u-${key}`);
  await db.prepare('INSERT INTO users (id, email, name) VALUES (?, ?, ?)').run(U[key], mailOf(key), `RR ${key}`);
  if (extra.deactivated) await db.prepare('UPDATE users SET deactivated_at = ? WHERE id = ?').run(T(2026, 8, 1), U[key]);
  if (extra.optOut) await db.prepare('UPDATE users SET email_alerts = 0 WHERE id = ?').run(U[key]);
}
async function addRegion(key, org, name, level, parentKey = null) {
  R[key] = id(`r-${key}`);
  await db
    .prepare('INSERT INTO regions (id, organization_id, name, level, parent_id) VALUES (?, ?, ?, ?, ?)')
    .run(R[key], org, name, level, parentKey ? R[parentKey] : null);
}
async function addWorkspace(key, org, regionKey) {
  W[key] = id(`w-${key}`);
  await db
    .prepare('INSERT INTO workspaces (id, organization_id, name, region_id) VALUES (?, ?, ?, ?)')
    .run(W[key], org, `${RID} WS ${key}`, regionKey ? R[regionKey] : null);
}
async function addDevice(devId, wsKey, { name = devId, createdAt = LONG_AGO, blocked = 0, status = 'offline' } = {}) {
  await db
    .prepare('INSERT INTO devices (id, workspace_id, name, status, blocked, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id(devId), W[wsKey], name, status, blocked, createdAt);
}
async function usage(devId, day, secs) {
  await db.prepare('INSERT INTO device_usage_daily (device_id, day, online_seconds) VALUES (?, ?, ?)').run(id(devId), day, secs);
}
async function viewer(userKey, org, regionKeys) {
  await db
    .prepare('INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, ?)')
    .run(org, U[userKey], 'regional_viewer');
  for (const k of regionKeys) await setScope(userKey, org, k);
}
async function setScope(userKey, org, regionKey) {
  await db.prepare('INSERT INTO region_viewer_scopes (organization_id, user_id, region_id) VALUES (?, ?, ?)').run(org, U[userKey], R[regionKey]);
}
async function dropScope(userKey, org, regionKey) {
  await db
    .prepare('DELETE FROM region_viewer_scopes WHERE organization_id = ? AND user_id = ? AND region_id = ?')
    .run(org, U[userKey], R[regionKey]);
}

before(async () => {
  for (const k of WATERMARK_KEYS) savedSettings.set(k, await db.prepare('SELECT value FROM app_settings WHERE `key` = ?').get(k));

  for (const k of ['owner', 'wsadmin', 'T', 'A', 'C', 'mix', 'two', 'none', 'deact', 'opt', 'big', 'ownerB']) {
    await addUser(k, { deactivated: k === 'deact', optOut: k === 'opt' });
  }
  await db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run(ORG_A, `${RID} Org A`, U.owner);
  await db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run(ORG_B, `${RID} Org B`, U.ownerB);
  await db.prepare('INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, ?)').run(ORG_A, U.owner, 'org_owner');

  await addRegion('R', ORG_A, 'North', 'region');
  await addRegion('C', ORG_A, 'Punjab', 'cluster', 'R');
  await addRegion('A', ORG_A, 'Lahore Area', 'area', 'C');
  await addRegion('T1', ORG_A, 'Gulberg', 'territory', 'A');
  await addRegion('T2', ORG_A, 'Model Town', 'territory', 'A');
  await addRegion('A2', ORG_A, 'Amritsar Area', 'area', 'C');
  await addRegion('T3', ORG_A, 'Old City', 'territory', 'A2');
  await addRegion('Tempty', ORG_A, 'Empty Territory', 'territory', 'A2');
  await addRegion('R2', ORG_A, 'South', 'region');
  await addRegion('TBig', ORG_A, 'Big Territory', 'territory');
  await addRegion('RB', ORG_B, 'B Region', 'region');
  await addRegion('TB', ORG_B, 'B Territory', 'territory', 'RB');

  for (const [k, reg] of [['T1', 'T1'], ['T2', 'T2'], ['A', 'A'], ['C', 'C'], ['T3', 'T3'], ['R2', 'R2'], ['Big', 'TBig'], ['None', null]]) {
    await addWorkspace(k, ORG_A, reg);
  }
  await addWorkspace('B', ORG_B, 'TB');
  await addWorkspace('Bad', ORG_B, null);
  await db.prepare('UPDATE workspaces SET region_id = ? WHERE id = ?').run(R.T1, W.Bad); // cross-org on purpose
  await db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)').run(W.T1, U.wsadmin, 'workspace_admin');

  await addDevice('dT1a', 'T1');
  await addDevice('dT1b', 'T1'); // zero runtime
  await addDevice('dT1blk', 'T1', { blocked: 1 });
  await addDevice('dT1prov', 'T1', { status: 'provisioning' });
  await addDevice('dT2a', 'T2');
  await addDevice('dT2new', 'T2', { createdAt: T(2026, 9, 1, 12) }); // registered mid-yesterday
  await addDevice('dA', 'A');
  await addDevice('dC', 'C');
  await addDevice('dT3', 'T3');
  await addDevice('dR2', 'R2');
  await addDevice('dNone', 'None');
  await addDevice('dB', 'B');
  await addDevice('dBad', 'Bad');
  for (let i = 0; i < 3; i++) await addDevice(`big-z${i}`, 'Big', { name: `Zero${i}` });
  for (let i = 0; i < 60; i++) {
    const n = String(i).padStart(2, '0');
    await addDevice(`big-${n}`, 'Big', { name: `Big${n}` });
    await usage(`big-${n}`, '2026-09-01', 1000 + i * 1000);
  }

  // yesterday (2026-09-01)
  for (const [d, s] of [['dT1a', 43200], ['dT1blk', 86400], ['dT1prov', 86400], ['dT2a', 86400], ['dT2new', 21600], ['dA', 64800],
    ['dC', 86400], ['dT3', 3600], ['dR2', 7200], ['dNone', 86400], ['dB', 86400], ['dBad', 86400]]) await usage(d, '2026-09-01', s);
  // in week 35 (2026-08-25) and so also in August
  for (const [d, s] of [['dT1a', 86400], ['dC', 43200], ['dR2', 3600], ['dA', 86400], ['dT2a', 86400], ['dNone', 86400], ['dBad', 86400]]) {
    await usage(d, '2026-08-25', s);
  }
  // August, outside week 35
  await usage('dC', '2026-08-10', 86400);
  // 2026-08-31: in August, but outside week 35 and outside "yesterday"
  await usage('dT1b', '2026-08-31', 86400);

  await viewer('T', ORG_A, ['T1']);
  await viewer('A', ORG_A, ['A']);
  await viewer('C', ORG_A, ['C']);
  await viewer('mix', ORG_A, ['T3', 'R2']);
  await viewer('two', ORG_A, ['T2']);
  await viewer('two', ORG_B, ['TB']);
  await viewer('none', ORG_A, ['Tempty']);
  await viewer('deact', ORG_A, ['T1']);
  await viewer('opt', ORG_A, ['T1']);
  await viewer('big', ORG_A, ['TBig']);
});

after(async () => {
  const devs = await db.prepare('SELECT id FROM devices WHERE id LIKE ?').all(RID + '-%');
  for (const d of devs) await db.prepare('DELETE FROM device_usage_daily WHERE device_id = ?').run(d.id);
  await db.prepare('DELETE FROM devices WHERE id LIKE ?').run(RID + '-%');
  await db.prepare('DELETE FROM organizations WHERE id IN (?, ?)').run(ORG_A, ORG_B); // cascades workspaces, members, regions, scopes
  await db.prepare('DELETE FROM users WHERE id LIKE ?').run(RID + '-%');
  await restoreWatermarks();
  await db.close();
});

async function restoreWatermarks() {
  for (const [k, row] of savedSettings) {
    if (row) await db.prepare('INSERT INTO app_settings (`key`, value, updated_at) VALUES (?, ?, UNIX_TIMESTAMP()) ON DUPLICATE KEY UPDATE value = VALUES(value)').run(k, row.value);
    else await db.prepare('DELETE FROM app_settings WHERE `key` = ?').run(k);
  }
}
async function clearRegionalWatermarks() {
  for (const c of Object.values(rr.CADENCES)) await db.prepare('DELETE FROM app_settings WHERE `key` = ?').run(c.key);
}

function fakeEmail({ failFor } = {}) {
  const sent = [];
  return {
    sent,
    isConfigured: () => true,
    sendEmail: async (m) => {
      if (failFor && m.to === failFor) throw new Error('simulated SMTP failure');
      sent.push(m);
      return { sent: true };
    },
  };
}
// Only this file's recipients (the local DB may hold other data).
const ours = (mail) => mail.sent.filter((m) => m.to.startsWith(RID.toLowerCase()));
const cadenceOf = (m) => (/· Daily /.test(m.subject) ? 'daily' : /· Weekly /.test(m.subject) ? 'weekly' : /· Monthly /.test(m.subject) ? 'monthly' : '?');
const mailsFor = (mail, key, cadence) => ours(mail).filter((m) => m.to === mailOf(key) && (!cadence || cadenceOf(m) === cadence));

async function freshRun(now = NOW, mail = fakeEmail()) {
  await clearRegionalWatermarks();
  const res = await rr.runRegionalReports(db, mail, { now });
  return { mail, res };
}

async function readXlsx(m) {
  const att = m.attachments.find((a) => a.filename.endsWith('.xlsx'));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(att.content);
  const rows = (name) => {
    const out = [];
    wb.getWorksheet(name).eachRow((row, n) => {
      if (n > 1) out.push(Array.from(row.values).slice(1).map((v) => (v == null ? '' : String(v))));
    });
    return out;
  };
  const summary = new Map(rows('Runtime Summary').map((r) => [r[0], r[1]]));
  const screens = rows('Screens');
  return { summary, screens, deviceIds: screens.map((r) => r[1]), workspaces: rows('Workspaces') };
}
function pdfText(m) {
  const att = m.attachments.find((a) => a.filename.endsWith('.pdf'));
  assert.equal(att.content.slice(0, 5).toString('latin1'), '%PDF-');
  const tmp = path.join(os.tmpdir(), `rr-test-${crypto.randomBytes(4).toString('hex')}.pdf`);
  fs.writeFileSync(tmp, att.content);
  try {
    return extractCells(tmp).map((c) => c.str).join(' ');
  } finally {
    fs.unlinkSync(tmp);
  }
}
const ids = (...keys) => keys.map(id).sort();
const NEVER = ids('dNone', 'dBad', 'dT1blk', 'dT1prov');

// Every XLSX row is one of `expected`, and the set is exactly `expected`.
async function assertScreens(m, expectedKeys, label) {
  const x = await readXlsx(m);
  const expected = ids(...expectedKeys);
  for (const d of x.deviceIds) {
    assert.ok(expected.includes(d), `${label}: unexpected screen ${d} in the XLSX`);
    assert.ok(!NEVER.includes(d), `${label}: excluded/out-of-scope screen ${d} appeared`);
  }
  assert.deepEqual([...x.deviceIds].sort(), expected, `${label}: exact screen set`);
  return x;
}

// ---------------------------------------------------------------------------

test('territory-scoped viewer: daily only, exactly their screens', async () => {
  const { mail, res } = await freshRun();
  assert.equal(res.daily.ran, true);
  assert.equal(res.daily.target, '2026-09-01');
  assert.equal(res.weekly.target, '2026-08-24');
  assert.equal(res.monthly.target, '2026-08');

  const all = mailsFor(mail, 'T');
  assert.deepEqual(all.map(cadenceOf), ['daily'], 'TSE gets the daily report only');
  const m = all[0];
  assert.equal(m.subject, `Screen runtime: ${RID} Org A · Daily 2026-09-01`);
  const slugA = `${RID} Org A`.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  assert.deepEqual(m.attachments.map((a) => a.filename).sort(), [
    `screen-runtime-${slugA}-daily-2026-09-01.pdf`,
    `screen-runtime-${slugA}-daily-2026-09-01.xlsx`,
  ]);
  await assertScreens(m, ['dT1a', 'dT1b'], 'TSE');
  assert.match(m.text, /North > Punjab > Lahore Area > Gulberg/, 'body names the current scope');
  assert.match(m.text, /Zero-runtime screens: 1 of 2 \(50%\)/);
  assert.match(m.text, /05:30 IST/);

  // no regional report to admins/owners
  assert.equal(mailsFor(mail, 'owner').length, 0);
  assert.equal(mailsFor(mail, 'wsadmin').length, 0);
});

test('area scope includes the territories below it', async () => {
  const { mail } = await freshRun();
  const all = mailsFor(mail, 'A');
  assert.deepEqual(all.map(cadenceOf), ['daily']);
  await assertScreens(all[0], ['dA', 'dT1a', 'dT1b', 'dT2a', 'dT2new'], 'ASM');
});

test('cluster scope: weekly + monthly, no daily; everything below the cluster', async () => {
  const { mail } = await freshRun();
  const all = mailsFor(mail, 'C');
  assert.deepEqual(all.map(cadenceOf).sort(), ['monthly', 'weekly']);
  const weekly = mailsFor(mail, 'C', 'weekly')[0];
  assert.equal(weekly.subject, `Screen runtime: ${RID} Org A · Weekly week 2026-W35 (2026-08-24 to 2026-08-30)`);
  assert.ok(weekly.attachments.every((a) => a.filename.includes('-weekly-2026-W35.')));
  // dT2new was registered after the week ended, so it isn't in the weekly/monthly reports
  const wx = await assertScreens(weekly, ['dC', 'dA', 'dT1a', 'dT1b', 'dT2a', 'dT3'], 'CM weekly');
  // week 35: dC 12h, dA 24h, dT1a 24h, dT2a 24h = 84h; dT1b / dT3 zero
  assert.equal(wx.summary.get('Total runtime (hours)'), '84');
  assert.equal(wx.summary.get('Zero-runtime screens'), '2 of 6 (33.3%)');

  const monthly = mailsFor(mail, 'C', 'monthly')[0];
  assert.equal(monthly.subject, `Screen runtime: ${RID} Org A · Monthly 2026-08`);
  const mx = await assertScreens(monthly, ['dC', 'dA', 'dT1a', 'dT1b', 'dT2a', 'dT3'], 'CM monthly');
  // August adds dC on 08-10 (24h) and dT1b on 08-31 (24h) to week 35's 84h
  assert.equal(mx.summary.get('Total runtime (hours)'), '132');
  assert.equal(mx.summary.get('Zero-runtime screens'), '1 of 6 (16.7%)', 'only dT3 is zero for August');
});

test('mixed scopes (territory + region): daily AND weekly/monthly, each covering all scopes', async () => {
  const { mail } = await freshRun();
  assert.deepEqual(mailsFor(mail, 'mix').map(cadenceOf).sort(), ['daily', 'monthly', 'weekly']);
  await assertScreens(mailsFor(mail, 'mix', 'daily')[0], ['dT3', 'dR2'], 'mix daily');
  await assertScreens(mailsFor(mail, 'mix', 'weekly')[0], ['dT3', 'dR2'], 'mix weekly');
});

test('regional_viewer in two orgs: one report per org, no cross-org screens', async () => {
  const { mail } = await freshRun();
  const all = mailsFor(mail, 'two', 'daily');
  assert.equal(all.length, 2);
  const a = all.find((m) => m.subject.includes(`${RID} Org A`));
  const b = all.find((m) => m.subject.includes(`${RID} Org B`));
  assert.ok(a && b, 'one per org');
  await assertScreens(a, ['dT2a', 'dT2new'], 'two @ org A');
  await assertScreens(b, ['dB'], 'two @ org B');
});

test('no in-scope workspaces -> nothing; deactivated -> nothing; email_alerts=0 does not opt out (same as Ref 46)', async () => {
  const { mail } = await freshRun();
  assert.equal(mailsFor(mail, 'none').length, 0, 'scope with no workspaces: no email');
  assert.equal(mailsFor(mail, 'deact').length, 0, 'deactivated user: no email');
  // The Ref 46 digests have no email opt-out; users.email_alerts (device alerts) isn't consulted.
  assert.equal(mailsFor(mail, 'opt', 'daily').length, 1);

  // send-time re-check: deactivated after selection is still refused
  const r = await rr.sendRegionalReport(db, fakeEmail(), {
    cadence: 'daily', period: rr.targetPeriod('daily', new Date(NOW)), userId: U.deact, organizationId: ORG_A,
  });
  assert.equal(r, 'skipped:user');
});

test('figures match lib/runtime-summary for the same inputs', async () => {
  const { mail } = await freshRun();
  const m = mailsFor(mail, 'A', 'daily')[0];
  const x = await readXlsx(m);
  const p = rr.targetPeriod('daily', new Date(NOW));
  const s = await getRuntimeSummary(db, { organizationId: ORG_A, workspaceIds: [W.A, W.T1, W.T2], startEpoch: p.startEpoch, endEpoch: p.endEpoch });
  const o = s.overall;
  assert.equal(x.summary.get('Screens'), String(o.screens));
  assert.equal(x.summary.get('New in this period'), String(o.new_screens));
  assert.equal(x.summary.get('Total runtime (hours)'), String(o.runtime_hours));
  assert.equal(x.summary.get('Average uptime'), `${o.avg_uptime_pct}%`);
  assert.equal(x.summary.get('Zero-runtime screens'), `${o.zero_runtime_count} of ${o.zero_runtime_eligible} (${o.zero_runtime_pct}%)`);
  for (const sc of s.screens) {
    const row = x.screens.find((r) => r[1] === sc.id);
    assert.equal(row[5], String(sc.runtime_hours), `${sc.id} runtime`);
    assert.equal(row[6], `${sc.uptime_pct}%`, `${sc.id} uptime`);
  }
  // concrete: dA 18h, dT1a 12h, dT2a 24h, dT2new 6h = 60h; dT1b zero
  assert.equal(o.runtime_hours, 60);
  assert.equal(o.zero_runtime_count, 1);
  assert.equal(o.zero_runtime_eligible, 4, 'dT2new (registered mid-period) is not in the denominator');
  const newRow = x.screens.find((r) => r[1] === id('dT2new'));
  assert.equal(newRow[6], '50%', '6h of the 12h since registration');
  assert.equal(newRow[7], 'New in period');
  assert.match(m.text, new RegExp(`Total runtime: ${o.runtime_hours} hours`));
  assert.match(m.text, new RegExp(`Average uptime: ${o.avg_uptime_pct}%`));
  assert.match(m.text, /Screens: 5 \(1 new in this period\)/);
});

test('PDF: every zero-runtime screen + the 50 lowest uptime, with the omitted count; XLSX complete', async () => {
  const { mail } = await freshRun();
  const m = mailsFor(mail, 'big', 'daily')[0];
  const x = await readXlsx(m);
  assert.equal(x.deviceIds.length, 63, 'XLSX lists every screen');

  const text = pdfText(m);
  for (let i = 0; i < 3; i++) assert.match(text, new RegExp(`\\bZero${i}\\b`), `zero-runtime Zero${i} in the PDF`);
  for (let i = 0; i < 60; i++) {
    const n = String(i).padStart(2, '0');
    if (i < 50) assert.match(text, new RegExp(`\\bBig${n}\\b`), `Big${n} (among the 50 lowest) in the PDF`);
    else assert.doesNotMatch(text, new RegExp(`\\bBig${n}\\b`), `Big${n} not in the PDF`);
  }
  assert.match(text, /10 screens not shown; see the XLSX/);
  assert.match(m.text, /10 screens not shown/);
});

test('SCOPE PROTECTION: scopes and region moves are re-read on every run', async () => {
  const before1 = await freshRun();
  await assertScreens(mailsFor(before1.mail, 'T', 'daily')[0], ['dT1a', 'dT1b'], 'T before');

  // TSE moves from T1 to T2; workspace T2 moves to region R2 (out of A, into R2)
  await dropScope('T', ORG_A, 'T1');
  await setScope('T', ORG_A, 'T2');
  await db.prepare('UPDATE workspaces SET region_id = ? WHERE id = ?').run(R.R2, W.T2);
  try {
    // the next period (2026-09-02) - the daily watermark is NOT cleared, so this is a normal next run
    const mail = fakeEmail();
    const res = await rr.runRegionalReports(db, mail, { now: NOW + 86400_000 });
    assert.equal(res.daily.target, '2026-09-02');
    // T's scope (T2) now has no workspaces: wT2 moved to R2
    assert.equal(mailsFor(mail, 'T').length, 0, 'TSE: old T1 screens are gone, T2 is now empty');
    await assertScreens(mailsFor(mail, 'A', 'daily')[0], ['dA', 'dT1a', 'dT1b'], 'ASM after move');
    await assertScreens(mailsFor(mail, 'mix', 'daily')[0], ['dT3', 'dR2', 'dT2a', 'dT2new'], 'mix after move');

    // move the workspace back: T now sees exactly T2's screens
    await db.prepare('UPDATE workspaces SET region_id = ? WHERE id = ?').run(R.T2, W.T2);
    const again = await freshRun(NOW + 86400_000);
    await assertScreens(mailsFor(again.mail, 'T', 'daily')[0], ['dT2a', 'dT2new'], 'T after scope change');

    // never: a no-region, other-org or excluded screen, in ANY report of ANY recipient
    for (const run of [before1.mail, mail, again.mail]) {
      for (const msg of ours(run)) {
        const xx = await readXlsx(msg);
        for (const d of xx.deviceIds) assert.ok(!NEVER.includes(d), `${msg.to}: ${d} must never appear`);
        if (msg.subject.includes('Org A')) assert.ok(!xx.deviceIds.includes(id('dB')), 'no org-B screen in an org-A report');
      }
    }
  } finally {
    await db.prepare('UPDATE workspaces SET region_id = ? WHERE id = ?').run(R.T2, W.T2);
    await dropScope('T', ORG_A, 'T2');
    await setScope('T', ORG_A, 'T1');
  }
});

test('periods: ISO week boundary, month boundary, labels, and no second send in the same period', () => {
  const at = (s) => new Date(s);
  // ISO week: Sunday 23:59:59 is still in week 36 -> last complete is week 34
  assert.equal(rr.targetPeriod('weekly', at('2026-08-30T23:59:59Z')).key, '2026-08-17');
  const w = rr.targetPeriod('weekly', at('2026-08-31T00:00:00Z'));
  assert.equal(w.key, '2026-08-24');
  assert.equal(w.fileKey, '2026-W35');
  assert.equal(w.startEpoch, T(2026, 8, 24));
  assert.equal(w.endEpoch, T(2026, 8, 31));
  // ISO week-year: 2026 has 53 weeks
  assert.equal(rr.targetPeriod('weekly', at('2027-01-04T00:00:00Z')).fileKey, '2026-W53');
  assert.equal(rr.targetPeriod('weekly', at('2027-01-11T09:00:00Z')).fileKey, '2027-W01');
  // month
  assert.equal(rr.targetPeriod('monthly', at('2026-08-31T23:59:59Z')).key, '2026-07');
  const mo = rr.targetPeriod('monthly', at('2026-09-01T00:00:00Z'));
  assert.equal(mo.key, '2026-08');
  assert.equal(mo.endEpoch - mo.startEpoch, 31 * 86400);
  assert.equal(rr.targetPeriod('monthly', at('2027-01-15T00:00:00Z')).key, '2026-12');
  // day
  const d = rr.targetPeriod('daily', at('2026-09-01T00:00:00Z'));
  assert.equal(d.key, '2026-08-31');
  assert.equal(d.endEpoch - d.startEpoch, 86400);
});

test('periods: a second run in the same period sends nothing; crossing a boundary sends again', async () => {
  const first = await freshRun(Date.parse('2026-08-30T23:59:59Z'));
  assert.equal(first.res.weekly.target, '2026-08-17');
  assert.equal(first.res.monthly.target, '2026-07');

  const same = fakeEmail();
  const res2 = await rr.runRegionalReports(db, same, { now: Date.parse('2026-08-30T23:59:59Z') });
  assert.equal(ours(same).length, 0, 'same periods: nothing re-sent');
  assert.equal(res2.daily.ran, false);
  assert.equal(res2.weekly.ran, false);
  assert.equal(res2.monthly.ran, false);

  // Monday 00:00 UTC: a new ISO week (but not a new month)
  const mon = fakeEmail();
  const res3 = await rr.runRegionalReports(db, mon, { now: Date.parse('2026-08-31T00:00:00Z') });
  assert.equal(res3.weekly.ran, true);
  assert.equal(res3.weekly.target, '2026-08-24');
  assert.equal(res3.monthly.ran, false);
  assert.equal(mailsFor(mon, 'C', 'weekly').length, 1);
  assert.equal(mailsFor(mon, 'C', 'monthly').length, 0);

  // 1st of the month 00:00 UTC: a new month
  const first9 = fakeEmail();
  const res4 = await rr.runRegionalReports(db, first9, { now: Date.parse('2026-09-01T00:00:00Z') });
  assert.equal(res4.monthly.ran, true);
  assert.equal(res4.monthly.target, '2026-08');
  assert.equal(mailsFor(first9, 'C', 'monthly').length, 1);
});

test("one recipient's send failure doesn't stop the others (logged, not retried)", async () => {
  const mail = fakeEmail({ failFor: mailOf('T') });
  const errs = [];
  const orig = console.error;
  console.error = (...a) => errs.push(a.join(' '));
  let res;
  try {
    ({ res } = await freshRun(NOW, mail));
  } finally {
    console.error = orig;
  }
  assert.equal(mailsFor(mail, 'T').length, 0);
  assert.equal(mailsFor(mail, 'A', 'daily').length, 1, 'the next recipient still got theirs');
  assert.equal(mailsFor(mail, 'big', 'daily').length, 1);
  assert.ok(res.daily.failed >= 1);
  assert.ok(errs.some((l) => l.includes(U.T) && /not retried/.test(l)));
  // watermark advanced: the failed one is not retried on the next tick
  const retry = fakeEmail();
  await rr.runRegionalReports(db, retry, { now: NOW });
  assert.equal(mailsFor(retry, 'T').length, 0);
});

test('a regional-report failure does not affect the Ref 46 digests in the same tick', async () => {
  for (const k of [digest.DAILY_KEY, digest.MONTHLY_KEY]) await db.prepare('DELETE FROM app_settings WHERE `key` = ?').run(k);
  await clearRegionalWatermarks();

  // (1) every regional query fails (inner per-cadence isolation)
  const broken = { prepare: (sql) => { if (/region_viewer_scopes/.test(sql)) throw new Error('regional boom'); return db.prepare(sql); } };
  const mail = fakeEmail();
  const quiet = console.error;
  console.error = () => {};
  let res;
  try {
    res = await digest.runReportDigests(broken, mail, { now: NOW });
  } finally {
    console.error = quiet;
  }
  assert.equal(res.daily.ran, true);
  assert.equal(res.monthly.ran, true);
  assert.match(res.regional.daily.error, /regional boom/);
  assert.equal(ours(mail).filter((m) => m.to === mailOf('wsadmin') && /Daily proof-of-play/.test(m.subject)).length, 1, 'daily digest still sent');
  assert.equal(ours(mail).filter((m) => m.to === mailOf('owner') && /Monthly proof-of-play/.test(m.subject)).length, 1, 'monthly roll-up still sent');
  assert.equal(ours(mail).filter((m) => /Screen runtime/.test(m.subject)).length, 0);

  // (2) runRegionalReports itself throws (outer try/catch in report-digest)
  for (const k of [digest.DAILY_KEY, digest.MONTHLY_KEY]) await db.prepare('DELETE FROM app_settings WHERE `key` = ?').run(k);
  const real = rr.runRegionalReports;
  rr.runRegionalReports = async () => { throw new Error('outer boom'); };
  const mail2 = fakeEmail();
  console.error = () => {};
  try {
    res = await digest.runReportDigests(db, mail2, { now: NOW });
  } finally {
    rr.runRegionalReports = real;
    console.error = quiet;
  }
  assert.equal(res.daily.ran, true);
  assert.equal(res.monthly.ran, true);
  assert.deepEqual(res.regional, { error: 'outer boom' });
  assert.equal(ours(mail2).filter((m) => /proof-of-play/.test(m.subject)).length, 2);

  // (3) healthy tick: digests and regional reports side by side, digest keys unchanged in meaning
  for (const k of [digest.DAILY_KEY, digest.MONTHLY_KEY]) await db.prepare('DELETE FROM app_settings WHERE `key` = ?').run(k);
  await clearRegionalWatermarks();
  const mail3 = fakeEmail();
  res = await digest.runReportDigests(db, mail3, { now: NOW });
  assert.deepEqual(Object.keys(res), ['daily', 'monthly', 'regional']);
  assert.equal(res.daily.target, '2026-09-01');
  assert.equal(res.monthly.target, '2026-08');
  assert.equal(res.regional.daily.ran, true);
  assert.ok(mailsFor(mail3, 'T', 'daily').length === 1);
});
