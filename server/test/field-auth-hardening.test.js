'use strict';

// PMI critical security fix, Stage 1: /api/field-auth authentication bypass.
//
// verify-otp used to accept the public fixed code ('000999') for ANY user whose
// users.phone matched and mint that user's real session (owner, admin, platform
// admin...), skipping TOTP and Ref 5 SSO-only, with no feature flag. Now:
//   - off unless FIELD_OTP_ENABLED; server.js mounts nothing when off (404);
//   - server.js refuses to boot with the flag set under NODE_ENV=production;
//   - a session is issued ONLY to technician-only accounts (users.role 'user',
//     >= 1 field_technician org row, no other org role, no workspace row, no TOTP);
//     every other account gets the SAME generic 401 + a failed-login audit row.
//
// Part A runs the REAL router in-process against the REAL MySQL database
// (helpers/inprocess-app.js), toggling config.fieldOtpEnabled per test. Every
// fixture is a disposable, randomly-suffixed row removed in after(). activity_log
// rows are deliberately NOT deleted: they are hash-chained (Ref 17) and removing
// them would break GET /api/activity/verify-integrity for everything after them.
// Part B spawns real `node server.js` children to prove the mount gate and the
// production startup guard.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const bcrypt = require('bcryptjs');

const config = require('../config');
const { initDb } = require('../db/database');
const { startInProcessApp } = require('./helpers/inprocess-app');
const { randTag } = require('./helpers/disposable');

const CODE = '000999';
const GENERIC_401 = { error: 'Invalid or expired code' };
const PASSWORD = 'field-hardening-pw-9';

let app;
let savedFlag;
let auditFloor = 0; // activity_log.id high-water mark at start
const users = [];
const orgs = [];
const workspaces = [];

test.before(async () => {
  await initDb();
  app = await startInProcessApp({ only: [] }); // /api/auth only
  app.app.use('/api/field-auth', require('../routes/field-auth'));
  savedFlag = config.fieldOtpEnabled;
  const row = await app.db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM activity_log').get();
  auditFloor = Number(row.m);
});

test.after(async () => {
  config.fieldOtpEnabled = savedFlag;
  const db = app.db;
  for (const id of users) {
    await db.prepare('DELETE FROM workspace_members WHERE user_id = ?').run(id);
    await db.prepare('DELETE FROM organization_members WHERE user_id = ?').run(id);
  }
  for (const id of workspaces) await db.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
  for (const id of orgs) await db.prepare('DELETE FROM organizations WHERE id = ?').run(id);
  for (const id of users) await db.prepare('DELETE FROM users WHERE id = ?').run(id);
  await app.stop();
});

// ---------------------------------------------------------------- fixtures

function randPhone() {
  for (;;) {
    const p = `+9197${String(crypto.randomInt(0, 1e8)).padStart(8, '0')}`;
    if (!p.includes(CODE)) return p;
  }
}

async function mkUser({ role = 'user', password = null, totp = false } = {}) {
  const id = `fah-${randTag()}${randTag()}`;
  const email = `${id}@field-hardening.local`;
  const phone = randPhone();
  await app.db
    .prepare(
      `INSERT INTO users (id, email, name, password_hash, auth_provider, role, plan_id, phone, totp_enabled)
       VALUES (?, ?, ?, ?, 'local', ?, 'enterprise', ?, ?)`,
    )
    .run(id, email, 'Field Hardening', password ? bcrypt.hashSync(password, 4) : null, role, phone, totp ? 1 : 0);
  users.push(id);
  return { id, email, phone };
}

// One org (+ one workspace) owned by a phone-less owner account.
async function mkOrg({ ssoOnly = false } = {}) {
  const owner = await mkUser();
  const orgId = `fah-org-${randTag()}`;
  await app.db
    .prepare('INSERT INTO organizations (id, name, owner_user_id, plan_id) VALUES (?, ?, ?, ?)')
    .run(orgId, `FAH ${orgId}`, owner.id, 'enterprise');
  orgs.push(orgId);
  if (ssoOnly) await app.db.prepare('UPDATE organizations SET sso_only = 1 WHERE id = ?').run(orgId);
  await app.db.prepare('UPDATE users SET phone = NULL WHERE id = ?').run(owner.id);
  const wsId = `fah-ws-${randTag()}`;
  await app.db
    .prepare('INSERT INTO workspaces (id, organization_id, name, created_by) VALUES (?, ?, ?, ?)')
    .run(wsId, orgId, 'FAH WS', owner.id);
  workspaces.push(wsId);
  return { orgId, wsId };
}

const orgRole = (orgId, userId, role) =>
  app.db.prepare('INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, ?)').run(orgId, userId, role);
const wsRole = (wsId, userId, role) =>
  app.db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)').run(wsId, userId, role);

let ORG; // plain org shared by most cases
async function org() {
  if (!ORG) ORG = await mkOrg();
  return ORG;
}

// ---------------------------------------------------------------- http

async function post(p, body) {
  const r = await fetch(`${app.base}${p}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: r.status, text, json };
}
const verify = (phone, code = CODE) => post('/api/field-auth/verify-otp', { phone, code });

// logActivity is fire-and-forget from the route - poll briefly for the row.
async function failedLoginRows(phone) {
  for (let i = 0; i < 40; i++) {
    const rows = await app.db
      .prepare("SELECT id, user_id, details, ip_address FROM activity_log WHERE id > ? AND action = 'auth:login_failed' AND details LIKE ?")
      .all(auditFloor, `${phone}%`);
    if (rows.length) return rows;
    await new Promise((r) => setTimeout(r, 50));
  }
  return [];
}

// Asserts the generic 401 (status + exact body) and a failed-login audit row
// (phone + IP, never the code).
async function assertRefused(phone, label) {
  const r = await verify(phone);
  assert.equal(r.status, 401, `${label}: status`);
  assert.deepEqual(r.json, GENERIC_401, `${label}: body`);
  const rows = await failedLoginRows(phone);
  assert.ok(rows.length >= 1, `${label}: an auth:login_failed audit row was written`);
  for (const row of rows) {
    assert.ok(!row.details.includes(CODE), `${label}: audit row must not contain the code`);
    assert.ok(row.ip_address, `${label}: audit row records the IP`);
  }
  return r;
}

// =================================================================== A. router

test('disabled (default): send-otp and verify-otp both 404', async () => {
  config.fieldOtpEnabled = false;
  const u = await mkUser();
  assert.equal((await post('/api/field-auth/send-otp', { phone: u.phone })).status, 404);
  assert.equal((await verify(u.phone)).status, 404);
});

test('config: FIELD_OTP_ENABLED parses only "true"/"1" (case-insensitive), default false', () => {
  const load = (v) => {
    const saved = process.env.FIELD_OTP_ENABLED;
    if (v === undefined) delete process.env.FIELD_OTP_ENABLED; else process.env.FIELD_OTP_ENABLED = v;
    const p = require.resolve('../config');
    const cached = require.cache[p];
    delete require.cache[p];
    try { return require('../config').fieldOtpEnabled; } finally {
      require.cache[p] = cached;
      if (saved === undefined) delete process.env.FIELD_OTP_ENABLED; else process.env.FIELD_OTP_ENABLED = saved;
    }
  };
  assert.equal(load(undefined), false);
  for (const v of ['true', 'TRUE', 'True', '1']) assert.equal(load(v), true, v);
  for (const v of ['', 'false', '0', 'yes', 'on', 'enabled']) assert.equal(load(v), false, v);
});

test('enabled (non-production): a technician-only user signs in with the placeholder code', async () => {
  config.fieldOtpEnabled = true;
  const { orgId } = await org();
  const tech = await mkUser();
  await orgRole(orgId, tech.id, 'field_technician');
  const send = await post('/api/field-auth/send-otp', { phone: tech.phone });
  assert.equal(send.status, 200);
  assert.deepEqual(send.json, { sent: true });
  const r = await verify(tech.phone);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.user.id, tech.id);
  assert.equal(r.json.current_workspace_id, null);
  assert.ok(r.json.token);
  // and the session is real
  const me = await fetch(`${app.base}/api/auth/me`, { headers: { Authorization: `Bearer ${r.json.token}` } });
  assert.equal(me.status, 200);
});

test('send-otp stays uniform (no enumeration) for unknown and ineligible phones', async () => {
  config.fieldOtpEnabled = true;
  const admin = await mkUser({ role: 'platform_admin' });
  for (const phone of [randPhone(), admin.phone]) {
    const r = await post('/api/field-auth/send-otp', { phone });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { sent: true });
  }
});

test('generic 401 + audit row for every non-technician-only account holding a phone and the correct code', async () => {
  config.fieldOtpEnabled = true;
  const { orgId, wsId } = await org();
  const cases = [];

  const owner = await mkUser(); await orgRole(orgId, owner.id, 'org_owner'); cases.push(['org_owner', owner]);
  const admin = await mkUser(); await orgRole(orgId, admin.id, 'org_admin'); cases.push(['org_admin', admin]);
  for (const role of ['workspace_admin', 'workspace_editor', 'workspace_viewer']) {
    const u = await mkUser(); await wsRole(wsId, u.id, role); cases.push([role, u]);
  }
  const regional = await mkUser(); await orgRole(orgId, regional.id, 'regional_viewer'); cases.push(['regional_viewer', regional]);
  cases.push(['platform_admin', await mkUser({ role: 'platform_admin' })]);
  cases.push(['superadmin', await mkUser({ role: 'superadmin' })]);
  // platform admin who ALSO carries a field_technician row - still refused (role != 'user')
  const platTech = await mkUser({ role: 'platform_admin' }); await orgRole(orgId, platTech.id, 'field_technician');
  cases.push(['platform_admin + field_technician', platTech]);

  // technician who also holds another org role (in a second org)
  const other = await mkOrg();
  const techPlusAdmin = await mkUser();
  await orgRole(orgId, techPlusAdmin.id, 'field_technician');
  await orgRole(other.orgId, techPlusAdmin.id, 'org_admin');
  cases.push(['technician + org_admin elsewhere', techPlusAdmin]);
  // technician who also has a workspace row
  const techPlusWs = await mkUser();
  await orgRole(orgId, techPlusWs.id, 'field_technician');
  await wsRole(wsId, techPlusWs.id, 'workspace_viewer');
  cases.push(['technician + workspace row', techPlusWs]);
  // technician with TOTP enabled
  const techTotp = await mkUser({ totp: true });
  await orgRole(orgId, techTotp.id, 'field_technician');
  cases.push(['technician + TOTP', techTotp]);
  // a plain user with no memberships at all
  cases.push(['no memberships', await mkUser()]);

  // baselines: wrong code and unknown phone
  const tech = await mkUser(); await orgRole(orgId, tech.id, 'field_technician');
  const wrong = await verify(tech.phone, '123123');
  const unknownPhone = randPhone();
  const unknown = await verify(unknownPhone);

  for (const [label, u] of cases) {
    const r = await assertRefused(u.phone, label);
    // indistinguishable from wrong code / unknown phone
    assert.equal(r.status, wrong.status, `${label} vs wrong code`);
    assert.equal(r.text, wrong.text, `${label} vs wrong code (body bytes)`);
    assert.equal(r.text, unknown.text, `${label} vs unknown phone (body bytes)`);
  }
  assert.equal(unknown.status, 401);
  assert.equal((await failedLoginRows(unknownPhone)).length >= 1, true, 'unknown phone is audited too');
});

test('deactivated technician: refused with 403 after the code check, as before', async () => {
  config.fieldOtpEnabled = true;
  const { orgId } = await org();
  const tech = await mkUser();
  await orgRole(orgId, tech.id, 'field_technician');
  await app.db.prepare('UPDATE users SET deactivated_at = UNIX_TIMESTAMP() WHERE id = ?').run(tech.id);
  const ok = await verify(tech.phone);
  assert.equal(ok.status, 403);
  assert.match(ok.json.error, /deactivated/);
  const wrong = await verify(tech.phone, '123123');
  assert.equal(wrong.status, 401);
  assert.deepEqual(wrong.json, GENERIC_401);
});

test('SSO-only org: technician-only user allowed; org_admin with a phone gets the generic 401', async () => {
  config.fieldOtpEnabled = true;
  const sso = await mkOrg({ ssoOnly: true });
  const tech = await mkUser();
  await orgRole(sso.orgId, tech.id, 'field_technician');
  const r = await verify(tech.phone);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.user.id, tech.id);

  const admin = await mkUser();
  await orgRole(sso.orgId, admin.id, 'org_admin');
  await assertRefused(admin.phone, 'org_admin in SSO-only org');
});

test('email/password fallback (unchanged): technician-only user with a password can log in; refused in an SSO-only org', async () => {
  const { orgId } = await org();
  const tech = await mkUser({ password: PASSWORD });
  await orgRole(orgId, tech.id, 'field_technician');
  const ok = await post('/api/auth/login', { email: tech.email, password: PASSWORD });
  assert.equal(ok.status, 200, ok.text);
  assert.ok(ok.json.token);
  assert.equal(ok.json.user.id, tech.id);
  // no personal org was minted for the technician
  const owned = await app.db.prepare('SELECT COUNT(*) AS n FROM organizations WHERE owner_user_id = ?').get(tech.id);
  assert.equal(Number(owned.n), 0);

  const sso = await mkOrg({ ssoOnly: true });
  const ssoTech = await mkUser({ password: PASSWORD });
  await orgRole(sso.orgId, ssoTech.id, 'field_technician');
  const refused = await post('/api/auth/login', { email: ssoTech.email, password: PASSWORD });
  assert.equal(refused.status, 403);
  assert.equal(refused.json.code, 'SSO_REQUIRED');
});

test('no audit row written during this file contains the submitted code', async () => {
  await new Promise((r) => setTimeout(r, 200)); // let fire-and-forget writes land
  const row = await app.db
    .prepare('SELECT COUNT(*) AS n FROM activity_log WHERE id > ? AND details LIKE ?')
    .get(auditFloor, `%${CODE}%`);
  assert.equal(Number(row.n), 0);
});

// =================================================================== B. server.js

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

const SERVER_DIR = path.join(__dirname, '..');
const CERTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fah-certs-')); // no certs -> plain HTTP

function bootServer(env) {
  const child = spawn(process.execPath, ['--env-file-if-exists=.env', 'server.js'], {
    cwd: SERVER_DIR,
    env: { ...process.env, CERTS_DIR, JWT_SECRET: 'fah-child-secret', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, exited, output: () => out };
}

async function waitUp(base, exited) {
  let dead = false;
  exited.then(() => { dead = true; });
  for (let i = 0; i < 300 && !dead; i++) {
    try { const r = await fetch(`${base}/api/status`); if (r.ok) return true; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function stopServer(s) {
  if (s.child.exitCode === null) s.child.kill();
  await s.exited;
}

test('startup guard: NODE_ENV=production + FIELD_OTP_ENABLED=true refuses to start (non-zero exit, clear message)', async () => {
  const port = await freePort();
  const s = bootServer({ NODE_ENV: 'production', FIELD_OTP_ENABLED: 'true', PORT: String(port) });
  const code = await Promise.race([s.exited, new Promise((r) => setTimeout(() => r('timeout'), 60000))]);
  if (code === 'timeout') await stopServer(s);
  assert.notEqual(code, 'timeout', `server should have exited; output:\n${s.output()}`);
  assert.notEqual(code, 0);
  assert.match(s.output(), /FIELD_OTP_ENABLED cannot be used in production: the field OTP is a development\/test placeholder/);
});

test('production + disabled: starts, and both field-auth routes 404', async () => {
  const port = await freePort();
  const s = bootServer({ NODE_ENV: 'production', FIELD_OTP_ENABLED: 'false', PORT: String(port) });
  const base = `http://127.0.0.1:${port}`;
  try {
    assert.ok(await waitUp(base, s.exited), `server did not start; output:\n${s.output()}`);
    for (const p of ['/api/field-auth/send-otp', '/api/field-auth/verify-otp']) {
      const r = await fetch(base + p, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone: randPhone(), code: CODE }),
      });
      assert.equal(r.status, 404, p);
    }
  } finally {
    await stopServer(s);
  }
});

test('non-production + enabled: server.js mounts the route (send-otp answers 200)', async () => {
  const port = await freePort();
  const s = bootServer({ NODE_ENV: 'test', FIELD_OTP_ENABLED: 'true', PORT: String(port) });
  const base = `http://127.0.0.1:${port}`;
  try {
    assert.ok(await waitUp(base, s.exited), `server did not start; output:\n${s.output()}`);
    const r = await fetch(`${base}/api/field-auth/send-otp`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: randPhone() }),
    });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { sent: true });
  } finally {
    await stopServer(s);
    fs.rmSync(CERTS_DIR, { recursive: true, force: true });
  }
});
