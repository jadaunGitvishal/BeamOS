'use strict';

// Ref 48 (pending installation follow-up reporting), Stage A —
// lib/pending-installations.js + services/pending-installation-report.js.
//
// In-process against the real MySQL (like reconciliation.test.js). Seeds one org
// with three workspaces and a registration_codes matrix that exercises every
// branch:
//   fresh          - unused, cut inside the grace period       -> NOT flagged
//   pending        - unused, cut past the grace period, not expired -> pending
//   pending (installer) - same, created by a NON-admin user     -> pending; that
//                    creator must still receive the report
//   abandoned      - unused, past its 30-day expiry             -> abandoned
//   claimed        - a device activated against it              -> NOT flagged
//   other workspace- a pending code in WS2                      -> only in WS2's report
//   no recipients  - a pending code in WS3 (no admin, creator has no email)
// Then drives the report core and asserts recipients (admins + code creators),
// PDF + XLSX content, the configurable frequency (two different intervals), and
// the watermark idempotency / restart-safety guarantee.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');

const { db } = require('../db/database');
const { getPendingInstallations } = require('../lib/pending-installations');
const report = require('../services/pending-installation-report');
const { extractCells } = require('../scripts/pdf-text-dump');

const RID = 'PI-' + crypto.randomBytes(4).toString('hex');
const id = (s) => `${RID}-${s}`;
const email = (s) => `${RID}-${s}@test.local`;

const DAY = 86400;
const nowSec = Math.floor(Date.now() / 1000);
const now = new Date(nowSec * 1000);

// Distinct 6-digit codes for this run (registration_codes.code is UNIQUE + 6 chars).
let codeSeq = 100000 + crypto.randomInt(800000);
const nextCode = () => String(codeSeq++);
const CODES = {};

test('Ref 48 pending-installation report — Stage A', async (t) => {
  // ---- fixtures --------------------------------------------------------
  await db.prepare('INSERT INTO users (id, email, name) VALUES (?, ?, ?)').run(id('u-admin1'), email('admin1'), 'WS1 Admin');
  await db.prepare('INSERT INTO users (id, email, name) VALUES (?, ?, ?)').run(id('u-admin2'), email('admin2'), 'WS2 Admin');
  await db.prepare('INSERT INTO users (id, email, name) VALUES (?, ?, ?)').run(id('u-installer'), email('installer'), 'Field Installer');
  await db.prepare('INSERT INTO users (id, email, name) VALUES (?, ?, ?)').run(id('u-viewer'), email('viewer'), 'WS1 Viewer');
  await db.prepare('INSERT INTO users (id, email, name) VALUES (?, ?, ?)').run(id('u-noemail'), '', 'No Email Installer');

  await db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run(id('org'), `${RID} Org`, id('u-admin1'));
  await db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run(id('ws1'), id('org'), `${RID} WS One`);
  await db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run(id('ws2'), id('org'), `${RID} WS Two`);
  await db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run(id('ws3'), id('org'), `${RID} WS Three`);

  await db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)').run(id('ws1'), id('u-admin1'), 'workspace_admin');
  await db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)').run(id('ws1'), id('u-viewer'), 'workspace_viewer');
  await db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)').run(id('ws1'), id('u-installer'), 'workspace_viewer');
  await db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)').run(id('ws2'), id('u-admin2'), 'workspace_admin');
  // ws3 deliberately has NO workspace_admin.

  // A device row so the "claimed" code has a real FK target.
  await db.prepare(
    'INSERT INTO devices (id, workspace_id, name, status, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id('dev-claimed'), id('ws1'), `${RID} Activated`, 'online', nowSec - 5 * DAY);

  // code(key, ws, name, status, createdAgoDays, expiresInDays|null, createdBy, claimedDevId?)
  const code = (key, ws, name, status, createdAgoD, expiresInD, createdBy, claimedDev) => {
    const c = nextCode();
    CODES[key] = c;
    const createdAt = nowSec - Math.round(createdAgoD * DAY);
    const expiresAt = expiresInD == null ? null : nowSec + Math.round(expiresInD * DAY);
    return db.prepare(
      `INSERT INTO registration_codes
         (id, code, workspace_id, planned_device_name, status, created_by, created_at, expires_at, claimed_by_device_id, claimed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id('rc-' + key), c, ws, name, status, createdBy, createdAt, expiresAt,
      claimedDev || null, claimedDev ? createdAt + DAY : null,
    );
  };

  // --- WS1: the full matrix ---
  await code('fresh', id('ws1'), `${RID} Fresh Lobby TV`, 'unused', 1, 29, id('u-admin1'));            // within 3d grace -> not flagged
  await code('pending', id('ws1'), `${RID} Pending Reception`, 'unused', 10, 20, id('u-admin1'));       // pending
  await code('pending-inst', id('ws1'), `${RID} Pending Warehouse`, 'unused', 6, 24, id('u-installer')); // pending, non-admin creator
  await code('unnamed', id('ws1'), null, 'unused', 8, 22, id('u-installer'));                            // pending, no planned name
  await code('abandoned', id('ws1'), `${RID} Abandoned Dock`, 'unused', 40, -10, id('u-admin1'));        // expired unclaimed -> abandoned
  await code('claimed', id('ws1'), `${RID} Activated`, 'claimed', 12, 18, id('u-admin1'), id('dev-claimed')); // succeeded -> not flagged

  // --- WS2: one pending code, its own admin ---
  await code('ws2', id('ws2'), `${RID} WS2 Pending`, 'unused', 9, 21, id('u-admin2'));

  // --- WS3: a pending code but nobody reachable to notify ---
  await code('ws3', id('ws3'), `${RID} WS3 Pending`, 'unused', 9, 21, id('u-noemail'));

  await db.prepare('DELETE FROM app_settings WHERE `key` = ?').run(report.PENDING_KEY);
  await db.prepare('INSERT INTO app_settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)').run(report.FREQ_KEY, '7');

  t.after(async () => {
    const codeIds = Object.keys(CODES).map((k) => id('rc-' + k));
    await db.prepare(`DELETE FROM registration_codes WHERE id IN (${codeIds.map(() => '?').join(',')})`).run(...codeIds);
    await db.prepare('DELETE FROM devices WHERE id = ?').run(id('dev-claimed'));
    await db.prepare('DELETE FROM organizations WHERE id = ?').run(id('org')); // cascades workspaces + members
    await db.prepare('UPDATE activity_log SET user_id = NULL WHERE user_id LIKE ?').run(RID + '-%');
    await db.prepare('DELETE FROM users WHERE id LIKE ?').run(RID + '-%');
    await db.prepare('DELETE FROM app_settings WHERE `key` = ?').run(report.PENDING_KEY);
    await db.prepare('INSERT INTO app_settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)').run(report.FREQ_KEY, '7');
    await db.close();
  });

  // ---- helpers -------------------------------------------------------
  function fakeEmail() {
    const sent = [];
    return { sent, isConfigured: () => true, sendEmail: async (m) => { sent.push(m); return { sent: true }; } };
  }
  const isPdf = (buf) => Buffer.isBuffer(buf) && buf.slice(0, 5).toString('latin1') === '%PDF-';
  function pdfTextOf(buf) {
    const tmp = path.join(os.tmpdir(), `pi-test-${crypto.randomBytes(4).toString('hex')}.pdf`);
    fs.writeFileSync(tmp, buf);
    try { return extractCells(tmp).map((c) => c.str).join(' '); } finally { fs.unlinkSync(tmp); }
  }
  const setFreq = (days) =>
    db.prepare('INSERT INTO app_settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)').run(report.FREQ_KEY, String(days));
  const resetWatermark = () => db.prepare('DELETE FROM app_settings WHERE `key` = ?').run(report.PENDING_KEY);

  // ---- lib ----------------------------------------------------------
  await t.test('getPendingInstallations: flags pending + abandoned, ignores fresh / claimed / other-workspace', async () => {
    const r = await getPendingInstallations(db, { workspaceId: id('ws1'), now });

    const pendingCodes = r.pending.map((p) => p.code).sort();
    assert.deepEqual(pendingCodes, [CODES.pending, CODES['pending-inst'], CODES.unnamed].sort(),
      'the three unused codes past the 3d grace and not expired');
    assert.ok(!pendingCodes.includes(CODES.fresh), 'a code cut 1 day ago is inside the grace period');
    assert.ok(!pendingCodes.includes(CODES.claimed), 'a claimed code is a finished install');
    assert.ok(!pendingCodes.includes(CODES.abandoned), 'an expired code is abandoned, not pending');

    assert.deepEqual(r.abandoned.map((a) => a.code), [CODES.abandoned], 'only the expired-unclaimed code');

    const p = r.pending.find((x) => x.code === CODES.pending);
    assert.ok(p.days_pending >= 9 && p.days_pending <= 11, `~10 days pending (got ${p.days_pending})`);
    assert.ok(p.days_until_expiry >= 19 && p.days_until_expiry <= 21, `~20 days to expiry (got ${p.days_until_expiry})`);
    assert.equal(p.planned_device_name, `${RID} Pending Reception`);
    assert.equal(r.grace_days, 3);

    const ab = r.abandoned[0];
    assert.ok(ab.days_until_expiry <= 0, 'abandoned code is already past expiry');
  });

  await t.test('getPendingInstallations: graceDays override changes the cutoff', async () => {
    // grace 0 -> the "fresh" (1d) code is now also pending; grace 15 -> only the 40d/... none, wait
    const wide = await getPendingInstallations(db, { workspaceId: id('ws1'), now, graceDays: 0 });
    assert.ok(wide.pending.map((p) => p.code).includes(CODES.fresh), 'grace 0 pulls in the 1-day-old code');

    const narrow = await getPendingInstallations(db, { workspaceId: id('ws1'), now, graceDays: 9 });
    const codes = narrow.pending.map((p) => p.code);
    assert.ok(codes.includes(CODES.pending), '10d-old code still past a 9d grace');
    assert.ok(!codes.includes(CODES['pending-inst']), '6d-old code no longer past a 9d grace');
  });

  // ---- delivery ---------------------------------------------------
  await t.test('report: PDF + XLSX per workspace with findings, to admins AND code creators', async () => {
    await resetWatermark();
    await setFreq(7);
    const mail = fakeEmail();
    const res = await report.runPendingInstallationReport(db, mail, now);
    assert.equal(res.ran, true);

    const mine = mail.sent.filter((m) => m.subject.includes(RID));
    const byTo = new Map(mine.map((m) => [m.to, m]));

    assert.ok(byTo.has(email('admin1')), 'WS1 admin got a report');
    assert.ok(byTo.has(email('installer')), 'the non-admin installer who cut a pending code got a report');
    assert.ok(byTo.has(email('admin2')), 'WS2 admin got a report');
    assert.ok(!byTo.has(email('viewer')), 'an uninvolved workspace_viewer did NOT');
    assert.ok(!mine.some((m) => m.subject.includes(`${RID} WS Three`)), 'WS3 (no admin, creator has no email) produced no email');

    // one email per recipient per workspace — installer cut codes only in WS1
    assert.equal(mine.filter((m) => m.to === email('installer')).length, 1, 'installer gets exactly one email (deduped)');

    const m = byTo.get(email('admin1'));
    assert.match(m.subject, new RegExp(`Pending installations .* ${RID} WS One`));
    assert.equal(m.attachments.length, 2);
    const pdfAtt = m.attachments.find((a) => a.filename.endsWith('.pdf'));
    const xlsxAtt = m.attachments.find((a) => a.filename.endsWith('.xlsx'));
    assert.ok(pdfAtt && xlsxAtt);
    assert.equal(pdfAtt.contentType, 'application/pdf');
    assert.equal(xlsxAtt.contentType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    assert.ok(isPdf(pdfAtt.content));

    const pdfText = pdfTextOf(pdfAtt.content);
    assert.match(pdfText, /Pending Installations \(code generated/);
    assert.match(pdfText, /Abandoned Installations \(expired, never activated\)/);
    assert.match(pdfText, new RegExp(CODES.pending));
    assert.match(pdfText, new RegExp(CODES.abandoned));
    assert.match(pdfText, /Pending Reception/);
    assert.ok(!pdfText.includes(CODES.fresh), 'the fresh (in-grace) code is not in the report');
    assert.ok(!pdfText.includes(CODES.claimed), 'the claimed code is not in the report');
    assert.match(pdfText, /\(unnamed\)/, 'a code with no planned name renders as (unnamed)');

    // XLSX: two sheets with the actionable columns
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsxAtt.content);
    assert.equal(wb.worksheets.length, 2);
    assert.deepEqual(wb.worksheets[0].getRow(1).values.slice(1), ['Code', 'Planned Device', 'Pending For', 'Expires', 'Time Left']);
    assert.deepEqual(wb.worksheets[1].getRow(1).values.slice(1), ['Code', 'Planned Device', 'Generated', 'Expired']);
    const pendingCol = [];
    wb.worksheets[0].eachRow((row, n) => { if (n > 1) pendingCol.push(String(row.getCell(1).value)); });
    assert.ok(pendingCol.includes(CODES.pending) && pendingCol.includes(CODES['pending-inst']));
    assert.ok(!pendingCol.includes(CODES.fresh));

    // body text calls out the specific pending codes + time left to act
    assert.match(m.text, /3 installation\(s\) are still pending/);
    assert.match(m.text, /1 code\(s\) expired without ever being activated/);
    assert.match(m.text, new RegExp(`code ${CODES.pending} .*left to act`));
    assert.match(m.text, /runs every 7 day\(s\)/);

    // WS2 admin's report only mentions the WS2 code
    const m2 = byTo.get(email('admin2'));
    assert.match(pdfTextOf(m2.attachments.find((a) => a.filename.endsWith('.pdf')).content), new RegExp(CODES.ws2));
    assert.ok(!pdfTextOf(m2.attachments.find((a) => a.filename.endsWith('.pdf')).content).includes(CODES.pending));
  });

  await t.test('report: nothing due until the configured interval elapses; watermark persisted + restart-safe', async () => {
    const mail = fakeEmail();
    const res = await report.runPendingInstallationReport(db, mail, now);
    assert.equal(res.ran, false, 'same day, 7-day interval -> nothing due');
    assert.equal(mail.sent.filter((m) => m.subject.includes(RID)).length, 0);

    const wm = await db.prepare('SELECT value FROM app_settings WHERE `key` = ?').get(report.PENDING_KEY);
    assert.equal(wm.value, now.toISOString().slice(0, 10), 'watermark is a durable app_settings row');

    const res6 = await report.runPendingInstallationReport(db, fakeEmail(), new Date(now.getTime() + 6 * DAY * 1000));
    assert.equal(res6.ran, false, 'day 6 < 7 -> still skipped');
    const res7 = await report.runPendingInstallationReport(db, fakeEmail(), new Date(now.getTime() + 7 * DAY * 1000));
    assert.equal(res7.ran, true, 'day 7 >= 7 -> fires again');
  });

  await t.test('report: frequency setting is genuinely configurable (two different intervals)', async () => {
    await resetWatermark();

    // interval A: 5 days
    await setFreq(5);
    const t0 = now.getTime();
    assert.equal((await report.runPendingInstallationReport(db, fakeEmail(), new Date(t0))).ran, true, 'first run always fires');
    assert.equal((await report.runPendingInstallationReport(db, fakeEmail(), new Date(t0 + 4 * DAY * 1000))).ran, false, 'day 4 < 5');
    const a = await report.runPendingInstallationReport(db, fakeEmail(), new Date(t0 + 5 * DAY * 1000));
    assert.equal(a.ran, true, 'day 5 >= 5 -> fires');
    assert.equal(a.freqDays, 5);

    // interval B: 2 days — a DIFFERENT cadence, applied with no code change
    await setFreq(2);
    assert.equal((await report.runPendingInstallationReport(db, fakeEmail(), new Date(t0 + 6 * DAY * 1000))).ran, false, 'day 6: 1 day since the day-5 run, < 2');
    const b = await report.runPendingInstallationReport(db, fakeEmail(), new Date(t0 + 7 * DAY * 1000));
    assert.equal(b.ran, true, 'day 7: 2 days since the day-5 run -> fires on the new 2-day cadence');
    assert.equal(b.freqDays, 2);
  });

  await t.test('report: idempotent within an interval + always logs one tick summary', async () => {
    await resetWatermark();
    await setFreq(7);

    const lines = [];
    const orig = console.log;
    console.log = (...x) => { lines.push(x.join(' ')); };
    try {
      await report.runPendingInstallationReports(db, fakeEmail(), { now: now.getTime() }); // fires
      const mail = fakeEmail();
      await report.runPendingInstallationReports(db, mail, { now: now.getTime() });         // idempotent skip
      assert.equal(mail.sent.filter((m) => m.subject.includes(RID)).length, 0, 'no re-send within the interval');
    } finally {
      console.log = orig;
    }
    const ticks = lines.filter((l) => l.startsWith('[pending-installation-report] tick:'));
    assert.equal(ticks.length, 2, 'one tick summary per call');
    assert.match(ticks[0], /tick: sent \d+ \(pdf\+xlsx\)$/);
    assert.equal(ticks[1], '[pending-installation-report] tick: skipped');
  });

  await t.test('real email.js path: unconfigured SMTP still logs a send attempt with the attachment', async () => {
    await resetWatermark();
    await setFreq(7);
    const realEmail = require('../services/email');

    const lines = [];
    const orig = console.log;
    console.log = (...a) => { lines.push(a.join(' ')); orig(...a); };
    try {
      await report.runPendingInstallationReport(db, realEmail, now);
    } finally {
      console.log = orig;
    }
    assert.ok(lines.some((l) => /\[EMAIL\].*Pending installations/.test(l)), 'email.js logged the pending-installation send');
    assert.ok(lines.some((l) => /attachment: pending-installations-.*\.pdf/.test(l)), 'the log records the PDF attachment');
  });
});
