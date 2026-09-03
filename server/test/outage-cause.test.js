'use strict';

// Step 5 Stage A — root-cause classification for a completed outage
// (lib/outage-cause.js). In-memory sqlite for the telemetry + peer lookups.

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const {
  classifyOutage,
  CORRELATION_WINDOW_SEC,
  TELEMETRY_MAX_AGE_SEC,
} = require('../lib/outage-cause');

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE device_telemetry (
    id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL,
    wifi_rssi INTEGER, storage_free_mb INTEGER, reported_at INTEGER NOT NULL
  );
  CREATE TABLE outage_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
    started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL DEFAULT 0, duration_seconds INTEGER NOT NULL DEFAULT 0
  );
`);
const tele = (device, rssi, storeMb, at) =>
  db.prepare('INSERT INTO device_telemetry (device_id, wifi_rssi, storage_free_mb, reported_at) VALUES (?,?,?,?)').run(device, rssi, storeMb, at);
const histRow = (device, ws, at) =>
  db.prepare('INSERT INTO outage_history (device_id, workspace_id, started_at, ended_at, duration_seconds) VALUES (?,?,?,?,?)').run(device, ws, at, at + 600, 600);

const T = 1_800_000_000; // fixed outage_start for the device under test
const outage = (over = {}) => ({ device_id: 'devX', workspace_id: 'wsA', outage_start: T, outage_end: T + 900, ...over });

test.after(() => db.close());

// ---- (a) telemetry signals -------------------------------------------------

test('weak_wifi: last reading before the outage was at/below the -75 dBm threshold', async () => {
  tele('devX', -80, 8000, T - 10);
  assert.equal(await classifyOutage(db, outage(), []), 'weak_wifi');
});

test('weak_wifi boundary: exactly -75 counts (<=)', async () => {
  db.prepare("DELETE FROM device_telemetry WHERE device_id='devX'").run();
  tele('devX', -75, 8000, T - 12);
  assert.equal(await classifyOutage(db, outage(), []), 'weak_wifi');
  db.prepare("DELETE FROM device_telemetry WHERE device_id='devX'").run();
  tele('devX', -74, 8000, T - 12);
  assert.equal(await classifyOutage(db, outage(), []), 'unknown', '-74 is fine');
});

test('low_storage: last reading was at/below 500 MB free, Wi-Fi fine', async () => {
  db.prepare("DELETE FROM device_telemetry WHERE device_id='devX'").run();
  tele('devX', -55, 480, T - 9);
  assert.equal(await classifyOutage(db, outage(), []), 'low_storage');
});

test('low_storage boundary: exactly 500 counts (<=); 501 does not', async () => {
  db.prepare("DELETE FROM device_telemetry WHERE device_id='devX'").run();
  tele('devX', -55, 500, T - 9);
  assert.equal(await classifyOutage(db, outage(), []), 'low_storage');
  db.prepare("DELETE FROM device_telemetry WHERE device_id='devX'").run();
  tele('devX', -55, 501, T - 9);
  assert.equal(await classifyOutage(db, outage(), []), 'unknown');
});

test('uses the CLOSEST prior reading, not an older bad one', async () => {
  db.prepare("DELETE FROM device_telemetry WHERE device_id='devX'").run();
  tele('devX', -90, 100, T - 3600); // an hour before: terrible, but stale
  tele('devX', -55, 9000, T - 8);   // right before: healthy
  assert.equal(await classifyOutage(db, outage(), []), 'unknown');
});

test('stale telemetry (older than the max-age window) is ignored', async () => {
  db.prepare("DELETE FROM device_telemetry WHERE device_id='devX'").run();
  tele('devX', -85, 100, T - (TELEMETRY_MAX_AGE_SEC + 60)); // weak + low, but too old
  assert.equal(await classifyOutage(db, outage(), []), 'unknown');
});

test('no telemetry at all -> unknown', async () => {
  db.prepare('DELETE FROM device_telemetry').run();
  assert.equal(await classifyOutage(db, outage(), []), 'unknown');
});

test('a reading only AFTER the outage started is not used', async () => {
  db.prepare('DELETE FROM device_telemetry').run();
  tele('devX', -88, 50, T + 30); // after outage_start
  assert.equal(await classifyOutage(db, outage(), []), 'unknown');
});

// ---- (b) correlated_outage -----------------------------------------------

test('correlated_outage: another device in the same workspace within the window (via peerOutages)', async () => {
  db.prepare('DELETE FROM device_telemetry').run();
  const peers = [{ device_id: 'devY', workspace_id: 'wsA', outage_start: T + 90, outage_end: T + 800 }];
  assert.equal(await classifyOutage(db, outage(), peers), 'correlated_outage');
});

test('correlated window boundary: exactly CORRELATION_WINDOW_SEC away counts; one second more does not', async () => {
  const inWin = [{ device_id: 'devY', workspace_id: 'wsA', outage_start: T + CORRELATION_WINDOW_SEC }];
  const outWin = [{ device_id: 'devY', workspace_id: 'wsA', outage_start: T + CORRELATION_WINDOW_SEC + 1 }];
  assert.equal(await classifyOutage(db, outage(), inWin), 'correlated_outage');
  assert.equal(await classifyOutage(db, outage(), outWin), 'unknown');
});

test('NOT correlated: a peer in a DIFFERENT workspace, or the same device flapping', async () => {
  assert.equal(await classifyOutage(db, outage(), [{ device_id: 'devY', workspace_id: 'wsB', outage_start: T }]), 'unknown');
  assert.equal(await classifyOutage(db, outage(), [{ device_id: 'devX', workspace_id: 'wsA', outage_start: T + 60 }]), 'unknown');
});

test('correlated_outage: peer found via the outage_history backstop (not in peerOutages)', async () => {
  histRow('devZ', 'wsA', T - 120);
  assert.equal(await classifyOutage(db, outage(), []), 'correlated_outage');
  db.prepare('DELETE FROM outage_history').run();
});

// ---- (c) priority order -------------------------------------------------

test('priority: correlated_outage beats a simultaneous weak_wifi reading', async () => {
  db.prepare('DELETE FROM device_telemetry').run();
  tele('devX', -85, 9000, T - 10); // weak wifi signal present
  const peers = [{ device_id: 'devY', workspace_id: 'wsA', outage_start: T + 30 }]; // AND correlated
  assert.equal(await classifyOutage(db, outage(), peers), 'correlated_outage');
  // without the peer, the same telemetry gives weak_wifi
  assert.equal(await classifyOutage(db, outage(), []), 'weak_wifi');
});

test('priority: weak_wifi beats low_storage when both thresholds are crossed', async () => {
  db.prepare('DELETE FROM device_telemetry').run();
  tele('devX', -82, 200, T - 10); // BOTH weak wifi and low storage
  assert.equal(await classifyOutage(db, outage(), []), 'weak_wifi');
});
