'use strict';

// Ref 49 (reconciliation reporting), Stage A — lib/reconciliation.js +
// services/reconciliation-report.js.
//
// In-process against the real MySQL (like report-digest.test.js). Seeds one org
// with three workspaces and a devices matrix that exercises every branch:
//   ghost            - registered, NEVER a device_telemetry row
//   ghost (connected)- registered, socket-connected once (last_heartbeat set) but
//                      still never a telemetry row -> still a ghost
//   stale            - reported, but last heartbeat > staleAfterDays ago
//   stale-suppressed - old telemetry BUT a recent last_heartbeat -> NOT stale
//   healthy          - reported minutes ago
//   recently offline - reported 3 days ago -> NOT stale (routine blip window)
//   blocked ghost    - would be a ghost but blocked -> excluded
// Then drives the reconciliation-report core and asserts recipients, PDF + XLSX
// content, the configurable frequency (two different intervals), and the
// watermark idempotency / restart-safety guarantee.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');

const { db } = require('../db/database');
const { getReconciliation } = require('../lib/reconciliation');
const report = require('../services/reconciliation-report');
const { extractCells } = require('../scripts/pdf-text-dump');

const RID = 'RC-' + crypto.randomBytes(4).toString('hex');
const id = (s) => `${RID}-${s}`;
const email = (s) => `${RID}-${s}@test.local`;

const DAY = 86400;
const nowSec = Math.floor(Date.now() / 1000);
const now = new Date(nowSec * 1000);

before(async () => {
  await db.prepare('INSERT INTO users (id, email, name) VALUES (?, ?, ?)').run(id('u-admin1'), email('admin1'), 'WS Admin One');
  await db.prepare('INSERT INTO users (id, email, name) VALUES (?, ?, ?)').run(id('u-admin2'), email('admin2'), 'WS Admin Two');
  await db.prepare('INSERT INTO users (id, email, name) VALUES (?, ?, ?)').run(id('u-viewer'), email('viewer'), 'WS Viewer');
  await db.prepare('INSERT INTO users (id, email, name) VALUES (?, ?, ?)').run(id('u-owner'), email('owner'), 'Org Owner');

  await db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run(id('org'), `${RID} Org`, id('u-owner'));
  await db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run(id('ws1'), id('org'), `${RID} WS One`);
  await db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run(id('ws2'), id('org'), `${RID} WS Two`);
  await db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run(id('ws3'), id('org'), `${RID} WS Three`);

  await db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)').run(id('ws1'), id('u-admin1'), 'workspace_admin');
  await db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)').run(id('ws1'), id('u-viewer'), 'workspace_viewer');
  await db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)').run(id('ws2'), id('u-admin2'), 'workspace_admin');
  // ws3 deliberately has NO workspace_admin.

  const dev = (devId, ws, name, createdAgoDays, lastHbAgoDays, blocked = 0) =>
    db.prepare(
      'INSERT INTO devices (id, workspace_id, name, status, blocked, last_heartbeat, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(devId, ws, name, 'offline', blocked, lastHbAgoDays == null ? null : nowSec - Math.round(lastHbAgoDays * DAY), nowSec - createdAgoDays * DAY);

  const tele = (devId, agoDays) =>
    db.prepare('INSERT INTO device_telemetry (device_id, battery_level, reported_at) VALUES (?, ?, ?)')
      .run(devId, 80, nowSec - Math.round(agoDays * DAY));

  // --- WS1: the full matrix -------------------------------------------------
  await dev(id('d-ghost'), id('ws1'), `${RID} Ghost Never`, 30, null);            // ghost
  await dev(id('d-ghost-conn'), id('ws1'), `${RID} Ghost Connected`, 25, 40);     // ghost (connected once, no telemetry)
  await dev(id('d-stale'), id('ws1'), `${RID} Stale Device`, 60, 20);             // stale
  await tele(id('d-stale'), 20);
  await tele(id('d-stale'), 45);
  await dev(id('d-stale-suppressed'), id('ws1'), `${RID} Old Telemetry Live HB`, 60, 2); // NOT stale (recent last_heartbeat)
  await tele(id('d-stale-suppressed'), 30);
  await dev(id('d-healthy'), id('ws1'), `${RID} Healthy Device`, 60, 0.01);       // healthy
  await tele(id('d-healthy'), 0.01);
  await dev(id('d-recent-offline'), id('ws1'), `${RID} Recently Offline`, 60, 3); // NOT stale (blip window)
  await tele(id('d-recent-offline'), 3);
  await dev(id('d-blocked'), id('ws1'), `${RID} Blocked Ghost`, 30, null, 1);     // excluded (blocked)

  // --- WS2: one ghost, its own admin --------------------------------------
  await dev(id('d-ws2-ghost'), id('ws2'), `${RID} WS2 Ghost`, 15, null);

  // --- WS3: a ghost but NO admin to notify -------------------------------
  await dev(id('d-ws3-ghost'), id('ws3'), `${RID} WS3 Ghost`, 15, null);

  await db.prepare('DELETE FROM app_settings WHERE `key` = ?').run(report.RECON_KEY);
});

after(async () => {
  const devIds = ['d-ghost', 'd-ghost-conn', 'd-stale', 'd-stale-suppressed', 'd-healthy', 'd-recent-offline', 'd-blocked', 'd-ws2-ghost', 'd-ws3-ghost'].map(id);
  await db.prepare(`DELETE FROM device_telemetry WHERE device_id IN (${devIds.map(() => '?').join(',')})`).run(...devIds);
  await db.prepare(`DELETE FROM devices WHERE id IN (${devIds.map(() => '?').join(',')})`).run(...devIds);
  await db.prepare('DELETE FROM organizations WHERE id = ?').run(id('org')); // cascades workspaces + members
  await db.prepare('DELETE FROM users WHERE id LIKE ?').run(RID + '-%');
  await db.prepare('DELETE FROM app_settings WHERE `key` = ?').run(report.RECON_KEY);
  await db.prepare('INSERT INTO app_settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)').run(report.FREQ_KEY, '7');
  await db.close();
});

function fakeEmail() {
  const sent = [];
  return { sent, isConfigured: () => true, sendEmail: async (m) => { sent.push(m); return { sent: true }; } };
}
const isPdf = (buf) => Buffer.isBuffer(buf) && buf.slice(0, 5).toString('latin1') === '%PDF-';
function pdfTextOf(buf) {
  const tmp = path.join(os.tmpdir(), `rc-test-${crypto.randomBytes(4).toString('hex')}.pdf`);
  fs.writeFileSync(tmp, buf);
  try { return extractCells(tmp).map((c) => c.str).join(' '); } finally { fs.unlinkSync(tmp); }
}
async function setFreq(days) {
  await db.prepare('INSERT INTO app_settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)').run(report.FREQ_KEY, String(days));
}
async function resetWatermark() {
  await db.prepare('DELETE FROM app_settings WHERE `key` = ?').run(report.RECON_KEY);
}

// ---- lib -----------------------------------------------------------------

test('getReconciliation: identifies ghost + stale, ignores healthy / recent / blocked / other-workspace', async () => {
  const r = await getReconciliation(db, { workspaceId: id('ws1'), now });

  const ghostNames = r.ghosts.map((g) => g.name).sort();
  assert.deepEqual(ghostNames, [`${RID} Ghost Connected`, `${RID} Ghost Never`], 'both never-reported devices are ghosts (incl. the one that connected once)');
  assert.ok(!ghostNames.includes(`${RID} Blocked Ghost`), 'a blocked device is not a discrepancy');

  const staleNames = r.stale.map((s) => s.name);
  assert.deepEqual(staleNames, [`${RID} Stale Device`], 'only the genuinely abandoned device is stale');
  assert.ok(!staleNames.includes(`${RID} Old Telemetry Live HB`), 'old telemetry + recent heartbeat is NOT stale');
  assert.ok(!staleNames.includes(`${RID} Healthy Device`), 'healthy device not flagged');
  assert.ok(!staleNames.includes(`${RID} Recently Offline`), 'a 3-day blip is not long-term abandonment');

  const stale = r.stale[0];
  assert.ok(stale.days_since_heartbeat >= 19 && stale.days_since_heartbeat <= 21, `~20 days since heartbeat (got ${stale.days_since_heartbeat})`);
  assert.ok(stale.registered_at < stale.last_heartbeat, 'registered before its last heartbeat');
  assert.equal(r.stale_after_days, 14);

  // never-connected ghost has no last heartbeat; connected-once ghost does
  const never = r.ghosts.find((g) => g.name === `${RID} Ghost Never`);
  const conn = r.ghosts.find((g) => g.name === `${RID} Ghost Connected`);
  assert.equal(never.last_heartbeat, null);
  assert.ok(conn.last_heartbeat > 0);
});

test('getReconciliation: staleAfterDays override changes the cut-off', async () => {
  // With a 2-day threshold, the "recently offline" (3d) device also becomes stale;
  // the "old telemetry + live heartbeat" one still is not (last_heartbeat 2d ago,
  // GREATEST wins). Healthy stays healthy.
  const r = await getReconciliation(db, { workspaceId: id('ws1'), now, staleAfterDays: 2 });
  const staleNames = r.stale.map((s) => s.name).sort();
  assert.ok(staleNames.includes(`${RID} Stale Device`));
  assert.ok(staleNames.includes(`${RID} Recently Offline`));
  assert.ok(!staleNames.includes(`${RID} Healthy Device`));
});

// ---- delivery ----------------------------------------------------------

test('report: PDF + XLSX per workspace with findings, to that workspace_admin(s) only', async () => {
  await resetWatermark();
  await setFreq(7);
  const mail = fakeEmail();
  const res = await report.runReconciliationReport(db, mail, now);
  assert.equal(res.ran, true);

  const mine = mail.sent.filter((m) => m.subject.includes(RID));
  const byTo = new Map(mine.map((m) => [m.to, m]));

  assert.ok(byTo.has(email('admin1')), 'WS One admin got a report');
  assert.ok(byTo.has(email('admin2')), 'WS Two admin got a report');
  assert.ok(!byTo.has(email('viewer')), 'workspace_viewer did NOT');
  assert.ok(!byTo.has(email('owner')), 'org_owner is not a recipient of a workspace report');
  assert.ok(!mine.some((m) => m.subject.includes(`${RID} WS Three`)), 'WS Three (no admin) produced no email');

  const m = byTo.get(email('admin1'));
  assert.match(m.subject, new RegExp(`Device reconciliation .* ${RID} WS One`));
  assert.equal(m.attachments.length, 2);
  const pdfAtt = m.attachments.find((a) => a.filename.endsWith('.pdf'));
  const xlsxAtt = m.attachments.find((a) => a.filename.endsWith('.xlsx'));
  assert.ok(pdfAtt && xlsxAtt);
  assert.equal(pdfAtt.contentType, 'application/pdf');
  assert.equal(xlsxAtt.contentType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.ok(isPdf(pdfAtt.content));

  const pdfText = pdfTextOf(pdfAtt.content);
  assert.match(pdfText, /Ghost Devices \(never reported\)/);
  assert.match(pdfText, /Stale Devices \(no heartbeat in 14\+ days\)/);
  assert.match(pdfText, /Ghost Never/);
  assert.match(pdfText, /Stale Device/);
  assert.ok(!/Healthy Device/.test(pdfText), 'healthy device is not in the report');

  // XLSX: two sheets, ghost + stale rows present with the actionable columns
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(xlsxAtt.content);
  assert.equal(wb.worksheets.length, 2);
  const ghostSheet = wb.worksheets[0];
  const staleSheet = wb.worksheets[1];
  assert.deepEqual(ghostSheet.getRow(1).values.slice(1), ['Device', 'Registered', 'Last Heartbeat']);
  assert.deepEqual(staleSheet.getRow(1).values.slice(1), ['Device', 'Registered', 'Last Heartbeat', 'Days Since']);

  const ghostCol = [];
  ghostSheet.eachRow((row, n) => { if (n > 1) ghostCol.push(String(row.getCell(1).value)); });
  assert.ok(ghostCol.some((v) => v.includes('Ghost Never')));
  assert.ok(ghostCol.some((v) => v.includes('Ghost Connected')));
  assert.ok(!ghostCol.some((v) => v.includes('Blocked Ghost')));

  const staleRows = [];
  staleSheet.eachRow((row, n) => { if (n > 1) staleRows.push(row.values.slice(1)); });
  assert.equal(staleRows.length, 1);
  assert.match(String(staleRows[0][0]), /Stale Device/);
  assert.ok(Number(staleRows[0][3]) >= 19 && Number(staleRows[0][3]) <= 21, 'Days Since column ~20');

  // body text lists the specific devices
  assert.match(m.text, /2 ghost device\(s\).*1 stale device\(s\)/s);
  assert.match(m.text, /Ghost Never \(registered/);
  assert.match(m.text, /runs every 7 day\(s\)/);

  // WS Two admin's report only mentions the WS2 ghost
  const m2 = byTo.get(email('admin2'));
  assert.match(pdfTextOf(m2.attachments.find((a) => a.filename.endsWith('.pdf')).content), /WS2 Ghost/);
});

test('report: nothing due until the configured interval elapses; watermark persisted + restart-safe', async () => {
  // watermark is now at today's date (previous test ran). Same clock -> skip.
  const mail = fakeEmail();
  const res = await report.runReconciliationReport(db, mail, now);
  assert.equal(res.ran, false, 'same day, 7-day interval -> nothing due');
  assert.equal(mail.sent.filter((m) => m.subject.includes(RID)).length, 0);

  // watermark is a durable app_settings row (survives a process restart)
  const wm = await db.prepare('SELECT value FROM app_settings WHERE `key` = ?').get(report.RECON_KEY);
  assert.equal(wm.value, now.toISOString().slice(0, 10));

  // 6 days later: still inside the 7-day interval -> skip
  const res6 = await report.runReconciliationReport(db, fakeEmail(), new Date(now.getTime() + 6 * DAY * 1000));
  assert.equal(res6.ran, false);

  // 7 days later: interval elapsed -> fires again
  const res7 = await report.runReconciliationReport(db, fakeEmail(), new Date(now.getTime() + 7 * DAY * 1000));
  assert.equal(res7.ran, true);
});

test('report: frequency setting is genuinely configurable (second interval)', async () => {
  await resetWatermark();

  // interval A: 5 days
  await setFreq(5);
  const t0 = now.getTime();
  assert.equal((await report.runReconciliationReport(db, fakeEmail(), new Date(t0))).ran, true, 'first run always fires');
  assert.equal((await report.runReconciliationReport(db, fakeEmail(), new Date(t0 + 4 * DAY * 1000))).ran, false, 'day 4 < 5');
  const a = await report.runReconciliationReport(db, fakeEmail(), new Date(t0 + 5 * DAY * 1000));
  assert.equal(a.ran, true, 'day 5 >= 5 -> fires');
  assert.equal(a.freqDays, 5);

  // interval B: 2 days — a DIFFERENT cadence, applied without code change
  await setFreq(2);
  assert.equal((await report.runReconciliationReport(db, fakeEmail(), new Date(t0 + 6 * DAY * 1000))).ran, false, 'day 6: only 1 day since the day-5 run, < 2');
  const b = await report.runReconciliationReport(db, fakeEmail(), new Date(t0 + 7 * DAY * 1000));
  assert.equal(b.ran, true, 'day 7: 2 days since the day-5 run -> fires on the new 2-day cadence');
  assert.equal(b.freqDays, 2);
});

test('report: idempotent within an interval + always logs one tick summary', async () => {
  await resetWatermark();
  await setFreq(7);

  const lines = [];
  const orig = console.log;
  console.log = (...x) => { lines.push(x.join(' ')); };
  try {
    await report.runReconciliationReports(db, fakeEmail(), { now: now.getTime() }); // fires
    const mail = fakeEmail();
    await report.runReconciliationReports(db, mail, { now: now.getTime() });         // idempotent skip
    assert.equal(mail.sent.filter((m) => m.subject.includes(RID)).length, 0, 'no re-send within the interval');
  } finally {
    console.log = orig;
  }
  const ticks = lines.filter((l) => l.startsWith('[reconciliation-report] tick:'));
  assert.equal(ticks.length, 2, 'one tick summary per call');
  assert.match(ticks[0], /tick: sent \d+ \(pdf\+xlsx\)$/);
  assert.equal(ticks[1], '[reconciliation-report] tick: skipped');
});

test('real email.js path: unconfigured SMTP still logs a send attempt with the attachment', async () => {
  await resetWatermark();
  await setFreq(7);
  const realEmail = require('../services/email');

  const lines = [];
  const orig = console.log;
  console.log = (...a) => { lines.push(a.join(' ')); orig(...a); };
  try {
    await report.runReconciliationReport(db, realEmail, now);
  } finally {
    console.log = orig;
  }
  assert.ok(lines.some((l) => /\[EMAIL\].*Device reconciliation/.test(l)), 'email.js logged the reconciliation send');
  assert.ok(lines.some((l) => /attachment: device-reconciliation-.*\.pdf/.test(l)), 'the log records the PDF attachment');
});
