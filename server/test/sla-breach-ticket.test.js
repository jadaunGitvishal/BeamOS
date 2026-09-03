'use strict';

// Phase 4 Stage B — auto-open a ticket on a live SLA breach (services/
// sla-breach-ticket.js), driven from the outage-escalation tick.
//
// In-memory sqlite swapped in for ../db/database. Drives the real
// runOutageEscalations() (fake sendEmail) so the ticket sweep runs off the same
// detectOutages() pass the emails do, and also calls autoCreateBreachTickets()
// directly for the "a human already touched it" case. Covers:
//   - one ticket per breach; fields (owner unassigned, priority high,
//     created_by NULL, auto_source, source_outage_start)
//   - idempotency: same outage, many ticks -> exactly one ticket
//   - recover-then-rebreak -> the old ticket auto-resolves, a FRESH ticket
//     opens for the new outage_start
//   - auto-resolve ONLY while untouched: a human moving it off 'open' freezes it
//   - below-threshold ongoing outage -> no ticket

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

process.env.JWT_SECRET = 'test-secret-sla-breach-ticket';

const db = new Database(':memory:');
db.function('UNIX_TIMESTAMP', () => Math.floor(Date.now() / 1000));
db.exec(`
  CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE, name TEXT DEFAULT '', role TEXT NOT NULL DEFAULT 'user');
  CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_user_id TEXT NOT NULL);
  CREATE TABLE workspaces (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, name TEXT NOT NULL);
  CREATE TABLE workspace_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, user_id TEXT NOT NULL,
    role TEXT NOT NULL, joined_at INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE devices (id TEXT PRIMARY KEY, workspace_id TEXT, name TEXT DEFAULT '', status TEXT DEFAULT 'offline');
  CREATE TABLE device_status_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL, status TEXT NOT NULL, timestamp INTEGER NOT NULL
  );
  CREATE TABLE app_settings (\`key\` TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER DEFAULT 0);
  CREATE TABLE outage_escalations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
    outage_start INTEGER NOT NULL, alerted_at INTEGER NOT NULL DEFAULT 0, recipient_email TEXT NOT NULL,
    UNIQUE (device_id, outage_start)
  );
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
const { autoCreateBreachTickets } = require('../services/sla-breach-ticket');

// --- fixtures ----------------------------------------------------------
db.prepare("INSERT INTO organizations (id,name,owner_user_id) VALUES ('org','Org','u-a')").run();
db.prepare("INSERT INTO workspaces (id,organization_id,name) VALUES ('ws','org','Lobby WS')").run();
db.prepare("INSERT INTO users (id,email,name,role) VALUES ('u-a','a@corp.test','Amy','user')").run();
db.prepare("INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ('ws','u-a','workspace_admin')").run();
db.prepare("INSERT INTO devices (id,workspace_id,name) VALUES ('dev1','ws','Front Lobby Screen')").run();
db.prepare("INSERT INTO devices (id,workspace_id,name) VALUES ('dev-short','ws','Break Room')").run();

const H = 3600;
const NOW = 1_800_000_000;
const log = (device, status, agoH) =>
  db.prepare("INSERT INTO device_status_log (device_id,status,timestamp) VALUES (?,?,?)").run(device, status, NOW - Math.round(agoH * H));

// dev1: offline since 9h ago (past the 4h threshold). dev-short: offline 2h (under).
log('dev1', 'online', 10);
log('dev1', 'offline', 9);
log('dev-short', 'online', 5);
log('dev-short', 'offline', 2);

const fakeSend = async () => ({ sent: false, reason: 'test' });
const tick = () => runOutageEscalations(db, { now: NOW * 1000, thresholdHours: 4, sendEmail: fakeSend });
const tickets = (where = '1=1') => db.prepare(`SELECT * FROM tickets WHERE ${where} ORDER BY source_outage_start`).all();
const count = (where = '1=1') => db.prepare(`SELECT COUNT(*) n FROM tickets WHERE ${where}`).get().n;

// ---------------------------------------------------------------------

test('first tick: one ticket for the breach, correct auto-generated fields', async () => {
  const r = await tick();
  assert.equal(r.autoTickets.created, 1);
  assert.equal(r.autoTickets.resolved, 0);
  assert.equal(count(), 1);

  const t = tickets()[0];
  assert.equal(t.device_id, 'dev1');
  assert.equal(t.workspace_id, 'ws');
  assert.equal(t.status, 'open');
  assert.equal(t.priority, 'high');
  assert.equal(t.owner_category, 'unassigned');
  assert.equal(t.created_by, null, 'system-generated: created_by is NULL');
  assert.equal(t.auto_source, 'sla_breach');
  assert.equal(t.source_outage_start, NOW - 9 * H);
  assert.equal(t.resolved_at, null);
  assert.match(t.title, /^SLA breach: Front Lobby Screen offline 9h$/);
  assert.match(t.description, /offline since .* past the SLA breach threshold/s);
});

test('below-threshold ongoing outage never gets a ticket', async () => {
  assert.equal(count("device_id = 'dev-short'"), 0);
});

test('idempotent: many ticks on the same ongoing outage -> still exactly one ticket', async () => {
  for (let i = 0; i < 4; i++) {
    const r = await tick();
    assert.equal(r.autoTickets.created, 0);
    assert.equal(r.autoTickets.skipped, 1);
  }
  assert.equal(count(), 1);
});

test('recover then re-break: old ticket auto-resolves, a fresh ticket opens for the new outage', async () => {
  // dev1 recovers 7h ago, breaks again 6h ago (still past the 4h threshold)
  log('dev1', 'online', 7);
  log('dev1', 'offline', 6);

  const r = await tick();
  assert.equal(r.autoTickets.resolved, 1, 'the ticket for the -9h outage auto-resolves on recovery');
  assert.equal(r.autoTickets.created, 1, 'a new ticket for the -6h outage');
  assert.equal(count(), 2);

  const rows = tickets("device_id = 'dev1'");
  assert.equal(rows[0].source_outage_start, NOW - 9 * H);
  assert.equal(rows[0].status, 'resolved');
  assert.equal(rows[0].resolved_at, NOW - 7 * H, 'resolved_at = the actual recovery time');
  assert.equal(rows[1].source_outage_start, NOW - 6 * H);
  assert.equal(rows[1].status, 'open');
});

test('a subsequent tick does not re-resolve or duplicate anything', async () => {
  const r = await tick();
  assert.equal(r.autoTickets.created, 0);
  assert.equal(r.autoTickets.resolved, 0);
  assert.equal(count(), 2);
});

test('auto-resolve only touches an UNTOUCHED ticket (status still open, created_by NULL)', async () => {
  // fresh isolated fixture
  db.prepare("INSERT INTO devices (id,workspace_id,name) VALUES ('dev2','ws','Cafe Screen')").run();

  // an ongoing breach -> open the ticket
  let r = await autoCreateBreachTickets(
    db,
    [{ device_id: 'dev2', workspace_id: 'ws', outage_start: NOW - 8 * H, outage_end: null }],
    { nowSec: NOW, thresholdSec: 4 * H, sinceEpoch: NOW - 20 * H },
  );
  assert.equal(r.created, 1);
  const id = db.prepare("SELECT id FROM tickets WHERE device_id='dev2'").get().id;

  // a human picks it up
  db.prepare("UPDATE tickets SET status='in_progress' WHERE id=?").run(id);

  // now the outage recovers - the sweep sees a completed outage for that start
  r = await autoCreateBreachTickets(
    db,
    [{ device_id: 'dev2', workspace_id: 'ws', outage_start: NOW - 8 * H, outage_end: NOW - 2 * H }],
    { nowSec: NOW, thresholdSec: 4 * H, sinceEpoch: NOW - 20 * H },
  );
  assert.equal(r.resolved, 0, 'a human-touched ticket is left alone');
  assert.equal(db.prepare('SELECT status FROM tickets WHERE id=?').get(id).status, 'in_progress');
});

test('claim-by-insert survives a duplicate: two back-to-back sweeps, one ticket', async () => {
  db.prepare("INSERT INTO devices (id,workspace_id,name) VALUES ('dev3','ws','Dock Screen')").run();
  const outages = [{ device_id: 'dev3', workspace_id: 'ws', outage_start: NOW - 5 * H, outage_end: null }];
  const opts = { nowSec: NOW, thresholdSec: 4 * H, sinceEpoch: NOW - 20 * H };
  const [a, b] = await Promise.all([
    autoCreateBreachTickets(db, outages, opts),
    autoCreateBreachTickets(db, outages, opts),
  ]);
  assert.equal(a.created + b.created, 1, 'exactly one of the two racing sweeps created it');
  assert.equal(count("device_id='dev3'"), 1);
});
