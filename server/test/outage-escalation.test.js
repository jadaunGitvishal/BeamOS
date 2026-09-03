'use strict';

// Ref 51 (SLA Dashboard) Step 2+3 — SLA breach escalation emails.
//
// In-memory sqlite swapped in for ../db/database; a fake sendEmail records calls.
// Covers: one alert per breach, idempotency (outage_escalations UNIQUE key), a
// recover-then-rebreak producing a FRESH alert for the new incident, recipient
// targeting (workspace_admin only), the below-threshold and no-recipient cases.

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

process.env.JWT_SECRET = 'test-secret-outage-escalation';

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE users (
    id TEXT PRIMARY KEY, email TEXT UNIQUE, name TEXT DEFAULT '',
    role TEXT NOT NULL DEFAULT 'user'
  );
  CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_user_id TEXT NOT NULL);
  CREATE TABLE organization_members (id INTEGER PRIMARY KEY AUTOINCREMENT, organization_id TEXT, user_id TEXT, role TEXT);
  CREATE TABLE workspaces (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, name TEXT NOT NULL);
  CREATE TABLE workspace_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, user_id TEXT NOT NULL,
    role TEXT NOT NULL, joined_at INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE devices (
    id TEXT PRIMARY KEY, workspace_id TEXT, name TEXT DEFAULT '', status TEXT DEFAULT 'offline'
  );
  CREATE TABLE device_status_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL, status TEXT NOT NULL, timestamp INTEGER NOT NULL
  );
  CREATE TABLE app_settings (\`key\` TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER DEFAULT 0);
  CREATE TABLE outage_escalations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
    outage_start INTEGER NOT NULL, alerted_at INTEGER NOT NULL DEFAULT 0, recipient_email TEXT NOT NULL,
    UNIQUE (device_id, outage_start)
  );
  -- Phase 4 Stage B: the escalation tick now also drives the SLA-breach ticket
  -- sweep off the same detector pass. Present so that path runs clean here;
  -- sla-breach-ticket.test.js is where its behaviour is exercised in depth.
  CREATE TABLE tickets (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, device_id TEXT,
    title TEXT NOT NULL, description TEXT, owner_category TEXT NOT NULL DEFAULT 'unassigned',
    status TEXT NOT NULL DEFAULT 'open', priority TEXT NOT NULL DEFAULT 'medium',
    created_by TEXT, auto_source TEXT, source_outage_start INTEGER,
    created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0, resolved_at INTEGER,
    UNIQUE (device_id, source_outage_start)
  );
`);

const dbModulePath = require.resolve('../db/database');
require.cache[dbModulePath] = { id: dbModulePath, filename: dbModulePath, loaded: true, exports: { db } };

const { runOutageEscalations } = require('../services/outage-escalation');

// --- fixtures ------------------------------------------------------------
db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES ('org', 'Org', 'u-admin')").run();
db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES ('ws', 'org', 'Lobby WS')").run();
db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES ('ws-other', 'org', 'Other WS')").run();
db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES ('ws-empty', 'org', 'No Admins WS')").run();

const user = (id, email) =>
  db.prepare("INSERT INTO users (id, email, name, role) VALUES (?, ?, ?, 'user')").run(id, email, id);
user('u-admin', 'admin@corp.test');
user('u-admin2', 'admin2@corp.test');
user('u-editor', 'editor@corp.test');
user('u-viewer', 'viewer@corp.test');
user('u-outsider', 'outsider@corp.test'); // workspace_admin, but of ws-other
user('u-editor2', 'editor2@corp.test');

const member = (ws, uid, role) =>
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)").run(ws, uid, role);
member('ws', 'u-admin', 'workspace_admin');
member('ws', 'u-admin2', 'workspace_admin');
member('ws', 'u-editor', 'workspace_editor');
member('ws', 'u-viewer', 'workspace_viewer');
member('ws-other', 'u-outsider', 'workspace_admin'); // admin of a DIFFERENT ws
member('ws-empty', 'u-editor2', 'workspace_editor'); // ws-empty has a member but NO admin

db.prepare("INSERT INTO devices (id, workspace_id, name) VALUES ('dev1', 'ws', 'Front Lobby Screen')").run();
db.prepare("INSERT INTO devices (id, workspace_id, name) VALUES ('dev-short', 'ws', 'Break Room')").run();
db.prepare("INSERT INTO devices (id, workspace_id, name) VALUES ('dev-noadmin', 'ws-empty', 'Orphan Screen')").run();

const H = 3600;
const NOW = 1_800_000_000; // fixed clock (seconds) for every run
const log = (device, status, agoH) =>
  db.prepare("INSERT INTO device_status_log (device_id, status, timestamp) VALUES (?, ?, ?)").run(device, status, NOW - agoH * H);

// dev1: online 10h ago, offline 9h ago, still offline -> 9h outage, past the 4h threshold
log('dev1', 'online', 10);
log('dev1', 'offline', 9);
// dev-short: offline only 2h -> under threshold, must NOT escalate
log('dev-short', 'online', 5);
log('dev-short', 'offline', 2);
// dev-noadmin: 8h outage in a workspace with no workspace_admin
log('dev-noadmin', 'online', 12);
log('dev-noadmin', 'offline', 8);

const calls = [];
const fakeSend = async (m) => { calls.push(m); return { sent: false, reason: 'test' }; };
const run = () =>
  runOutageEscalations(db, { now: NOW * 1000, thresholdHours: 4, sendEmail: fakeSend });

const rowCount = () => db.prepare('SELECT COUNT(*) AS n FROM outage_escalations').get().n;

test('first tick: exactly one alert fires for the breaching device, emailed to both workspace_admins', async () => {
  calls.length = 0;
  const r = await run();
  assert.equal(r.breaching, 2, 'dev1 (9h) and dev-noadmin (8h) are past threshold; dev-short (2h) is not');
  assert.equal(r.sent, 1, 'only dev1 has a workspace_admin to alert');
  assert.equal(r.skipped, 0);
  assert.equal(r.noRecipients, 1, 'dev-noadmin: past threshold but no workspace_admin');

  // Phase 4 Stage B: the same tick opens a ticket for BOTH breaches (ticket
  // creation, unlike email, does not need a workspace_admin).
  assert.equal(r.autoTickets.created, 2, 'a ticket for dev1 and for dev-noadmin');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM tickets WHERE auto_source = 'sla_breach'").get().n, 2);

  // one escalation row for dev1's outage_start
  assert.equal(rowCount(), 1);
  const row = db.prepare("SELECT * FROM outage_escalations WHERE device_id = 'dev1'").get();
  assert.equal(row.outage_start, NOW - 9 * H);
  assert.equal(row.workspace_id, 'ws');
  assert.equal(row.recipient_email, 'admin@corp.test, admin2@corp.test');

  // emailed to BOTH admins, nobody else
  const to = calls.map((c) => c.to).sort();
  assert.deepEqual(to, ['admin2@corp.test', 'admin@corp.test'].sort());
  assert.match(calls[0].subject, /^SLA Breach: Front Lobby Screen offline for 9h$/);
  assert.match(calls[0].text, /past the 4h SLA escalation threshold/);
  assert.match(calls[0].text, /\/dashboard#\/device\/dev1/);
  assert.ok(calls[0].html && calls[0].html.includes('Front Lobby Screen'));
});

test('recipient targeting: workspace_editor / workspace_viewer / non-members are never emailed', async () => {
  const everyRecipient = calls.map((c) => c.to);
  for (const bad of ['editor@corp.test', 'viewer@corp.test', 'outsider@corp.test']) {
    assert.ok(!everyRecipient.includes(bad), `${bad} must not be emailed`);
  }
});

test('second tick, same clock: idempotent — zero new alerts, no duplicate row', async () => {
  calls.length = 0;
  const r = await run();
  assert.equal(r.sent, 0);
  assert.equal(r.skipped, 1, 'dev1 already escalated');
  assert.equal(calls.length, 0, 'no email sent');
  assert.equal(rowCount(), 1, 'still exactly one escalation row');
});

test('recover then re-break: a NEW outage_start produces a FRESH alert', async () => {
  // dev1 comes back online 7h ago, then breaks again 6h ago (still past the 4h threshold)
  log('dev1', 'online', 7);
  log('dev1', 'offline', 6);

  calls.length = 0;
  const r = await run();
  assert.equal(r.sent, 1, 'the new incident escalates');
  assert.equal(r.skipped, 0, 'the old outage_start is now a completed outage, not re-considered');
  assert.equal(rowCount(), 2, 'a second escalation row for the new outage_start');

  const starts = db
    .prepare("SELECT outage_start FROM outage_escalations WHERE device_id = 'dev1' ORDER BY outage_start")
    .all()
    .map((x) => x.outage_start);
  assert.deepEqual(starts, [NOW - 9 * H, NOW - 6 * H]);
  assert.deepEqual(calls.map((c) => c.to).sort(), ['admin2@corp.test', 'admin@corp.test'].sort());
  assert.match(calls[0].subject, /offline for 6h$/);
});

test('below-threshold ongoing outage is never escalated', async () => {
  assert.equal(rowCount(), 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM outage_escalations WHERE device_id = 'dev-short'").get().n, 0);
});

test('no workspace_admin: not claimed, not emailed, counted — so a later tick can still alert', async () => {
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM outage_escalations WHERE device_id = 'dev-noadmin'").get().n, 0);
  // add an admin to ws-empty; next tick should now escalate the still-ongoing outage
  member('ws-empty', 'u-admin', 'workspace_admin');
  calls.length = 0;
  const r = await run();
  assert.equal(r.sent, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM outage_escalations WHERE device_id = 'dev-noadmin'").get().n, 1);
  assert.deepEqual(calls.map((c) => c.to), ['admin@corp.test']);
});

test('app_settings threshold override is honoured when opts.thresholdHours is not passed', async () => {
  const appSettings = require('../lib/app-settings');
  db.prepare("INSERT INTO app_settings (\`key\`, value) VALUES ('sla_escalation_threshold_hours', '99')").run();
  await appSettings.__reload();
  calls.length = 0;
  // with a 99h threshold nothing (max ~9h here) is a breach
  const r = await runOutageEscalations(db, { now: NOW * 1000, sendEmail: fakeSend });
  assert.equal(r.breaching, 0);
  assert.equal(calls.length, 0);
  db.prepare("DELETE FROM app_settings").run();
  await appSettings.__reload();
});
