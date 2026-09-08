'use strict';

// Ref 43 Stage A — Field Visit Inspections: backend + data model.
//
// In-memory sqlite + the real routers, mounted as server.js mounts them
// (requireAuth only; field-visit routes gate per-handler via canLogFieldVisit,
// no resolveTenancy). Covers item 9's verification list:
//   - RBAC matrix: org-wide field_technician works across MULTIPLE workspaces
//     with no per-workspace membership; a regular workspace_editor works for
//     their own single workspace; everyone else is denied.
//   - OTP flow: correct dummy code succeeds, wrong code fails, and the dummy
//     nature is unmistakable in routes/field-auth.js.
//   - Telemetry auto-snapshot accuracy.
//   - GPS validation genuinely REJECTS bad input at the API level.
//   - Duplicate-submission safeguard actually prevents a double-post.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

process.env.JWT_SECRET = 'test-secret-field-visits';
const PHOTO_DIR = path.join(os.tmpdir(), 'beamos-fv-test-' + crypto.randomBytes(4).toString('hex'));
fs.mkdirSync(PHOTO_DIR, { recursive: true });
process.env.UPLOADS_DIR = PHOTO_DIR; // config.fieldVisitPhotosDir = <this>/field-visit-photos
fs.mkdirSync(path.join(PHOTO_DIR, 'field-visit-photos'), { recursive: true });

const db = new Database(':memory:');
db.function('UNIX_TIMESTAMP', () => Math.floor(Date.now() / 1000));
db.exec(`
  CREATE TABLE users (
    id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT DEFAULT '',
    password_hash TEXT, auth_provider TEXT NOT NULL DEFAULT 'local', avatar_url TEXT,
    role TEXT NOT NULL DEFAULT 'user', plan_id TEXT DEFAULT 'free', email_alerts INTEGER DEFAULT 1,
    must_change_password INTEGER NOT NULL DEFAULT 0, phone TEXT UNIQUE, last_login INTEGER
  );
  CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_user_id TEXT NOT NULL);
  CREATE TABLE organization_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT, organization_id TEXT NOT NULL, user_id TEXT NOT NULL,
    role TEXT NOT NULL, joined_at INTEGER DEFAULT 0
  );
  CREATE TABLE workspaces (
    id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, name TEXT NOT NULL, updated_at INTEGER DEFAULT 0
  );
  CREATE TABLE workspace_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, user_id TEXT NOT NULL,
    role TEXT NOT NULL, joined_at INTEGER DEFAULT 0
  );
  CREATE TABLE devices (
    id TEXT PRIMARY KEY, workspace_id TEXT, name TEXT DEFAULT 'Unnamed'
  );
  CREATE TABLE device_telemetry (
    id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL,
    battery_level INTEGER, battery_charging INTEGER DEFAULT 0,
    storage_free_mb INTEGER, storage_total_mb INTEGER, ram_free_mb INTEGER, ram_total_mb INTEGER,
    cpu_usage REAL, wifi_ssid TEXT, wifi_rssi INTEGER, uptime_seconds INTEGER,
    latitude REAL, longitude REAL, reported_at INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE field_visits (
    id TEXT PRIMARY KEY, device_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
    technician_user_id TEXT, client_visit_uuid TEXT UNIQUE,
    visit_type TEXT NOT NULL, serial_number TEXT, mac_address TEXT, device_model TEXT,
    sim_network_info TEXT, device_status TEXT, remarks TEXT, technical_metrics TEXT,
    status TEXT NOT NULL DEFAULT 'in_progress',
    created_at INTEGER NOT NULL DEFAULT 0, completed_at INTEGER
  );
  CREATE TABLE field_visit_photos (
    id TEXT PRIMARY KEY, visit_id TEXT NOT NULL, filepath TEXT NOT NULL,
    latitude REAL, longitude REAL, gps_accuracy_meters REAL, photo_category TEXT,
    captured_at INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, device_id TEXT, action TEXT,
    details TEXT, ip_address TEXT, workspace_id TEXT, created_at INTEGER DEFAULT 0
  );
`);

const dbModulePath = require.resolve('../db/database');
require.cache[dbModulePath] = { id: dbModulePath, filename: dbModulePath, loaded: true, exports: { db } };

const express = require('express');
const { generateToken, requireAuth } = require('../middleware/auth');

// --- fixtures -------------------------------------------------------
// Org A: two workspaces (a1, a2). Org B: one workspace (b1).
db.prepare("INSERT INTO users (id,email,role,phone) VALUES ('u-tech','tech@t.test','user','+15551230000')").run();
db.prepare("INSERT INTO users (id,email,role) VALUES ('u-owner-a','ownera@t.test','user')").run();
db.prepare("INSERT INTO users (id,email,role,phone) VALUES ('u-editor-a1','editora1@t.test','user','+15551231111')").run();
db.prepare("INSERT INTO users (id,email,role) VALUES ('u-viewer-a1','viewera1@t.test','user')").run();
db.prepare("INSERT INTO users (id,email,role) VALUES ('u-nobody','nobody@t.test','user')").run();
db.prepare("INSERT INTO users (id,email,role) VALUES ('u-plat','plat@t.test','platform_admin')").run();

db.prepare("INSERT INTO organizations (id,name,owner_user_id) VALUES ('org-a','Org A','u-owner-a')").run();
db.prepare("INSERT INTO organizations (id,name,owner_user_id) VALUES ('org-b','Org B','u-nobody')").run();
db.prepare("INSERT INTO organization_members (organization_id,user_id,role) VALUES ('org-a','u-owner-a','org_owner')").run();
// The technician: ONE org-level row, no workspace membership anywhere.
db.prepare("INSERT INTO organization_members (organization_id,user_id,role) VALUES ('org-a','u-tech','field_technician')").run();

db.prepare("INSERT INTO workspaces (id,organization_id,name) VALUES ('ws-a1','org-a','A One')").run();
db.prepare("INSERT INTO workspaces (id,organization_id,name) VALUES ('ws-a2','org-a','A Two')").run();
db.prepare("INSERT INTO workspaces (id,organization_id,name) VALUES ('ws-b1','org-b','B One')").run();
db.prepare("INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ('ws-a1','u-editor-a1','workspace_editor')").run();
db.prepare("INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ('ws-a1','u-viewer-a1','workspace_viewer')").run();

db.prepare("INSERT INTO devices (id,workspace_id,name) VALUES ('dev-a1','ws-a1','Lobby A1')").run();
db.prepare("INSERT INTO devices (id,workspace_id,name) VALUES ('dev-a2','ws-a2','Lobby A2')").run();
db.prepare("INSERT INTO devices (id,workspace_id,name) VALUES ('dev-b1','ws-b1','Lobby B1')").run();

// telemetry: dev-a1 has two rows; the NEWER one is what the snapshot must capture.
db.prepare(`INSERT INTO device_telemetry
  (device_id,battery_level,battery_charging,storage_free_mb,storage_total_mb,ram_free_mb,ram_total_mb,cpu_usage,wifi_ssid,wifi_rssi,uptime_seconds,reported_at)
  VALUES ('dev-a1', 40, 0, 100, 8000, 900, 2048, 12.5, 'OldNet', -80, 1000, 1000)`).run();
db.prepare(`INSERT INTO device_telemetry
  (device_id,battery_level,battery_charging,storage_free_mb,storage_total_mb,ram_free_mb,ram_total_mb,cpu_usage,wifi_ssid,wifi_rssi,uptime_seconds,reported_at)
  VALUES ('dev-a1', 87, 1, 4321, 8000, 1536, 2048, 5.0, 'StoreWiFi', -55, 123456, 2000000000)`).run();
// dev-a2 has NO telemetry -> snapshot must be null.

const tok = (id) => {
  const u = db.prepare('SELECT id,email,role FROM users WHERE id = ?').get(id);
  return generateToken(u, null);
};
const T = {
  tech: tok('u-tech'), ownerA: tok('u-owner-a'), editorA1: tok('u-editor-a1'),
  viewerA1: tok('u-viewer-a1'), nobody: tok('u-nobody'), plat: tok('u-plat'),
};

const app = express();
app.use(express.json());
app.use('/api/field-auth', require('../routes/field-auth'));
app.use('/api/workspaces', requireAuth, require('../routes/workspaces'));
app.use((err, req, res, _next) => { res.status(500).json({ error: err.message, stack: err.stack }); });
const server = app.listen(0);
let base;
test.before(async () => {
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); db.close(); fs.rmSync(PHOTO_DIR, { recursive: true, force: true }); });

const call = (method, p, token, body) =>
  fetch(base + p, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const fv = (wsId) => `/api/workspaces/${wsId}/field-visits`;

// ============================ RBAC MATRIX ============================

test('org-wide field_technician can log visits in MULTIPLE workspaces without any workspace membership', async () => {
  const c1 = await call('POST', fv('ws-a1'), T.tech, { device_id: 'dev-a1', visit_type: 'installation' });
  assert.equal(c1.status, 201);
  const v1 = await c1.json();
  assert.equal(v1.workspace_id, 'ws-a1');
  assert.equal(v1.technician_user_id, 'u-tech');

  // Same technician, DIFFERENT workspace in the same org - still allowed.
  const c2 = await call('POST', fv('ws-a2'), T.tech, { device_id: 'dev-a2', visit_type: 'repair' });
  assert.equal(c2.status, 201);
  assert.equal((await c2.json()).workspace_id, 'ws-a2');

  // But NOT a workspace in another org.
  const c3 = await call('POST', fv('ws-b1'), T.tech, { device_id: 'dev-b1', visit_type: 'repair' });
  assert.equal(c3.status, 403);
});

test('a regular workspace_editor can log visits for their own workspace only', async () => {
  const ok = await call('POST', fv('ws-a1'), T.editorA1, { device_id: 'dev-a1', visit_type: 'maintenance' });
  assert.equal(ok.status, 201);
  // ws-a2: editor-a1 has no membership and no org role -> denied.
  const no = await call('POST', fv('ws-a2'), T.editorA1, { device_id: 'dev-a2', visit_type: 'maintenance' });
  assert.equal(no.status, 403);
});

test('workspace_viewer can READ but not WRITE; unrelated user and anon are fully denied', async () => {
  // viewer: read-only reference access to inspection history
  assert.equal((await call('POST', fv('ws-a1'), T.viewerA1, { device_id: 'dev-a1', visit_type: 'audit' })).status, 403);
  assert.equal((await call('GET', fv('ws-a1'), T.viewerA1)).status, 200);
  // unrelated user: no access at all
  assert.equal((await call('POST', fv('ws-a1'), T.nobody, { device_id: 'dev-a1', visit_type: 'audit' })).status, 403);
  assert.equal((await call('GET', fv('ws-a1'), T.nobody)).status, 403);
  assert.equal((await call('GET', fv('ws-a1'), null)).status, 401);
});

test('platform_admin is allowed; unknown workspace 404; cross-workspace device 400', async () => {
  assert.equal((await call('POST', fv('ws-b1'), T.plat, { device_id: 'dev-b1', visit_type: 'audit' })).status, 201);
  assert.equal((await call('POST', fv('ws-missing'), T.plat, { device_id: 'dev-b1', visit_type: 'audit' })).status, 404);
  // device belongs to ws-a2, not ws-a1
  assert.equal((await call('POST', fv('ws-a1'), T.tech, { device_id: 'dev-a2', visit_type: 'audit' })).status, 400);
});

// ==================== TELEMETRY AUTO-SNAPSHOT ====================

test('POST auto-snapshots the device\'s LATEST telemetry row into technical_metrics', async () => {
  const v = await (await call('POST', fv('ws-a1'), T.tech, { device_id: 'dev-a1', visit_type: 'installation' })).json();
  const m = v.technical_metrics;
  assert.ok(m, 'technical_metrics present');
  assert.equal(m.battery_level, 87);          // from the newer row, not the older (40)
  assert.equal(m.battery_charging, true);
  assert.equal(m.storage_free_mb, 4321);
  assert.equal(m.wifi_ssid, 'StoreWiFi');
  assert.equal(m.wifi_rssi, -55);
  assert.equal(m.uptime_seconds, 123456);
  assert.equal(m.telemetry_reported_at, 2000000000);
  assert.equal(typeof m.snapshot_at, 'number');
});

test('technical_metrics is null when the device has never reported telemetry', async () => {
  const v = await (await call('POST', fv('ws-a2'), T.tech, { device_id: 'dev-a2', visit_type: 'installation' })).json();
  assert.equal(v.technical_metrics, null);
});

// ==================== PATCH (update + complete) ====================

test('PATCH updates details and marks complete (stamps completed_at); revert clears it', async () => {
  const v = await (await call('POST', fv('ws-a1'), T.tech, { device_id: 'dev-a1', visit_type: 'installation' })).json();

  const p1 = await call('PATCH', `${fv('ws-a1')}/${v.id}`, T.tech, {
    serial_number: 'SN-12345', mac_address: 'AA:BB:CC:DD:EE:FF', device_model: 'BeamBox 3',
    sim_network_info: 'Airtel LTE', device_status: 'working', remarks: 'all good', status: 'completed',
  });
  assert.equal(p1.status, 200);
  const done = await p1.json();
  assert.equal(done.serial_number, 'SN-12345');
  assert.equal(done.device_status, 'working');
  assert.equal(done.status, 'completed');
  assert.equal(typeof done.completed_at, 'number');

  const p2 = await call('PATCH', `${fv('ws-a1')}/${v.id}`, T.tech, { status: 'in_progress' });
  assert.equal((await p2.json()).completed_at, null);

  // bad status rejected
  assert.equal((await call('PATCH', `${fv('ws-a1')}/${v.id}`, T.tech, { status: 'bogus' })).status, 400);
  // cross-workspace visit id not found
  assert.equal((await call('PATCH', `${fv('ws-a2')}/${v.id}`, T.tech, { remarks: 'x' })).status, 404);
});

// ==================== GPS VALIDATION (API-level reject) ====================

async function uploadPhoto(wsId, visitId, token, fields, { withFile = true } = {}) {
  const fd = new FormData();
  if (withFile) fd.append('photo', new Blob([Buffer.from('fakejpegbytes')], { type: 'image/jpeg' }), 'p.jpg');
  for (const [k, val] of Object.entries(fields)) fd.append(k, String(val));
  return fetch(`${base}${fv(wsId)}/${visitId}/photos`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd,
  });
}

test('photo upload: valid GPS accepted; bad/missing GPS REJECTED at the API and no file kept', async () => {
  const v = await (await call('POST', fv('ws-a1'), T.tech, { device_id: 'dev-a1', visit_type: 'installation' })).json();
  const before = fs.readdirSync(path.join(PHOTO_DIR, 'field-visit-photos')).length;

  // happy path
  const ok = await uploadPhoto('ws-a1', v.id, T.tech, { latitude: 19.076, longitude: 72.8777, gps_accuracy_meters: 8.5, photo_category: 'device_front' });
  assert.equal(ok.status, 201);
  const photo = await ok.json();
  assert.equal(photo.latitude, 19.076);
  assert.equal(photo.gps_accuracy_meters, 8.5);
  assert.equal(photo.photo_category, 'device_front');

  // each of these must be a 400 (REJECT, not warn)
  const bad = [
    { latitude: 200, longitude: 72, gps_accuracy_meters: 5 },      // lat out of range
    { latitude: 19, longitude: 999, gps_accuracy_meters: 5 },       // lon out of range
    { latitude: 0, longitude: 0, gps_accuracy_meters: 5 },          // null island
    { latitude: 'abc', longitude: 72, gps_accuracy_meters: 5 },     // not a number
    { latitude: 19, longitude: 72 },                                // accuracy missing
    { latitude: 19, longitude: 72, gps_accuracy_meters: 0 },        // accuracy 0
    { latitude: 19, longitude: 72, gps_accuracy_meters: -3 },       // accuracy negative
    { longitude: 72, gps_accuracy_meters: 5 },                      // latitude missing
  ];
  for (const f of bad) {
    const r = await uploadPhoto('ws-a1', v.id, T.tech, f);
    assert.equal(r.status, 400, `expected 400 for ${JSON.stringify(f)}`);
  }
  // missing file entirely
  assert.equal((await uploadPhoto('ws-a1', v.id, T.tech, { latitude: 19, longitude: 72, gps_accuracy_meters: 5 }, { withFile: false })).status, 400);

  // exactly ONE new file on disk (the happy-path upload); every rejected upload cleaned up.
  const after = fs.readdirSync(path.join(PHOTO_DIR, 'field-visit-photos')).length;
  assert.equal(after - before, 1);

  // and it comes back on the detail view
  const detail = await (await call('GET', `${fv('ws-a1')}/${v.id}`, T.tech)).json();
  assert.equal(detail.photos.length, 1);
});

test('photo upload denied for a user without field-visit access (no file written)', async () => {
  const v = await (await call('POST', fv('ws-a1'), T.tech, { device_id: 'dev-a1', visit_type: 'installation' })).json();
  const before = fs.readdirSync(path.join(PHOTO_DIR, 'field-visit-photos')).length;
  const r = await uploadPhoto('ws-a1', v.id, T.nobody, { latitude: 19, longitude: 72, gps_accuracy_meters: 5 });
  assert.equal(r.status, 403);
  assert.equal(fs.readdirSync(path.join(PHOTO_DIR, 'field-visit-photos')).length, before);
});

// ==================== DUPLICATE-SUBMISSION SAFEGUARD ====================

test('client_visit_uuid makes a repeated POST idempotent (no double-post)', async () => {
  const uuid = 'client-uuid-' + crypto.randomBytes(4).toString('hex');
  const a = await call('POST', fv('ws-a1'), T.tech, { device_id: 'dev-a1', visit_type: 'installation', client_visit_uuid: uuid });
  assert.equal(a.status, 201);
  const first = await a.json();

  const b = await call('POST', fv('ws-a1'), T.tech, { device_id: 'dev-a1', visit_type: 'installation', client_visit_uuid: uuid });
  assert.equal(b.status, 200); // returned, not re-created
  assert.equal((await b.json()).id, first.id);

  const rows = db.prepare("SELECT COUNT(*) n FROM field_visits WHERE client_visit_uuid = ?").get(uuid);
  assert.equal(rows.n, 1);

  // same uuid, different workspace -> conflict
  const c = await call('POST', fv('ws-a2'), T.tech, { device_id: 'dev-a2', visit_type: 'installation', client_visit_uuid: uuid });
  assert.equal(c.status, 409);
});

test('concurrent identical POSTs with the same client_visit_uuid still yield ONE row', async () => {
  const uuid = 'race-uuid-' + crypto.randomBytes(4).toString('hex');
  const body = { device_id: 'dev-a1', visit_type: 'installation', client_visit_uuid: uuid };
  const results = await Promise.all([
    call('POST', fv('ws-a1'), T.tech, body),
    call('POST', fv('ws-a1'), T.tech, body),
    call('POST', fv('ws-a1'), T.tech, body),
  ]);
  for (const r of results) assert.ok(r.status === 201 || r.status === 200, `status ${r.status}`);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM field_visits WHERE client_visit_uuid = ?").get(uuid).n, 1);
});

// ============================ OTP FLOW ============================

test('OTP: correct dummy code issues a working BeamOS session token', async () => {
  const send = await call('POST', '/api/field-auth/send-otp', null, { phone: '+1 555-123-0000' });
  assert.equal(send.status, 200);
  assert.deepEqual(await send.json(), { sent: true });

  const verify = await call('POST', '/api/field-auth/verify-otp', null, { phone: '+15551230000', code: '123456' });
  assert.equal(verify.status, 200);
  const out = await verify.json();
  assert.ok(out.token, 'token issued');
  assert.equal(out.user.id, 'u-tech');

  // the issued token is a real session token: it works on a gated route
  const c = await call('POST', fv('ws-a1'), out.token, { device_id: 'dev-a1', visit_type: 'installation' });
  assert.equal(c.status, 201);
});

test('OTP: wrong code and unknown phone both fail with 401', async () => {
  assert.equal((await call('POST', '/api/field-auth/verify-otp', null, { phone: '+15551230000', code: '000000' })).status, 401);
  assert.equal((await call('POST', '/api/field-auth/verify-otp', null, { phone: '+19999999999', code: '123456' })).status, 401);
  assert.equal((await call('POST', '/api/field-auth/verify-otp', null, { phone: 'not-a-phone', code: '123456' })).status, 400);
});

test('OTP: the placeholder/dummy nature is unmistakable in the source', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'field-auth.js'), 'utf8');
  assert.match(src, /PLACEHOLDER/);
  assert.match(src, /NOT PRODUCTION-READY/i);
  assert.match(src, /DUMMY_OTP_CODE\s*=\s*'123456'/);
  // the "send" path does not actually send anything - it logs
  assert.match(src, /no SMS sent|logs the fixed dummy code|console\.warn/);
});
