'use strict';

// Ref 58 — ticket response-time SLA escalation emails.
//
// In-memory sqlite swapped in for ../db/database; a fake sendEmail records calls.
// Covers: one alert per breached ticket, idempotency (ticket_escalations UNIQUE
// key on ticket_id, permanent - not per-incident), recipient targeting
// (workspace_admin only), the not-yet-breached and no-recipient cases.

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

process.env.JWT_SECRET = 'test-secret-ticket-escalation';

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
  CREATE TABLE app_settings (\`key\` TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER DEFAULT 0);
  CREATE TABLE tickets (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, device_id TEXT,
    title TEXT NOT NULL, description TEXT, owner_category TEXT NOT NULL DEFAULT 'unassigned',
    status TEXT NOT NULL DEFAULT 'open', priority TEXT NOT NULL DEFAULT 'medium',
    ticket_category TEXT NOT NULL DEFAULT 'reactive',
    created_by TEXT, auto_source TEXT, source_outage_start INTEGER,
    created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0, resolved_at INTEGER,
    UNIQUE (device_id, source_outage_start)
  );
  CREATE TABLE ticket_escalations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
    alerted_at INTEGER NOT NULL DEFAULT 0, recipient_email TEXT NOT NULL,
    UNIQUE (ticket_id)
  );
`);

const dbModulePath = require.resolve('../db/database');
require.cache[dbModulePath] = { id: dbModulePath, filename: dbModulePath, loaded: true, exports: { db } };

const { runTicketEscalations } = require('../services/ticket-escalation');

// --- fixtures ------------------------------------------------------------
db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES ('org', 'Org', 'u-admin')").run();
db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES ('ws', 'org', 'Lobby WS')").run();
db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES ('ws-empty', 'org', 'No Admins WS')").run();

const user = (id, email) =>
  db.prepare("INSERT INTO users (id, email, name, role) VALUES (?, ?, ?, 'user')").run(id, email, id);
user('u-admin', 'admin@corp.test');
user('u-admin2', 'admin2@corp.test');
user('u-editor', 'editor@corp.test');
user('u-editor2', 'editor2@corp.test');

const member = (ws, uid, role) =>
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)").run(ws, uid, role);
member('ws', 'u-admin', 'workspace_admin');
member('ws', 'u-admin2', 'workspace_admin');
member('ws', 'u-editor', 'workspace_editor');
member('ws-empty', 'u-editor2', 'workspace_editor'); // ws-empty has a member but NO admin

const H = 3600;
const NOW = 1_800_000_000; // fixed clock (seconds)
// high priority default target is 4h (config.ticketSlaHoursHigh) - a ticket
// older than that is 'breached' per lib/ticket-sla.js.
const ticket = (id, ws, priority, ageH, status = 'open') =>
  db
    .prepare(
      "INSERT INTO tickets (id, workspace_id, title, priority, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(id, ws, `ticket ${id}`, priority, status, NOW - Math.round(ageH * H), NOW - Math.round(ageH * H));

// tk-breach: high priority, 6h old -> past the 4h target -> breached
ticket('tk-breach', 'ws', 'high', 6);
// tk-fresh: high priority, 1h old -> within_sla, must NOT escalate
ticket('tk-fresh', 'ws', 'high', 1);
// tk-noadmin: breached, but its workspace has no workspace_admin
ticket('tk-noadmin', 'ws-empty', 'high', 8);

const fakeSend = async () => ({ sent: false, reason: 'test' });
const tick = () => runTicketEscalations(db, { now: NOW * 1000, sendEmail: fakeSend });

// ---------------------------------------------------------------------

test('first tick: escalates the one breached ticket, correct recipients', async () => {
  const sent = [];
  const r = await runTicketEscalations(db, {
    now: NOW * 1000,
    sendEmail: async (msg) => {
      sent.push(msg);
      return { sent: false, reason: 'test' };
    },
  });
  assert.equal(r.breaching, 2, 'tk-breach and tk-noadmin are both breached');
  assert.equal(r.sent, 1, 'only tk-breach has a recipient');
  assert.equal(r.noRecipients, 1, 'tk-noadmin skipped - no workspace_admin');

  const rows = db.prepare('SELECT * FROM ticket_escalations').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ticket_id, 'tk-breach');
  assert.equal(rows[0].workspace_id, 'ws');

  const recipients = sent.map((m) => m.to).sort();
  assert.deepEqual(recipients, ['admin2@corp.test', 'admin@corp.test']);
  assert.match(sent[0].subject, /^Ticket SLA breach: ticket tk-breach$/);
});

test('a ticket not yet breached never gets escalated', async () => {
  assert.equal(db.prepare("SELECT COUNT(*) n FROM ticket_escalations WHERE ticket_id = 'tk-fresh'").get().n, 0);
});

test('idempotent: many ticks on the same breached ticket -> still exactly one escalation, no re-send', async () => {
  for (let i = 0; i < 3; i++) {
    const r = await tick();
    assert.equal(r.sent, 0, 'already escalated - no new send');
    assert.equal(r.skipped, 1);
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ticket_escalations').get().n, 1);
});

test('no-recipients ticket is not claimed - a later admin add lets it escalate', async () => {
  user('u-lateadmin', 'lateadmin@corp.test');
  member('ws-empty', 'u-lateadmin', 'workspace_admin');

  const sent = [];
  const r = await runTicketEscalations(db, {
    now: NOW * 1000,
    sendEmail: async (msg) => {
      sent.push(msg);
      return { sent: false, reason: 'test' };
    },
  });
  assert.equal(r.sent, 1, 'tk-noadmin now has an admin and escalates');
  assert.equal(sent[0].to, 'lateadmin@corp.test');
});

test('a ticket that leaves breached status (resolved) is left alone by later ticks - already claimed, never re-checked', async () => {
  db.prepare("UPDATE tickets SET status = 'resolved' WHERE id = 'tk-breach'").run();
  const r = await tick();
  // tk-breach no longer counts as "open" at all; tk-fresh and tk-noadmin remain
  assert.equal(r.open, 2, 'tk-fresh and tk-noadmin remain open/in_progress');
  assert.equal(r.sent, 0);
});
