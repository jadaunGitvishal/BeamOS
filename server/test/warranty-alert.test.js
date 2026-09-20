'use strict';

// Ref 52 — 30-day-prior warranty-expiry alert emails.
//
// In-memory sqlite swapped in for ../db/database; a fake sendEmail records calls.
// Covers: alert fires once per device within the window, idempotency
// (warranty_alerts UNIQUE key), a date correction producing a FRESH alert,
// recipient targeting (workspace_admin only), and the too-far-out / already-expired
// / no-recipient / no-expiry-set cases.

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

process.env.JWT_SECRET = 'test-secret-warranty-alert';

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
    id TEXT PRIMARY KEY, workspace_id TEXT, name TEXT DEFAULT '', warranty_expiry_date TEXT
  );
  CREATE TABLE warranty_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
    warranty_expiry_date TEXT NOT NULL, alerted_at INTEGER NOT NULL DEFAULT 0, recipient_email TEXT NOT NULL,
    UNIQUE (device_id, warranty_expiry_date)
  );
`);

// sqlite has no DATEDIFF() built in - register the same semantics MySQL's
// DATEDIFF(expr1, expr2) has (whole days, expr1 - expr2) so the service's
// query runs unmodified against this in-memory stand-in.
db.function('DATEDIFF', (a, b) => Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86400000));

const dbModulePath = require.resolve('../db/database');
require.cache[dbModulePath] = { id: dbModulePath, filename: dbModulePath, loaded: true, exports: { db } };

const { runWarrantyAlerts } = require('../services/warranty-alert');

// --- fixtures ------------------------------------------------------------
db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES ('org', 'Org', 'u-admin')").run();
db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES ('ws', 'org', 'Lobby WS')").run();
db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES ('ws-empty', 'org', 'No Admins WS')").run();

const user = (id, email) =>
  db.prepare("INSERT INTO users (id, email, name, role) VALUES (?, ?, ?, 'user')").run(id, email, id);
user('u-admin', 'admin@corp.test');
user('u-admin2', 'admin2@corp.test');
user('u-editor', 'editor@corp.test');
user('u-viewer', 'viewer@corp.test');
user('u-editor2', 'editor2@corp.test');

const member = (ws, uid, role) =>
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)").run(ws, uid, role);
member('ws', 'u-admin', 'workspace_admin');
member('ws', 'u-admin2', 'workspace_admin');
member('ws', 'u-editor', 'workspace_editor');
member('ws', 'u-viewer', 'workspace_viewer');
member('ws-empty', 'u-editor2', 'workspace_editor'); // ws-empty has a member but NO admin

const NOW = new Date('2026-06-15T00:00:00.000Z');
const iso = (offsetDays) => new Date(NOW.getTime() + offsetDays * 86400_000).toISOString().slice(0, 10);

// dev-within: 20 days out -> within the 30-day window, must alert
db.prepare("INSERT INTO devices (id, workspace_id, name, warranty_expiry_date) VALUES ('dev-within', 'ws', 'Front Lobby Screen', ?)").run(iso(20));
// dev-far: 45 days out -> outside the window, must NOT alert (yet)
db.prepare("INSERT INTO devices (id, workspace_id, name, warranty_expiry_date) VALUES ('dev-far', 'ws', 'Break Room', ?)").run(iso(45));
// dev-expired: expired 5 days ago -> must NOT alert (not "newly" 30 days out)
db.prepare("INSERT INTO devices (id, workspace_id, name, warranty_expiry_date) VALUES ('dev-expired', 'ws', 'Old Screen', ?)").run(iso(-5));
// dev-noadmin: within window, but workspace has no workspace_admin
db.prepare("INSERT INTO devices (id, workspace_id, name, warranty_expiry_date) VALUES ('dev-noadmin', 'ws-empty', 'Orphan Screen', ?)").run(iso(10));
// dev-none: no warranty_expiry_date at all -> excluded by the WHERE clause
db.prepare("INSERT INTO devices (id, workspace_id, name, warranty_expiry_date) VALUES ('dev-none', 'ws', 'No Warranty Screen', NULL)").run();

const calls = [];
const fakeSend = async (m) => { calls.push(m); return { sent: false, reason: 'test' }; };
const run = (extra = {}) => runWarrantyAlerts(db, { now: NOW, sendEmail: fakeSend, ...extra });

const rowCount = () => db.prepare('SELECT COUNT(*) AS n FROM warranty_alerts').get().n;

test('first tick: alert fires for the device within the window, emailed to both workspace_admins', async () => {
  calls.length = 0;
  const r = await run();
  assert.equal(r.candidates, 2, 'dev-within (20d) and dev-noadmin (10d) are within the 30d window; dev-far (45d), dev-expired (-5d) and dev-none are not');
  assert.equal(r.sent, 1, 'only dev-within has a workspace_admin to alert');
  assert.equal(r.skipped, 0);
  assert.equal(r.noRecipients, 1, 'dev-noadmin: within window but no workspace_admin');

  // one alert row for dev-within's expiry date
  assert.equal(rowCount(), 1);
  const row = db.prepare("SELECT * FROM warranty_alerts WHERE device_id = 'dev-within'").get();
  assert.equal(row.warranty_expiry_date, iso(20));
  assert.equal(row.workspace_id, 'ws');
  assert.equal(row.recipient_email, 'admin@corp.test, admin2@corp.test');

  // emailed to BOTH admins, nobody else
  const to = calls.map((c) => c.to).sort();
  assert.deepEqual(to, ['admin2@corp.test', 'admin@corp.test'].sort());
  assert.match(calls[0].subject, /^Warranty Expiring Soon: Front Lobby Screen$/);
  assert.match(calls[0].text, new RegExp(`under warranty until ${iso(20)}`));
  assert.match(calls[0].text, /20 days from today/);
  assert.ok(calls[0].html && calls[0].html.includes('Front Lobby Screen'));
});

test('recipient targeting: workspace_editor / workspace_viewer are never emailed', async () => {
  const everyRecipient = calls.map((c) => c.to);
  for (const bad of ['editor@corp.test', 'viewer@corp.test']) {
    assert.ok(!everyRecipient.includes(bad), `${bad} must not be emailed`);
  }
});

test('second tick, same clock: idempotent — zero new alerts, no duplicate row', async () => {
  calls.length = 0;
  const r = await run();
  assert.equal(r.sent, 0);
  assert.equal(r.skipped, 1, 'dev-within already alerted for this expiry date');
  assert.equal(calls.length, 0, 'no email sent');
  assert.equal(rowCount(), 1, 'still exactly one alert row');
});

test('device too far out is never alerted', async () => {
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM warranty_alerts WHERE device_id = 'dev-far'").get().n, 0);
});

test('already-expired device is never alerted as "newly" 30 days out', async () => {
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM warranty_alerts WHERE device_id = 'dev-expired'").get().n, 0);
});

test('device with no warranty_expiry_date is excluded entirely', async () => {
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM warranty_alerts WHERE device_id = 'dev-none'").get().n, 0);
});

test('no workspace_admin: not claimed, not emailed — a later tick can still alert once one is added', async () => {
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM warranty_alerts WHERE device_id = 'dev-noadmin'").get().n, 0);
  member('ws-empty', 'u-admin', 'workspace_admin');
  calls.length = 0;
  const r = await run();
  assert.equal(r.sent, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM warranty_alerts WHERE device_id = 'dev-noadmin'").get().n, 1);
  assert.deepEqual(calls.map((c) => c.to), ['admin@corp.test']);
});

test('a corrected/renewed expiry date produces a FRESH alert', async () => {
  // dev-within's warranty gets corrected to a new date, still inside the window.
  const newDate = iso(25);
  db.prepare("UPDATE devices SET warranty_expiry_date = ? WHERE id = 'dev-within'").run(newDate);

  calls.length = 0;
  const r = await run();
  assert.equal(r.sent, 1, 'the new expiry date is a fresh threshold crossing');
  assert.equal(rowCount(), 3, 'a second alert row for dev-within (new expiry date) plus the two from before');

  const rows = db
    .prepare("SELECT warranty_expiry_date FROM warranty_alerts WHERE device_id = 'dev-within' ORDER BY warranty_expiry_date")
    .all()
    .map((x) => x.warranty_expiry_date);
  assert.deepEqual(rows.sort(), [iso(20), newDate].sort());
});

test('daysBefore override is honoured', async () => {
  calls.length = 0;
  // With a 50-day window, dev-far (45d) now qualifies too.
  const r = await run({ daysBefore: 50 });
  assert.equal(r.candidates, 3, 'dev-within, dev-noadmin, and now dev-far');
  assert.equal(r.sent, 1, 'only dev-far is new; dev-within/dev-noadmin already alerted for their current dates');
  assert.deepEqual(calls.map((c) => c.to).sort(), ['admin2@corp.test', 'admin@corp.test'].sort());
  assert.match(calls[0].subject, /Break Room/);
});
