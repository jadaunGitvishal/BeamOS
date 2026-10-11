'use strict';

// #73 email digest robustness. Proves the two rules the design hinges on: (1) the queue
// never balloons when SMTP is off (drain-and-discard); (2) sent_at is stamped ONLY after a
// successful send, so a failure retries next cycle instead of silently dropping. Plus
// recipient resolution (org owner/admins + playlist owner, deduped) and digest grouping.
//
// In-process against the real MySQL test database (beamos_test, via npm test). Seeds one
// org + workspace, its owner / admin / a regional_viewer, a playlist owner, two playlists
// and two agency tokens, all under a per-run prefix, and removes exactly those in after().
// flushAgencyDigests() works on the whole unsent queue, so each test starts by clearing
// this file's own queue rows, and email assertions look only at this file's recipients.

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { db } = require('../db/database');
const { flushAgencyDigests, resolveRecipients } = require('../services/agency-digest');

const RID = 'AD-' + crypto.randomBytes(4).toString('hex');
const id = (s) => `${RID}-${s}`;
const email = (s) => `${RID}-${s}@test.local`;
const TOKENS = [id('tok1'), id('tok2')];

before(async () => {
  for (const u of ['owner', 'admin', 'viewer', 'plowner']) {
    await db.prepare('INSERT INTO users (id, email, name) VALUES (?, ?, ?)').run(id(`u-${u}`), email(u), u);
  }
  await db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run(id('org'), `${RID} Org`, id('u-owner'));
  await db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run(id('ws1'), id('org'), `${RID} WS`);
  await db.prepare('INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, ?)').run(id('org'), id('u-owner'), 'org_owner');
  await db.prepare('INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, ?)').run(id('org'), id('u-admin'), 'org_admin');
  await db.prepare('INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, ?)').run(id('org'), id('u-viewer'), 'regional_viewer');
  await db.prepare('INSERT INTO playlists (id, user_id, workspace_id, name) VALUES (?, ?, ?, ?)').run(id('pl1'), id('u-plowner'), id('ws1'), 'Lobby');
  await db.prepare('INSERT INTO playlists (id, user_id, workspace_id, name) VALUES (?, ?, ?, ?)').run(id('pl2'), id('u-plowner'), id('ws1'), 'Cafe');
  for (const [tok, name] of [[TOKENS[0], 'Acme Agency'], [TOKENS[1], 'Bolt Agency']]) {
    await db.prepare("INSERT INTO api_tokens (id, token_hash, prefix, name, user_id, workspace_id, scope) VALUES (?, ?, ?, ?, ?, ?, 'agency')")
      .run(tok, crypto.randomBytes(32).toString('hex'), 'st_test', name, id('u-admin'), id('ws1'));
  }
});

after(async () => {
  try {
    await db.prepare('DELETE FROM agency_notifications WHERE token_id IN (?, ?)').run(...TOKENS);
    await db.prepare('DELETE FROM api_tokens WHERE id IN (?, ?)').run(...TOKENS);
    await db.prepare('DELETE FROM playlists WHERE id IN (?, ?)').run(id('pl1'), id('pl2'));
    await db.prepare('DELETE FROM organizations WHERE id = ?').run(id('org')); // cascades workspace + members
    await db.prepare('DELETE FROM users WHERE id LIKE ?').run(RID + '-%');
  } finally {
    await db.close();
  }
});

// This file's queue rows only.
beforeEach(async () => {
  await db.prepare('DELETE FROM agency_notifications WHERE token_id IN (?, ?)').run(...TOKENS);
});

async function enqueue(n, action = 'draft', tok = 'tok1', pl = 'pl1') {
  for (let i = 0; i < n; i++) {
    await db.prepare('INSERT INTO agency_notifications (workspace_id, token_id, playlist_id, action) VALUES (?, ?, ?, ?)')
      .run(id('ws1'), id(tok), id(pl), action);
  }
}
const unsent = async () => Number((await db.prepare('SELECT COUNT(*) AS c FROM agency_notifications WHERE token_id IN (?, ?) AND sent_at IS NULL').get(...TOKENS)).c);
const total = async () => Number((await db.prepare('SELECT COUNT(*) AS c FROM agency_notifications WHERE token_id IN (?, ?)').get(...TOKENS)).c);
const cfg = (sendEmail) => ({ isConfigured: () => true, sendEmail });
// Records only mail addressed to this file's users (the flush covers the whole queue).
const sink = () => { const sent = []; return { sent, sendEmail: async (m) => { if (m.to.startsWith(RID + '-')) sent.push(m); } }; };

test('#73 digest recipients: org owner + admins + playlist owner, deduped (NOT the viewer)', async () => {
  const emails = (await resolveRecipients(db, id('ws1'), id('pl1'))).map(r => r.email).sort();
  assert.deepEqual(emails, [email('admin'), email('owner'), email('plowner')]);
});

test('#73 digest: 30 uploads -> ONE email per recipient (not 30), all rows stamped sent', async () => {
  await enqueue(30, 'draft');
  const { sent, sendEmail } = sink();
  await flushAgencyDigests(db, cfg(sendEmail));
  assert.equal(sent.length, 3, '1 group x 3 recipients = 3 emails, not 30 per recipient');
  assert.match(sent[0].subject, /Acme Agency added 30 items to "Lobby"/);
  assert.equal(await unsent(), 0);
});

test('#73 digest: a failed send leaves rows UNSENT for retry (never silently dropped)', async () => {
  await enqueue(5, 'draft');
  await flushAgencyDigests(db, cfg(async () => { throw new Error('smtp down'); }));
  assert.equal(await unsent(), 5, 'still unsent -> retried next cycle');
});

test('#73 digest: SMTP off -> queue drained-and-discarded (never balloons)', async () => {
  await enqueue(10, 'draft');
  await flushAgencyDigests(db, { isConfigured: () => false, sendEmail: async () => { throw new Error('must not send'); } });
  assert.equal(await total(), 0, 'drained when email is off');
});

test('#73 digest: draft vs published produce different subjects, grouped per action', async () => {
  await enqueue(2, 'draft');
  await enqueue(3, 'published');
  // Two tokens x two playlists in the same workspace: one digest per (token, playlist, action).
  await enqueue(1, 'draft', 'tok2', 'pl2');
  await enqueue(4, 'draft', 'tok1', 'pl2');
  await enqueue(1, 'published', 'tok2', 'pl1');
  const { sent, sendEmail } = sink();
  await flushAgencyDigests(db, cfg(sendEmail));
  const subjects = sent.map(s => s.subject);
  assert.ok(subjects.some(s => /awaiting your approval/.test(s)), 'draft digest mentions approval');
  assert.ok(subjects.some(s => /updated "Lobby"/.test(s)), 'published digest says updated');

  // The grouping query ran under MySQL 8's default sql_mode (ONLY_FULL_GROUP_BY) and
  // produced exactly the expected groups, each sent once to its 3 recipients.
  const mode = (await db.prepare('SELECT @@SESSION.sql_mode AS m').get()).m;
  assert.match(mode, /ONLY_FULL_GROUP_BY/);
  const recipients = [email('admin'), email('owner'), email('plowner')];
  const bySubject = new Map();
  for (const m of sent) bySubject.set(m.subject, [...(bySubject.get(m.subject) || []), m.to].sort());
  assert.deepEqual([...bySubject.keys()].sort(), [
    'Acme Agency added 2 items to "Lobby" — awaiting your approval',
    'Acme Agency added 4 items to "Cafe" — awaiting your approval',
    'Acme Agency updated "Lobby"',
    'Bolt Agency added 1 item to "Cafe" — awaiting your approval',
    'Bolt Agency updated "Lobby"',
  ]);
  for (const to of bySubject.values()) assert.deepEqual(to, recipients);
  assert.equal(await unsent(), 0, 'every group stamped sent');
});
