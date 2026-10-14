'use strict';

// Ref 43 Stage A — Field Visit Inspections: backend + data model.
//
// The REAL routers in-process (helpers/inprocess-app.js: /api/workspaces behind
// requireAuth, plus /api/field-auth mounted as server.js mounts it; field-visit routes
// gate per-handler via canLogFieldVisit, no resolveTenancy) against the REAL MySQL
// test DB (beamos_test via npm test). Covers item 9's verification list:
//   - RBAC matrix: org-wide field_technician works across MULTIPLE workspaces
//     with no per-workspace membership; a regular workspace_editor works for
//     their own single workspace; everyone else is denied.
//   - OTP flow: correct dummy code succeeds, wrong code fails, and the dummy
//     nature is unmistakable in routes/field-auth.js.
//   - Telemetry auto-snapshot accuracy.
//   - GPS validation genuinely REJECTS bad input at the API level.
//   - Duplicate-submission safeguard actually prevents a double-post.
//
// Fixtures are test-owned (fv- prefix, generated ids, random phone numbers per run)
// and removed afterwards (members first, each org owner last); photos go
// to a temp dir that is removed too.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

// PMI: the placeholder OTP route is off unless FIELD_OTP_ENABLED (dev/test only).
process.env.FIELD_OTP_ENABLED = 'true';
const PHOTO_DIR = path.join(os.tmpdir(), 'beamos-fv-test-' + crypto.randomBytes(4).toString('hex'));
fs.mkdirSync(PHOTO_DIR, { recursive: true });
process.env.UPLOADS_DIR = PHOTO_DIR; // config.fieldVisitPhotosDir = <this>/field-visit-photos
fs.mkdirSync(path.join(PHOTO_DIR, 'field-visit-photos'), { recursive: true });

const config = require('../config');
const { db } = require('../db/database');
const { generateToken } = require('../middleware/auth');
const { startInProcessApp } = require('./helpers/inprocess-app');
const { randTag, cleanupUsers } = require('./helpers/disposable');

const P = `fv-${randTag()}`;
const id = (name) => `${P}-${name}`;
const ID = {
  orgA: id('org-a'), orgB: id('org-b'), wsA1: id('ws-a1'), wsA2: id('ws-a2'), wsB1: id('ws-b1'),
  devA1: id('dev-a1'), devA2: id('dev-a2'), devB1: id('dev-b1'),
};
// Random US-style numbers per run (no collision with other files' rows); the OTP test
// still types the technician's number in a formatted way.
const usNumber = () => `555${String(crypto.randomInt(0, 1e7)).padStart(7, '0')}`;
const TECH_NUM = usNumber();
let EDITOR_NUM = usNumber();
while (EDITOR_NUM === TECH_NUM) EDITOR_NUM = usNumber();
const TECH_PHONE = `+1${TECH_NUM}`;
const TECH_PHONE_TYPED = `+1 ${TECH_NUM.slice(0, 3)}-${TECH_NUM.slice(3, 6)}-${TECH_NUM.slice(6)}`;
const UNKNOWN_PHONE = '+19999999999';

let app;
const userIds = [];
const U = {};
const T = {};
const savedFlag = config.fieldOtpEnabled;

async function mkUser(key, { role = 'user', phone = null } = {}) {
  const uid = id(key);
  await app.db.prepare("INSERT INTO users (id, email, name, password_hash, auth_provider, role, phone) VALUES (?, ?, ?, NULL, 'local', ?, ?)")
    .run(uid, `${uid}@t.test`, uid, role, phone);
  userIds.push(uid);
  U[key] = uid;
  T[key] = generateToken({ id: uid, email: `${uid}@t.test`, role }, null);
}

test.before(async () => {
  app = await startInProcessApp({ only: ['/api/workspaces'] });
  app.app.use('/api/field-auth', require('../routes/field-auth'));
  config.fieldOtpEnabled = true;
  const run = (sql, ...p) => app.db.prepare(sql).run(...p);
  const taken = await app.db.prepare('SELECT COUNT(*) AS n FROM users WHERE phone IN (?, ?, ?)').get(TECH_PHONE, `+1${EDITOR_NUM}`, UNKNOWN_PHONE);
  assert.equal(Number(taken.n), 0, 'the test phones are unused');

  // Org A: two workspaces (a1, a2). Org B: one workspace (b1).
  await mkUser('tech', { phone: TECH_PHONE });
  await mkUser('owner-a');
  await mkUser('editor-a1', { phone: `+1${EDITOR_NUM}` });
  await mkUser('viewer-a1');
  await mkUser('nobody');
  await mkUser('plat', { role: 'platform_admin' });

  const org = "INSERT INTO organizations (id, name, owner_user_id, plan_id, subscription_status) VALUES (?, ?, ?, 'enterprise', 'active')";
  await run(org, ID.orgA, `${P} Org A`, U['owner-a']);
  await run(org, ID.orgB, `${P} Org B`, U.nobody);
  await run("INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'org_owner')", ID.orgA, U['owner-a']);
  // The technician: ONE org-level row, no workspace membership anywhere.
  await run("INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'field_technician')", ID.orgA, U.tech);

  const ws = 'INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)';
  await run(ws, ID.wsA1, ID.orgA, `${P} A One`);
  await run(ws, ID.wsA2, ID.orgA, `${P} A Two`);
  await run(ws, ID.wsB1, ID.orgB, `${P} B One`);
  await run("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_editor')", ID.wsA1, U['editor-a1']);
  await run("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_viewer')", ID.wsA1, U['viewer-a1']);

  const dev = 'INSERT INTO devices (id, workspace_id, name) VALUES (?, ?, ?)';
  await run(dev, ID.devA1, ID.wsA1, 'Lobby A1');
  await run(dev, ID.devA2, ID.wsA2, 'Lobby A2');
  await run(dev, ID.devB1, ID.wsB1, 'Lobby B1');

  // telemetry: dev-a1 has two rows; the NEWER one is what the snapshot must capture.
  const tel = `INSERT INTO device_telemetry
    (device_id, battery_level, battery_charging, storage_free_mb, storage_total_mb, ram_free_mb, ram_total_mb, cpu_usage, wifi_ssid, wifi_rssi, uptime_seconds, reported_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  await run(tel, ID.devA1, 40, 0, 100, 8000, 900, 2048, 12.5, 'OldNet', -80, 1000, 1000);
  await run(tel, ID.devA1, 87, 1, 4321, 8000, 1536, 2048, 5.0, 'StoreWiFi', -55, 123456, 2000000000);
  // dev-a2 has NO telemetry -> snapshot must be null.
});

test.after(async () => {
  try {
    if (app) {
      config.fieldOtpEnabled = savedFlag;
      // Members first, org owners last: an owner is deletable only once its org's
      // other members (here the technician) are gone.
      const owners = [U['owner-a'], U.nobody];
      await cleanupUsers(app.db, [...userIds.filter((u) => !owners.includes(u)), ...owners]);
    }
  } finally {
    try {
      if (app) await app.stop(); else await db.close();
    } finally {
      fs.rmSync(PHOTO_DIR, { recursive: true, force: true });
    }
  }
});

const call = (method, p, token, body) =>
  fetch(app.base + p, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const fv = (wsId) => `/api/workspaces/${wsId}/field-visits`;
const visitsWithUuid = async (uuid) => Number((await app.db.prepare('SELECT COUNT(*) AS n FROM field_visits WHERE client_visit_uuid = ?').get(uuid)).n);

// ============================ RBAC MATRIX ============================

test('org-wide field_technician can log visits in MULTIPLE workspaces without any workspace membership', async () => {
  const c1 = await call('POST', fv(ID.wsA1), T.tech, { device_id: ID.devA1, visit_type: 'installation' });
  assert.equal(c1.status, 201);
  const v1 = await c1.json();
  assert.equal(v1.workspace_id, ID.wsA1);
  assert.equal(v1.technician_user_id, U.tech);

  // Same technician, DIFFERENT workspace in the same org - still allowed.
  const c2 = await call('POST', fv(ID.wsA2), T.tech, { device_id: ID.devA2, visit_type: 'repair' });
  assert.equal(c2.status, 201);
  assert.equal((await c2.json()).workspace_id, ID.wsA2);

  // But NOT a workspace in another org.
  const c3 = await call('POST', fv(ID.wsB1), T.tech, { device_id: ID.devB1, visit_type: 'repair' });
  assert.equal(c3.status, 403);
});

test('a regular workspace_editor can log visits for their own workspace only', async () => {
  const ok = await call('POST', fv(ID.wsA1), T['editor-a1'], { device_id: ID.devA1, visit_type: 'maintenance' });
  assert.equal(ok.status, 201);
  // ws-a2: editor-a1 has no membership and no org role -> denied.
  const no = await call('POST', fv(ID.wsA2), T['editor-a1'], { device_id: ID.devA2, visit_type: 'maintenance' });
  assert.equal(no.status, 403);
});

test('workspace_viewer can READ but not WRITE; unrelated user and anon are fully denied', async () => {
  // viewer: read-only reference access to inspection history
  assert.equal((await call('POST', fv(ID.wsA1), T['viewer-a1'], { device_id: ID.devA1, visit_type: 'audit' })).status, 403);
  assert.equal((await call('GET', fv(ID.wsA1), T['viewer-a1'])).status, 200);
  // unrelated user: no access at all
  assert.equal((await call('POST', fv(ID.wsA1), T.nobody, { device_id: ID.devA1, visit_type: 'audit' })).status, 403);
  assert.equal((await call('GET', fv(ID.wsA1), T.nobody)).status, 403);
  assert.equal((await call('GET', fv(ID.wsA1), null)).status, 401);
});

test('platform_admin is allowed; unknown workspace 404; cross-workspace device 400', async () => {
  assert.equal((await call('POST', fv(ID.wsB1), T.plat, { device_id: ID.devB1, visit_type: 'audit' })).status, 201);
  assert.equal((await call('POST', fv(id('ws-missing')), T.plat, { device_id: ID.devB1, visit_type: 'audit' })).status, 404);
  // device belongs to ws-a2, not ws-a1
  assert.equal((await call('POST', fv(ID.wsA1), T.tech, { device_id: ID.devA2, visit_type: 'audit' })).status, 400);
});

// ==================== TELEMETRY AUTO-SNAPSHOT ====================

test('POST auto-snapshots the device\'s LATEST telemetry row into technical_metrics', async () => {
  const v = await (await call('POST', fv(ID.wsA1), T.tech, { device_id: ID.devA1, visit_type: 'installation' })).json();
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
  const v = await (await call('POST', fv(ID.wsA2), T.tech, { device_id: ID.devA2, visit_type: 'installation' })).json();
  assert.equal(v.technical_metrics, null);
});

// ==================== PATCH (update + complete) ====================

test('PATCH updates details and marks complete (stamps completed_at); revert clears it', async () => {
  const v = await (await call('POST', fv(ID.wsA1), T.tech, { device_id: ID.devA1, visit_type: 'installation' })).json();

  const p1 = await call('PATCH', `${fv(ID.wsA1)}/${v.id}`, T.tech, {
    serial_number: 'SN-12345', mac_address: 'AA:BB:CC:DD:EE:FF', device_model: 'BeamBox 3',
    sim_network_info: 'Airtel LTE', device_status: 'working', remarks: 'all good', status: 'completed',
  });
  assert.equal(p1.status, 200);
  const done = await p1.json();
  assert.equal(done.serial_number, 'SN-12345');
  assert.equal(done.device_status, 'working');
  assert.equal(done.status, 'completed');
  assert.equal(typeof done.completed_at, 'number');

  const p2 = await call('PATCH', `${fv(ID.wsA1)}/${v.id}`, T.tech, { status: 'in_progress' });
  assert.equal((await p2.json()).completed_at, null);

  // bad status rejected
  assert.equal((await call('PATCH', `${fv(ID.wsA1)}/${v.id}`, T.tech, { status: 'bogus' })).status, 400);
  // cross-workspace visit id not found
  assert.equal((await call('PATCH', `${fv(ID.wsA2)}/${v.id}`, T.tech, { remarks: 'x' })).status, 404);
});

// ==================== GPS VALIDATION (API-level reject) ====================

async function uploadPhoto(wsId, visitId, token, fields, { withFile = true } = {}) {
  const fd = new FormData();
  if (withFile) fd.append('photo', new Blob([Buffer.from('fakejpegbytes')], { type: 'image/jpeg' }), 'p.jpg');
  for (const [k, val] of Object.entries(fields)) fd.append(k, String(val));
  return fetch(`${app.base}${fv(wsId)}/${visitId}/photos`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd,
  });
}

test('photo upload: valid GPS accepted; bad/missing GPS REJECTED at the API and no file kept', async () => {
  const v = await (await call('POST', fv(ID.wsA1), T.tech, { device_id: ID.devA1, visit_type: 'installation' })).json();
  const before = fs.readdirSync(path.join(PHOTO_DIR, 'field-visit-photos')).length;

  // happy path
  const ok = await uploadPhoto(ID.wsA1, v.id, T.tech, { latitude: 19.076, longitude: 72.8777, gps_accuracy_meters: 8.5, photo_category: 'device_front' });
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
    const r = await uploadPhoto(ID.wsA1, v.id, T.tech, f);
    assert.equal(r.status, 400, `expected 400 for ${JSON.stringify(f)}`);
  }
  // missing file entirely
  assert.equal((await uploadPhoto(ID.wsA1, v.id, T.tech, { latitude: 19, longitude: 72, gps_accuracy_meters: 5 }, { withFile: false })).status, 400);

  // exactly ONE new file on disk (the happy-path upload); every rejected upload cleaned up.
  const after = fs.readdirSync(path.join(PHOTO_DIR, 'field-visit-photos')).length;
  assert.equal(after - before, 1);

  // and it comes back on the detail view
  const detail = await (await call('GET', `${fv(ID.wsA1)}/${v.id}`, T.tech)).json();
  assert.equal(detail.photos.length, 1);
});

test('photo upload denied for a user without field-visit access (no file written)', async () => {
  const v = await (await call('POST', fv(ID.wsA1), T.tech, { device_id: ID.devA1, visit_type: 'installation' })).json();
  const before = fs.readdirSync(path.join(PHOTO_DIR, 'field-visit-photos')).length;
  const r = await uploadPhoto(ID.wsA1, v.id, T.nobody, { latitude: 19, longitude: 72, gps_accuracy_meters: 5 });
  assert.equal(r.status, 403);
  assert.equal(fs.readdirSync(path.join(PHOTO_DIR, 'field-visit-photos')).length, before);
});

// ==================== DUPLICATE-SUBMISSION SAFEGUARD ====================

test('client_visit_uuid makes a repeated POST idempotent (no double-post)', async () => {
  const uuid = 'client-uuid-' + crypto.randomBytes(4).toString('hex');
  const a = await call('POST', fv(ID.wsA1), T.tech, { device_id: ID.devA1, visit_type: 'installation', client_visit_uuid: uuid });
  assert.equal(a.status, 201);
  const first = await a.json();

  const b = await call('POST', fv(ID.wsA1), T.tech, { device_id: ID.devA1, visit_type: 'installation', client_visit_uuid: uuid });
  assert.equal(b.status, 200); // returned, not re-created
  assert.equal((await b.json()).id, first.id);

  assert.equal(await visitsWithUuid(uuid), 1);

  // same uuid, different workspace -> conflict
  const c = await call('POST', fv(ID.wsA2), T.tech, { device_id: ID.devA2, visit_type: 'installation', client_visit_uuid: uuid });
  assert.equal(c.status, 409);
});

test('concurrent identical POSTs with the same client_visit_uuid still yield ONE row', async () => {
  const uuid = 'race-uuid-' + crypto.randomBytes(4).toString('hex');
  const body = { device_id: ID.devA1, visit_type: 'installation', client_visit_uuid: uuid };
  const results = await Promise.all([
    call('POST', fv(ID.wsA1), T.tech, body),
    call('POST', fv(ID.wsA1), T.tech, body),
    call('POST', fv(ID.wsA1), T.tech, body),
  ]);
  for (const r of results) assert.ok(r.status === 201 || r.status === 200, `status ${r.status}`);
  assert.equal(await visitsWithUuid(uuid), 1);
});

// ============================ OTP FLOW ============================

const DUMMY_CODE = '000999';

test('OTP: correct dummy code issues a working BeamOS session token', async () => {
  const send = await call('POST', '/api/field-auth/send-otp', null, { phone: TECH_PHONE_TYPED });
  assert.equal(send.status, 200);
  assert.deepEqual(await send.json(), { sent: true });

  const verify = await call('POST', '/api/field-auth/verify-otp', null, { phone: TECH_PHONE, code: DUMMY_CODE });
  assert.equal(verify.status, 200);
  const out = await verify.json();
  assert.ok(out.token, 'token issued');
  assert.equal(out.user.id, U.tech);

  // the issued token is a real session token: it works on a gated route
  const c = await call('POST', fv(ID.wsA1), out.token, { device_id: ID.devA1, visit_type: 'installation' });
  assert.equal(c.status, 201);
});

test('OTP: wrong code and unknown phone both fail with 401', async () => {
  assert.equal((await call('POST', '/api/field-auth/verify-otp', null, { phone: TECH_PHONE, code: '000000' })).status, 401);
  // the PREVIOUS dummy code (123456) must now be rejected
  assert.equal((await call('POST', '/api/field-auth/verify-otp', null, { phone: TECH_PHONE, code: '123456' })).status, 401);
  assert.equal((await call('POST', '/api/field-auth/verify-otp', null, { phone: UNKNOWN_PHONE, code: DUMMY_CODE })).status, 401);
  assert.equal((await call('POST', '/api/field-auth/verify-otp', null, { phone: 'not-a-phone', code: DUMMY_CODE })).status, 400);
});

test('OTP: the placeholder/dummy nature is unmistakable in the source', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'field-auth.js'), 'utf8');
  assert.match(src, /PLACEHOLDER/);
  assert.match(src, /NOT PRODUCTION-READY/i);
  assert.match(src, /DUMMY_OTP_CODE\s*=\s*'000999'/);
  // the "send" path does not actually send anything - it logs
  assert.match(src, /no SMS sent|logs the fixed dummy code|console\.warn/);
});

test('OTP: the dummy code is NOT shown anywhere in the login UI', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'field-tech-src', 'src', 'screens', 'LoginScreen.jsx'), 'utf8');
  assert.doesNotMatch(src, /000999|123456/);
  assert.doesNotMatch(src, /dev-note|DEV_OTP_CODE/);
});
