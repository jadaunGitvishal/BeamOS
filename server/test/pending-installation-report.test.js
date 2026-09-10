'use strict';

// Ref 48 (pending installation follow-up reporting).
//   Stage A — lib/pending-installations.js + services/pending-installation-report.js
//   Stage B — the live dashboard endpoint + the admin cadence control (the
//             describe block near the bottom).
//
// One file on purpose (same reasoning as reconciliation.test.js): Stage A and
// Stage B both mutate the platform-wide `pending_installation_report_frequency_days`
// app_settings row, so they must run in the same process — node --test
// parallelises across files, not within one.
//
// In-process against the real MySQL. Stage A seeds a registration_codes matrix
// that exercises every branch:
//   fresh          - unused, cut inside the grace period            -> NOT flagged
//   pending        - unused, past the grace period, not expired     -> pending
//   pending (installer) - same, created by a NON-admin user         -> pending; that
//                    creator must still receive the report
//   abandoned      - unused, past its 30-day expiry                 -> abandoned
//   claimed        - a device activated against it                  -> NOT flagged
//   other workspace- a pending code in WS2                          -> only in WS2's report
//   no recipients  - a pending code in WS3 (no admin, creator has no email)

const { test, describe, before, after } = require('node:test');
const express = require('express');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');

const { generateToken, requireAuth } = require('../middleware/auth');
const { resolveTenancy } = require('../lib/tenancy');
const appSettings = require('../lib/app-settings');
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

before(async () => {
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

  await db.prepare(
    'INSERT INTO devices (id, workspace_id, name, status, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id('dev-claimed'), id('ws1'), `${RID} Activated`, 'online', nowSec - 5 * DAY);

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
  await code('fresh', id('ws1'), `${RID} Fresh Lobby TV`, 'unused', 1, 29, id('u-admin1'));             // within 3d grace
  await code('pending', id('ws1'), `${RID} Pending Reception`, 'unused', 10, 20, id('u-admin1'));        // pending
  await code('pending-inst', id('ws1'), `${RID} Pending Warehouse`, 'unused', 6, 24, id('u-installer')); // pending, non-admin creator
  await code('unnamed', id('ws1'), null, 'unused', 8, 22, id('u-installer'));                            // pending, no planned name
  await code('abandoned', id('ws1'), `${RID} Abandoned Dock`, 'unused', 40, -10, id('u-admin1'));        // expired unclaimed
  await code('claimed', id('ws1'), `${RID} Activated`, 'claimed', 12, 18, id('u-admin1'), id('dev-claimed')); // succeeded

  // --- WS2: one pending code, its own admin ---
  await code('ws2', id('ws2'), `${RID} WS2 Pending`, 'unused', 9, 21, id('u-admin2'));

  // --- WS3: a pending code but nobody reachable to notify ---
  await code('ws3', id('ws3'), `${RID} WS3 Pending`, 'unused', 9, 21, id('u-noemail'));

  await db.prepare('DELETE FROM app_settings WHERE `key` = ?').run(report.PENDING_KEY);
  await db.prepare('INSERT INTO app_settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)').run(report.FREQ_KEY, '7');
});

after(async () => {
  const codeIds = Object.keys(CODES).map((k) => id('rc-' + k));
  await db.prepare(`DELETE FROM registration_codes WHERE id IN (${codeIds.map(() => '?').join(',')})`).run(...codeIds);
  await db.prepare('DELETE FROM devices WHERE id = ?').run(id('dev-claimed'));
  await db.prepare('DELETE FROM organizations WHERE id = ?').run(id('org')); // cascades workspaces + members
  await db.prepare('UPDATE activity_log SET user_id = NULL WHERE user_id LIKE ?').run(RID + '-%');
  await db.prepare('DELETE FROM users WHERE id LIKE ?').run(RID + '-%');
  await db.prepare('DELETE FROM app_settings WHERE `key` = ?').run(report.PENDING_KEY);
  await db.prepare('INSERT INTO app_settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)').run(report.FREQ_KEY, '7');
  // db.close() is the very last hook in this file (after the Stage B block).
});

// ---- helpers ----------------------------------------------------------
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

// ---- lib -------------------------------------------------------------

test('getPendingInstallations: flags pending + abandoned, ignores fresh / claimed / other-workspace', async () => {
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

  assert.ok(r.abandoned[0].days_until_expiry <= 0, 'abandoned code is already past expiry');
});

test('getPendingInstallations: graceDays override changes the cutoff', async () => {
  const wide = await getPendingInstallations(db, { workspaceId: id('ws1'), now, graceDays: 0 });
  assert.ok(wide.pending.map((p) => p.code).includes(CODES.fresh), 'grace 0 pulls in the 1-day-old code');

  const narrow = await getPendingInstallations(db, { workspaceId: id('ws1'), now, graceDays: 9 });
  const codes = narrow.pending.map((p) => p.code);
  assert.ok(codes.includes(CODES.pending), '10d-old code still past a 9d grace');
  assert.ok(!codes.includes(CODES['pending-inst']), '6d-old code no longer past a 9d grace');
});

// ---- delivery ------------------------------------------------------

test('report: PDF + XLSX per workspace with findings, to admins AND code creators', async () => {
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
  assert.equal(mine.filter((m) => m.to === email('installer')).length, 1, 'installer gets exactly one email (deduped)');

  const m = byTo.get(email('admin1'));
  assert.match(m.subject, new RegExp(`Pending installations .* ${RID} WS One`));
  assert.equal(m.attachments.length, 2);
  const pdfAtt = m.attachments.find((a) => a.filename.endsWith('.pdf'));
  const xlsxAtt = m.attachments.find((a) => a.filename.endsWith('.xlsx'));
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

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(xlsxAtt.content);
  assert.equal(wb.worksheets.length, 2);
  assert.deepEqual(wb.worksheets[0].getRow(1).values.slice(1), ['Code', 'Planned Device', 'Pending For', 'Expires', 'Time Left']);
  assert.deepEqual(wb.worksheets[1].getRow(1).values.slice(1), ['Code', 'Planned Device', 'Generated', 'Expired']);
  const pendingCol = [];
  wb.worksheets[0].eachRow((row, n) => { if (n > 1) pendingCol.push(String(row.getCell(1).value)); });
  assert.ok(pendingCol.includes(CODES.pending) && pendingCol.includes(CODES['pending-inst']));
  assert.ok(!pendingCol.includes(CODES.fresh));

  assert.match(m.text, /3 installation\(s\) are still pending/);
  assert.match(m.text, /1 code\(s\) expired without ever being activated/);
  assert.match(m.text, new RegExp(`code ${CODES.pending} .*left to act`));
  assert.match(m.text, /runs every 7 day\(s\)/);

  const m2pdf = pdfTextOf(byTo.get(email('admin2')).attachments.find((a) => a.filename.endsWith('.pdf')).content);
  assert.match(m2pdf, new RegExp(CODES.ws2));
  assert.ok(!m2pdf.includes(CODES.pending), "WS2's report does not leak WS1 codes");
});

test('report: nothing due until the configured interval elapses; watermark persisted + restart-safe', async () => {
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

test('report: frequency setting is genuinely configurable (two different intervals)', async () => {
  await resetWatermark();

  await setFreq(5);
  const t0 = now.getTime();
  assert.equal((await report.runPendingInstallationReport(db, fakeEmail(), new Date(t0))).ran, true, 'first run always fires');
  assert.equal((await report.runPendingInstallationReport(db, fakeEmail(), new Date(t0 + 4 * DAY * 1000))).ran, false, 'day 4 < 5');
  const a = await report.runPendingInstallationReport(db, fakeEmail(), new Date(t0 + 5 * DAY * 1000));
  assert.equal(a.ran, true, 'day 5 >= 5 -> fires');
  assert.equal(a.freqDays, 5);

  await setFreq(2);
  assert.equal((await report.runPendingInstallationReport(db, fakeEmail(), new Date(t0 + 6 * DAY * 1000))).ran, false, 'day 6: 1 day since the day-5 run, < 2');
  const b = await report.runPendingInstallationReport(db, fakeEmail(), new Date(t0 + 7 * DAY * 1000));
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

test('real email.js path: unconfigured SMTP still logs a send attempt with the attachment', async () => {
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

// ===========================================================================
// Stage B — the live dashboard endpoint + the admin cadence control. Mounts the
// two routers exactly as server.js does (dashboard-reports: requireAuth +
// resolveTenancy; admin: requireAuth only) and drives them over HTTP with real
// JWTs. Its own fixtures under a 'PB-' prefix; runs after the Stage A tests
// above (same process, sequential).
// ===========================================================================
describe('Ref 48 Stage B — live pending-installations endpoint + admin cadence', () => {
  const RID = 'PB-' + crypto.randomBytes(4).toString('hex');
  const id = (s) => `${RID}-${s}`;
  const nowSec = Math.floor(Date.now() / 1000);
  let seq = 200000 + crypto.randomInt(700000);
  const nextCode = () => String(seq++);
  const C = {};

  let base, server;

  before(async () => {
    await db.prepare('INSERT INTO users (id, email, name, role) VALUES (?, ?, ?, ?)').run(id('u-viewer'), id('viewer') + '@t.test', 'WS1 Viewer', 'user');
    await db.prepare('INSERT INTO users (id, email, name, role) VALUES (?, ?, ?, ?)').run(id('u-admin1'), id('admin1') + '@t.test', 'WS1 Admin', 'user');
    await db.prepare('INSERT INTO users (id, email, name, role) VALUES (?, ?, ?, ?)').run(id('u-admin2'), id('admin2') + '@t.test', 'WS2 Admin', 'user');
    await db.prepare('INSERT INTO users (id, email, name, role) VALUES (?, ?, ?, ?)').run(id('u-plat'), id('plat') + '@t.test', 'Platform Admin', 'platform_admin');
    await db.prepare('INSERT INTO users (id, email, name, role) VALUES (?, ?, ?, ?)').run(id('u-nows'), id('nows') + '@t.test', 'No Workspace', 'user');

    await db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run(id('org'), `${RID} Org`, id('u-admin1'));
    await db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run(id('ws1'), id('org'), `${RID} WS One`);
    await db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run(id('ws2'), id('org'), `${RID} WS Two`);
    await db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run(id('ws3'), id('org'), `${RID} WS Three`);
    await db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)').run(id('ws1'), id('u-viewer'), 'workspace_viewer');
    await db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)').run(id('ws1'), id('u-admin1'), 'workspace_admin');
    await db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)').run(id('ws2'), id('u-admin2'), 'workspace_admin');
    await db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)').run(id('ws3'), id('u-admin1'), 'workspace_admin');

    const code = (key, ws, name, status, createdAgoD, expiresInD, createdBy) => {
      const c = nextCode();
      C[key] = c;
      return db.prepare(
        `INSERT INTO registration_codes (id, code, workspace_id, planned_device_name, status, created_by, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id('rc-' + key), c, ws, name, status, createdBy,
        nowSec - Math.round(createdAgoD * DAY),
        expiresInD == null ? null : nowSec + Math.round(expiresInD * DAY));
    };

    // WS1: 1 pending (~10d), 1 abandoned, 1 fresh (in grace), 1 claimed  -> counts {1,1}
    await code('pending', id('ws1'), `${RID} Pending`, 'unused', 10, 20, id('u-admin1'));
    await code('abandoned', id('ws1'), `${RID} Abandoned`, 'unused', 40, -10, id('u-admin1'));
    await code('fresh', id('ws1'), `${RID} Fresh`, 'unused', 1, 29, id('u-admin1'));
    await code('claimed', id('ws1'), `${RID} Claimed`, 'claimed', 12, 18, id('u-admin1'));
    // WS2: 2 pending
    await code('ws2a', id('ws2'), `${RID} WS2 A`, 'unused', 8, 22, id('u-admin2'));
    await code('ws2b', id('ws2'), `${RID} WS2 B`, 'unused', 9, 21, id('u-admin2'));
    // WS3: one claimed code only, nothing flagged -> the "all clear" (has used codes) case
    await code('ws3ok', id('ws3'), `${RID} WS3 OK`, 'claimed', 20, 10, id('u-admin1'));

    await db.prepare('DELETE FROM app_settings WHERE `key` IN (?, ?)').run(report.PENDING_KEY, report.FREQ_KEY);
    await db.prepare('INSERT INTO app_settings (`key`, value) VALUES (?, ?)').run(report.FREQ_KEY, '7');
    await appSettings.__reload();

    const app = express();
    app.use(express.json());
    app.use('/api/dashboard/reports', requireAuth, resolveTenancy, require('../routes/dashboard-reports'));
    app.use('/api/admin', requireAuth, require('../routes/admin'));
    app.use((err, req, res, _next) => { res.status(500).json({ error: err.message, stack: err.stack }); });
    server = app.listen(0);
    await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((r) => server.close(r));
    const codeIds = Object.keys(C).map((k) => id('rc-' + k));
    await db.prepare(`DELETE FROM registration_codes WHERE id IN (${codeIds.map(() => '?').join(',')})`).run(...codeIds);
    await db.prepare('DELETE FROM organizations WHERE id = ?').run(id('org'));
    await db.prepare('UPDATE activity_log SET user_id = NULL WHERE user_id LIKE ?').run(RID + '-%');
    await db.prepare('DELETE FROM users WHERE id LIKE ?').run(RID + '-%');
    await db.prepare('DELETE FROM app_settings WHERE `key` = ?').run(report.PENDING_KEY);
    await db.prepare('INSERT INTO app_settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)').run(report.FREQ_KEY, '7');
    await appSettings.__reload();
  });

  const tok = (userKey, wsKey) =>
    generateToken({ id: id(userKey), email: id(userKey) + '@t.test', role: userKey === 'u-plat' ? 'platform_admin' : 'user' }, wsKey ? id(wsKey) : null);
  const GET = (p, token) => fetch(`${base}${p}`, { headers: { Authorization: `Bearer ${token}` } });
  const PUT = (p, token, body) =>
    fetch(`${base}${p}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });

  test('GET /pending-installations: a workspace_viewer sees pending + abandoned, not fresh / claimed', async () => {
    const res = await GET('/api/dashboard/reports/pending-installations', tok('u-viewer', 'ws1'));
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.counts.pending, 1);
    assert.equal(body.counts.abandoned, 1);
    assert.equal(body.counts.total, 2);
    assert.equal(body.code_count, 4, 'every registration_codes row in the workspace, any status');

    assert.deepEqual(body.pending.map((p) => p.code), [C.pending]);
    assert.deepEqual(body.abandoned.map((a) => a.code), [C.abandoned]);
    assert.ok(!JSON.stringify(body).includes(C.fresh), 'fresh (in-grace) code absent');
    assert.ok(!JSON.stringify(body).includes(C.claimed), 'claimed code absent');

    const p = body.pending[0];
    assert.ok(p.days_pending >= 9 && p.days_pending <= 11, `~10 (got ${p.days_pending})`);
    assert.ok(p.days_until_expiry >= 19 && p.days_until_expiry <= 21);
    assert.equal(body.grace_days, 3);
    assert.equal(body.frequency_days, 7);
  });

  test('GET /pending-installations: workspace-scoped — WS2 member sees only WS2 codes', async () => {
    const body = await (await GET('/api/dashboard/reports/pending-installations', tok('u-admin2', 'ws2'))).json();
    assert.equal(body.counts.pending, 2);
    assert.equal(body.counts.abandoned, 0);
    assert.deepEqual(body.pending.map((p) => p.code).sort(), [C.ws2a, C.ws2b].sort());
    assert.ok(!JSON.stringify(body).includes('WS One'));
  });

  test('GET /pending-installations: codes exist but none flagged -> total 0, code_count > 0 ("all clear")', async () => {
    const body = await (await GET('/api/dashboard/reports/pending-installations', tok('u-admin1', 'ws3'))).json();
    assert.deepEqual(body.counts, { pending: 0, abandoned: 0, total: 0 });
    assert.equal(body.code_count, 1, 'the claimed code still counts — the UI shows "all clear", not "never used codes"');
  });

  test('GET /pending-installations: no workspace -> empty payload, still 200', async () => {
    const res = await GET('/api/dashboard/reports/pending-installations', tok('u-nows', null));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.counts, { pending: 0, abandoned: 0, total: 0 });
    assert.deepEqual(body.pending, []);
    assert.equal(body.code_count, 0);
    assert.equal(body.frequency_days, 7, 'the platform-wide cadence is still reported');
  });

  test('GET /pending-installations: next_report_date reflects the watermark + frequency', async () => {
    let body = await (await GET('/api/dashboard/reports/pending-installations', tok('u-viewer', 'ws1'))).json();
    assert.equal(body.last_report_date, null);
    assert.equal(body.next_report_date, null);

    const ranOn = new Date((nowSec - 3 * DAY) * 1000).toISOString().slice(0, 10);
    await db.prepare('INSERT INTO app_settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)').run(report.PENDING_KEY, ranOn);
    body = await (await GET('/api/dashboard/reports/pending-installations', tok('u-viewer', 'ws1'))).json();
    assert.equal(body.last_report_date, ranOn);
    const expectNext = new Date(Date.parse(ranOn + 'T00:00:00Z') + 7 * DAY * 1000).toISOString().slice(0, 10);
    assert.equal(body.next_report_date, expectNext);
    assert.equal(body.overdue, false);
  });

  test('GET /admin/pending-installation-frequency: platform admin only', async () => {
    assert.equal((await GET('/api/admin/pending-installation-frequency', tok('u-viewer', 'ws1'))).status, 403);
    const res = await GET('/api/admin/pending-installation-frequency', tok('u-plat', null));
    assert.equal(res.status, 200);
    assert.equal((await res.json()).frequency_days, 7);
  });

  test('PUT /admin/pending-installation-frequency: admin changes it; workspace_admin 403; bad value 400', async () => {
    // RBAC from the API side: a workspace_admin token is independently rejected,
    // not just hidden in the UI.
    assert.equal((await PUT('/api/admin/pending-installation-frequency', tok('u-admin1', 'ws1'), { frequency_days: 3 })).status, 403,
      'a workspace_admin is not a platform admin');

    for (const bad of [0, -2, 400, 'weekly', null]) {
      const r = await PUT('/api/admin/pending-installation-frequency', tok('u-plat', null), { frequency_days: bad });
      assert.equal(r.status, 400, `rejects ${JSON.stringify(bad)}`);
    }

    const ok = await PUT('/api/admin/pending-installation-frequency', tok('u-plat', null), { frequency_days: 21 });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).frequency_days, 21);

    const logged = await db
      .prepare("SELECT COUNT(*) AS c FROM activity_log WHERE user_id = ? AND action = 'admin_set_pending_installation_frequency'")
      .get(id('u-plat'));
    assert.ok(Number(logged.c) >= 1, 'the change is written to the activity log');
  });

  test('changing the frequency actually moves when the next scheduled report fires (getReportStatus honors it)', async () => {
    const ranOn = (await db.prepare('SELECT value FROM app_settings WHERE `key` = ?').get(report.PENDING_KEY)).value;

    await PUT('/api/admin/pending-installation-frequency', tok('u-plat', null), { frequency_days: 2 });
    let body = await (await GET('/api/dashboard/reports/pending-installations', tok('u-viewer', 'ws1'))).json();
    assert.equal(body.frequency_days, 2);
    assert.equal(body.overdue, true, 'a shorter cadence makes an already-old report due now');
    const next2 = new Date(Date.parse(ranOn + 'T00:00:00Z') + 2 * DAY * 1000).toISOString().slice(0, 10);
    assert.equal(body.next_report_date, next2);

    await PUT('/api/admin/pending-installation-frequency', tok('u-plat', null), { frequency_days: 30 });
    body = await (await GET('/api/dashboard/reports/pending-installations', tok('u-viewer', 'ws1'))).json();
    assert.equal(body.frequency_days, 30);
    assert.equal(body.overdue, false, 'a longer cadence pushes the next send back out');

    // The scheduler core itself (not just the endpoint) sees the new value.
    const st = await report.getReportStatus(db);
    assert.equal(st.frequency_days, 30);
    const next30 = new Date(Date.parse(ranOn + 'T00:00:00Z') + 30 * DAY * 1000).toISOString().slice(0, 10);
    assert.equal(st.next_report_date, next30);
  });
});

// db.close() last — after both the Stage A hooks and the Stage B describe block.
after(async () => {
  await db.close();
});
