'use strict';

// services/activity.js: logActivity resolves true/false (and never rejects), the optional
// organizationId fills activity_log.organization_id (stored, not hashed - the chain still
// verifies), and auditOrWarn prints the fixed "[audit] NOT AUDITED" marker - ids only -
// when the write fails.
//
// Real MySQL test DB (beamos_test via npm test). The user and org are test-owned and
// removed afterwards (the org deletion nulls organization_id on its audit rows, which is
// exactly why that column is outside the hash). The audit rows stay: deleting them
// would break the hash chain, and the runner recreates beamos_test on every run.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { db } = require('../db/database');
const { logActivity, auditOrWarn } = require('../services/activity');
const { verifyChain } = require('../lib/activity-chain');
const { randTag, cleanupUser } = require('./helpers/disposable');
const { maxAuditId } = require('./helpers/wait-for-audit');

const P = `AR-${randTag()}`;
let userId;
let orgId;

before(async () => {
  userId = `${P}-user`;
  orgId = crypto.randomUUID();
  await db.prepare("INSERT INTO users (id, email, name, password_hash, auth_provider, role) VALUES (?, ?, ?, 'x', 'local', 'user')")
    .run(userId, `${P.toLowerCase()}@x.local`, P);
  await db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run(orgId, `${P} Org`, userId);
});

after(async () => {
  try {
    await cleanupUser(db, userId);
  } finally {
    await db.close();
  }
});

const rowsSince = (since) => db.prepare(
  'SELECT id, user_id, action, details, workspace_id, organization_id FROM activity_log WHERE id > ? AND action LIKE ? ORDER BY id',
).all(since, `${P}:%`);

// Runs fn with console.error captured; returns the captured lines.
async function captureErrors(fn) {
  const lines = [];
  const orig = console.error;
  console.error = (...a) => lines.push(a.map(String).join(' '));
  try { await fn(); } finally { console.error = orig; }
  return lines;
}

// Makes every audit write fail the way a dropped connection would: appendEntry's
// db.transaction(...)() rejects.
async function withBrokenTransactions(fn) {
  const orig = db.transaction;
  db.transaction = () => async () => { throw new Error('forced: connection lost'); };
  try { return await fn(); } finally { db.transaction = orig; }
}

test('logActivity resolves true once the row is written', async () => {
  const since = await maxAuditId(db);
  const ok = await logActivity(userId, `${P}:ok`, 'written', null, '127.0.0.1', null);
  assert.equal(ok, true);
  const rows = await rowsSince(since);
  assert.deepEqual(rows.map((r) => [r.action, r.details]), [[`${P}:ok`, 'written']]);
});

test('organizationId fills organization_id (existing callers unchanged); the chain over the new rows verifies', async () => {
  const since = await maxAuditId(db);
  assert.equal(await logActivity(userId, `${P}:org`, `org: ${P} Org (${orgId})`, null, null, null, orgId), true);
  assert.equal(await logActivity(userId, `${P}:no-org`, 'six-argument call', null, null, null), true);
  const rows = await rowsSince(since);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].organization_id, orgId, 'the 7th argument lands in organization_id');
  assert.equal(rows[1].organization_id, null, 'a call without it leaves organization_id NULL');

  const report = await verifyChain(db, { startId: rows[0].id, endId: rows[1].id });
  assert.equal(report.ok, true, JSON.stringify(report.failures));
  assert.equal(report.checked, 2);
});

test('a failed write resolves false and never rejects (forced connection failure, and a real FK error)', async () => {
  const since = await maxAuditId(db);
  let ok;
  const lines = await captureErrors(async () => {
    ok = await withBrokenTransactions(() => logActivity(userId, `${P}:broken`, 'x', null, null, null));
  });
  assert.equal(ok, false);
  assert.ok(lines.some((l) => l.includes('Activity log error') && l.includes('forced: connection lost')), lines.join('\n'));

  // A real MySQL error: organization_id has an FK to organizations.
  let fk;
  await captureErrors(async () => {
    fk = await logActivity(userId, `${P}:bad-org`, 'x', null, null, null, `${P}-no-such-org`);
  });
  assert.equal(fk, false);

  // Fire-and-forget callers still never see a rejection.
  await captureErrors(() => assert.doesNotReject(withBrokenTransactions(() => logActivity(userId, `${P}:broken2`, 'x'))));
  assert.deepEqual(await rowsSince(since), [], 'no row was written by the failed calls');
});

test('auditOrWarn: fixed NOT AUDITED marker with action, actor and target only - never the details', async () => {
  const SECRET = `secret-${randTag()}`;
  let ok;
  const lines = await captureErrors(async () => {
    ok = await withBrokenTransactions(() => auditOrWarn({
      userId, action: `${P}:revoke`, details: `token value ${SECRET}`, target: 'tok-123',
    }));
  });
  assert.equal(ok, false);
  const marker = lines.filter((l) => l.startsWith('[audit] NOT AUDITED:'));
  assert.deepEqual(marker, [`[audit] NOT AUDITED: action=${P}:revoke actor=${userId} target=tok-123`]);
  assert.ok(!lines.some((l) => l.includes(SECRET)), 'the details never reach the log');

  // Success: true, a row, no marker.
  const since = await maxAuditId(db);
  let ok2;
  const quiet = await captureErrors(async () => {
    ok2 = await auditOrWarn({ userId, action: `${P}:revoke-ok`, details: 'fine', target: 'tok-456', organizationId: orgId });
  });
  assert.equal(ok2, true);
  assert.deepEqual(quiet, []);
  const rows = await rowsSince(since);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].organization_id, orgId);
});
