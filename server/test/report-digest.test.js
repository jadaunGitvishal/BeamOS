'use strict';

// Ref 46: daily / monthly automated proof-of-play reports.
//
// In-process against the real MySQL (like the other integration tests). Seeds one org
// with two workspaces, a workspace_admin per workspace, an org_owner, a non-admin
// member, and play_logs dated into "yesterday" and "last month". Then drives the
// report-digest core and asserts recipients, PDF validity, and idempotency.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { db } = require('../db/database');
const digest = require('../services/report-digest');

const RID = 'RD-' + crypto.randomBytes(4).toString('hex');
const id = (s) => `${RID}-${s}`;
const email = (s) => `${RID}-${s}@test.local`;

// epochs firmly inside yesterday / last month (UTC)
const now = new Date();
const yesterday = new Date(now.getTime() - 86400_000);
const yStart = Math.floor(Date.parse(yesterday.toISOString().slice(0, 10) + 'T12:00:00Z') / 1000);
const lastMonthMid = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15, 12) / 1000;

before(async () => {
  await db.prepare('INSERT INTO users (id, email, name) VALUES (?, ?, ?)').run(id('u-wsadmin1'), email('wsadmin1'), 'WS Admin One');
  await db.prepare('INSERT INTO users (id, email, name) VALUES (?, ?, ?)').run(id('u-wsadmin2'), email('wsadmin2'), 'WS Admin Two');
  await db.prepare('INSERT INTO users (id, email, name) VALUES (?, ?, ?)').run(id('u-viewer'), email('viewer'), 'WS Viewer');
  await db.prepare('INSERT INTO users (id, email, name) VALUES (?, ?, ?)').run(id('u-owner'), email('owner'), 'Org Owner');

  await db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run(id('org'), `${RID} Org`, id('u-owner'));
  await db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run(id('ws1'), id('org'), `${RID} WS One`);
  await db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run(id('ws2'), id('org'), `${RID} WS Two`);

  await db.prepare('INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, ?)').run(id('org'), id('u-owner'), 'org_owner');
  await db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)').run(id('ws1'), id('u-wsadmin1'), 'workspace_admin');
  await db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)').run(id('ws1'), id('u-viewer'), 'workspace_viewer');
  await db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)').run(id('ws2'), id('u-wsadmin2'), 'workspace_admin');

  await db.prepare('INSERT INTO devices (id, workspace_id, name) VALUES (?, ?, ?)').run(id('d1'), id('ws1'), `${RID} Device 1`);
  await db.prepare('INSERT INTO devices (id, workspace_id, name) VALUES (?, ?, ?)').run(id('d2'), id('ws2'), `${RID} Device 2`);

  // content_id left NULL (FK to content); the summary groups by (content_id, content_name)
  // so grouping still works by name.
  const play = (dev, at, name, dur, done) =>
    db.prepare('INSERT INTO play_logs (device_id, content_name, started_at, ended_at, duration_sec, completed) VALUES (?, ?, ?, ?, ?, ?)')
      .run(dev, name, at, at + dur, dur, done);

  // yesterday: ws1 device gets 3 plays, ws2 device gets 2
  await play(id('d1'), yStart, 'Promo A', 30, 1);
  await play(id('d1'), yStart + 60, 'Promo A', 30, 1);
  await play(id('d1'), yStart + 120, 'Promo B', 15, 0);
  await play(id('d2'), yStart + 200, 'Promo C', 20, 1);
  await play(id('d2'), yStart + 260, 'Promo C', 20, 1);
  // last month: one play on each device (org rollup should see both)
  await play(id('d1'), lastMonthMid, 'Promo A', 30, 1);
  await play(id('d2'), lastMonthMid + 100, 'Promo C', 20, 1);

  // make sure the watermarks don't short-circuit us
  await db.prepare('DELETE FROM app_settings WHERE `key` IN (?, ?)').run(digest.DAILY_KEY, digest.MONTHLY_KEY);
});

after(async () => {
  await db.prepare('DELETE FROM play_logs WHERE device_id IN (?, ?)').run(id('d1'), id('d2'));
  await db.prepare('DELETE FROM devices WHERE id IN (?, ?)').run(id('d1'), id('d2'));
  await db.prepare('DELETE FROM organizations WHERE id = ?').run(id('org')); // cascades workspaces + members
  await db.prepare('DELETE FROM users WHERE id LIKE ?').run(RID + '-%');
  await db.prepare('DELETE FROM app_settings WHERE `key` IN (?, ?)').run(digest.DAILY_KEY, digest.MONTHLY_KEY);
  await db.close();
});

function fakeEmail() {
  const sent = [];
  return { sent, isConfigured: () => true, sendEmail: async (m) => { sent.push(m); return { sent: true }; } };
}

const isPdf = (buf) => Buffer.isBuffer(buf) && buf.slice(0, 5).toString('latin1') === '%PDF-';

test('daily: one PDF per workspace to that workspace_admin(s); not to non-admins', async () => {
  const mail = fakeEmail();
  const res = await digest.runDailyDigests(db, mail, now);
  assert.equal(res.ran, true);

  const byTo = new Map(mail.sent.map((m) => [m.to, m]));
  assert.ok(byTo.has(email('wsadmin1')), 'WS One admin got an email');
  assert.ok(byTo.has(email('wsadmin2')), 'WS Two admin got an email');
  assert.ok(!byTo.has(email('viewer')), 'workspace_viewer did NOT get one');
  assert.ok(!byTo.has(email('owner')), 'org_owner is not a daily recipient');

  const m1 = byTo.get(email('wsadmin1'));
  assert.match(m1.subject, new RegExp(`Daily proof-of-play .* ${RID} WS One`), 'subject names the workspace');
  assert.equal(m1.attachments.length, 1);
  assert.match(m1.attachments[0].filename, /\.pdf$/);
  assert.equal(m1.attachments[0].contentType, 'application/pdf');
  assert.ok(isPdf(m1.attachments[0].content), 'attachment is a valid PDF (starts with %PDF-)');
  // ws1 had 3 plays yesterday, ws2 not counted here
  assert.match(m1.text, /3 plays across 1 device/);
});

test('monthly: one org-wide roll-up to org_owner(s), across all workspaces in the org', async () => {
  const mail = fakeEmail();
  const res = await digest.runMonthlyRollups(db, mail, now);
  assert.equal(res.ran, true);

  const toOwner = mail.sent.filter((m) => m.to === email('owner'));
  assert.equal(toOwner.length, 1, 'org_owner got exactly one monthly email');
  assert.ok(!mail.sent.some((m) => m.to === email('wsadmin1')), 'workspace_admins are not monthly recipients');

  const m = toOwner[0];
  assert.match(m.subject, new RegExp(`Monthly proof-of-play roll-up .* ${RID} Org`));
  assert.ok(isPdf(m.attachments[0].content), 'monthly attachment is a valid PDF');
  // last month: 1 play on d1 + 1 on d2 = 2 plays across 2 devices (org-wide rollup)
  assert.match(m.text, /2 plays across 2 device/);
});

test('idempotent: a second run with the same clock sends nothing (watermark advanced)', async () => {
  const mail = fakeEmail();
  await digest.runReportDigests(db, mail, { now: now.getTime() });
  assert.equal(mail.sent.length, 0, 'no re-send within the same day/month');
});

test('boundary passed: advancing the clock a day re-triggers the daily digest', async () => {
  const mail = fakeEmail();
  const tomorrow = new Date(now.getTime() + 86400_000);
  const res = await digest.runDailyDigests(db, mail, tomorrow);
  assert.equal(res.ran, true, 'new day boundary -> daily digest runs again');
  assert.ok(mail.sent.length >= 2, 'and re-sends to the workspace admins');
});

test('real email.js path: unconfigured SMTP still makes a logged send attempt with the attachment', async () => {
  const realEmail = require('../services/email');
  await db.prepare('DELETE FROM app_settings WHERE `key` = ?').run(digest.DAILY_KEY);

  const lines = [];
  const orig = console.log;
  console.log = (...a) => { lines.push(a.join(' ')); orig(...a); };
  try {
    await digest.runDailyDigests(db, realEmail, now);
  } finally {
    console.log = orig;
  }

  const emailLines = lines.filter((l) => l.includes('[EMAIL]'));
  assert.ok(
    emailLines.some((l) => /Daily proof-of-play/.test(l)),
    'email.js logged a send attempt for the daily report (isConfigured() false -> stdout fallback)',
  );
  assert.ok(
    lines.some((l) => /attachment: proof-of-play-.*\.pdf/.test(l)),
    'the log records the PDF attachment',
  );
});

// Ref 46 / observability fix: runReportDigests() must emit exactly one
// `[report-digest] tick: ...` summary line on EVERY call, so a healthy "nothing due"
// tick is distinguishable in the logs from a dead / crash-looping service.
function captureRun(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => { lines.push(a.join(' ')); };
  return Promise.resolve()
    .then(fn)
    .finally(() => { console.log = orig; })
    .then(() => lines);
}

test('tick summary: logged as "sent N" on a tick where work happened', async () => {
  await db.prepare('DELETE FROM app_settings WHERE `key` IN (?, ?)').run(digest.DAILY_KEY, digest.MONTHLY_KEY);
  const mail = fakeEmail();

  const lines = await captureRun(() => digest.runReportDigests(db, mail, { now: now.getTime() }));

  const summaries = lines.filter((l) => l.startsWith('[report-digest] tick:'));
  assert.equal(summaries.length, 1, 'exactly one tick summary line');
  assert.match(summaries[0], /^\[report-digest\] tick: daily sent \d+, monthly sent \d+$/);
});

test('tick summary: still logged as "skipped" on a nothing-due tick (watermark caught up)', async () => {
  // First run advances both watermarks to the current targets...
  await db.prepare('DELETE FROM app_settings WHERE `key` IN (?, ?)').run(digest.DAILY_KEY, digest.MONTHLY_KEY);
  await digest.runReportDigests(db, fakeEmail(), { now: now.getTime() });

  // ...so this second run with the same clock has nothing due.
  const mail = fakeEmail();
  const lines = await captureRun(() => digest.runReportDigests(db, mail, { now: now.getTime() }));

  assert.equal(mail.sent.length, 0, 'nothing re-sent');
  const summaries = lines.filter((l) => l.startsWith('[report-digest] tick:'));
  assert.equal(summaries.length, 1, 'the summary line is still emitted when nothing was due');
  assert.equal(summaries[0], '[report-digest] tick: daily skipped, monthly skipped');
});
