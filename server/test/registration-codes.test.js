'use strict';

// Ref 30 Stage 1: advance device registration codes.
//
// Drives the REAL router (routes/registration-codes.js) mounted exactly as
// server.js mounts it - requireAuth + the router, JWT-only, no resolveTenancy -
// against an in-memory better-sqlite3 DB swapped in for db/database.js (the same
// pattern as tenancy-cross-tenant.test.js). Covers:
//   - a code generates correctly (6 digits, status 'unused', persisted)
//   - codes are scoped to the workspace they were minted for
//   - RBAC: only workspace_admin and above can generate / list codes
//   - the QR endpoint returns a valid PNG that encodes the code

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const QRCode = require('qrcode');
const sharp = require('sharp');

process.env.JWT_SECRET = 'test-secret-registration-codes';

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE users (
    id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT DEFAULT '',
    role TEXT NOT NULL DEFAULT 'user', auth_provider TEXT NOT NULL DEFAULT 'local',
    avatar_url TEXT, plan_id TEXT DEFAULT 'free', email_alerts INTEGER DEFAULT 1,
    must_change_password INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE organizations (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_user_id TEXT NOT NULL
  );
  CREATE TABLE organization_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT, organization_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL
  );
  CREATE TABLE workspaces (
    id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, name TEXT NOT NULL
  );
  CREATE TABLE workspace_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, user_id TEXT NOT NULL,
    role TEXT NOT NULL, joined_at INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE devices (
    id TEXT PRIMARY KEY, workspace_id TEXT, name TEXT DEFAULT '', status TEXT DEFAULT 'offline'
  );
  CREATE TABLE registration_codes (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    workspace_id TEXT NOT NULL,
    planned_device_name TEXT,
    status TEXT NOT NULL DEFAULT 'unused',
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    claimed_by_device_id TEXT,
    claimed_at INTEGER
  );
`);

const dbModulePath = require.resolve('../db/database');
require.cache[dbModulePath] = { id: dbModulePath, filename: dbModulePath, loaded: true, exports: { db } };

const express = require('express');
const { generateToken, requireAuth } = require('../middleware/auth');
const registrationCodesRouter = require('../routes/registration-codes');

// --- Seed: two orgs / workspaces, and a user at every role tier -------------
db.prepare("INSERT INTO users (id, email, role) VALUES ('u-admin', 'admin@a.test', 'user')").run();
db.prepare("INSERT INTO users (id, email, role) VALUES ('u-editor', 'editor@a.test', 'user')").run();
db.prepare("INSERT INTO users (id, email, role) VALUES ('u-viewer', 'viewer@a.test', 'user')").run();
db.prepare("INSERT INTO users (id, email, role) VALUES ('u-orgadmin', 'orgadmin@a.test', 'user')").run();
db.prepare("INSERT INTO users (id, email, role) VALUES ('u-outsider', 'outsider@b.test', 'user')").run();
db.prepare("INSERT INTO users (id, email, role) VALUES ('u-platform', 'root@platform.test', 'platform_admin')").run();

db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES ('org-a', 'Org A', 'u-admin')").run();
db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES ('org-b', 'Org B', 'u-outsider')").run();

db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES ('ws-a', 'org-a', 'Workspace A')").run();
db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES ('ws-b', 'org-b', 'Workspace B')").run();

db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('ws-a', 'u-admin', 'workspace_admin')").run();
db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('ws-a', 'u-editor', 'workspace_editor')").run();
db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('ws-a', 'u-viewer', 'workspace_viewer')").run();
db.prepare("INSERT INTO organization_members (organization_id, user_id, role) VALUES ('org-a', 'u-orgadmin', 'org_admin')").run();
db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('ws-b', 'u-outsider', 'workspace_admin')").run();

const tok = {
  admin: generateToken({ id: 'u-admin', email: 'admin@a.test', role: 'user' }, 'ws-a'),
  editor: generateToken({ id: 'u-editor', email: 'editor@a.test', role: 'user' }, 'ws-a'),
  viewer: generateToken({ id: 'u-viewer', email: 'viewer@a.test', role: 'user' }, 'ws-a'),
  orgadmin: generateToken({ id: 'u-orgadmin', email: 'orgadmin@a.test', role: 'user' }, 'ws-a'),
  outsider: generateToken({ id: 'u-outsider', email: 'outsider@b.test', role: 'user' }, 'ws-b'),
  platform: generateToken({ id: 'u-platform', email: 'root@platform.test', role: 'platform_admin' }, 'ws-a'),
};

const app = express();
app.use(express.json());
app.use('/api/provisioning', requireAuth, registrationCodesRouter);
app.use((err, req, res, _next) => { res.status(500).json({ error: err.message }); });

const server = app.listen(0);
let base;
test.before(async () => {
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); db.close(); });

const authed = (token, extra = {}) => ({ headers: { Authorization: `Bearer ${token}`, ...extra } });
const postJson = (token, body) => ({
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

test('generate: workspace_admin mints a 6-digit unused code, persisted + scoped', async () => {
  const res = await fetch(`${base}/api/provisioning/registration-codes`,
    postJson(tok.admin, { workspace_id: 'ws-a', planned_device_name: '  Lobby screen  ' }));
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.match(body.code, /^[0-9]{6}$/, 'code is exactly 6 digits');
  assert.equal(body.status, 'unused');
  assert.equal(body.workspace_id, 'ws-a');
  assert.equal(body.planned_device_name, 'Lobby screen', 'planned name is trimmed');
  assert.equal(body.claimed_by_device_id, null);

  const row = db.prepare('SELECT * FROM registration_codes WHERE id = ?').get(body.id);
  assert.ok(row, 'row persisted');
  assert.equal(row.code, body.code);
  assert.equal(row.workspace_id, 'ws-a');
  assert.equal(row.created_by, 'u-admin');
});

test('generate: planned_device_name is optional', async () => {
  const res = await fetch(`${base}/api/provisioning/registration-codes`,
    postJson(tok.admin, { workspace_id: 'ws-a' }));
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.planned_device_name, null);
});

test('generate: codes are unique across repeated calls', async () => {
  const seen = new Set();
  for (let i = 0; i < 15; i++) {
    const res = await fetch(`${base}/api/provisioning/registration-codes`, postJson(tok.admin, { workspace_id: 'ws-a' }));
    assert.equal(res.status, 201);
    const { code } = await res.json();
    assert.equal(seen.has(code), false, `code ${code} was issued twice`);
    seen.add(code);
  }
});

test('scoping: list returns only the target workspace\'s codes', async () => {
  // Mint one code in ws-b (as its own admin).
  const bRes = await fetch(`${base}/api/provisioning/registration-codes`,
    postJson(tok.outsider, { workspace_id: 'ws-b', planned_device_name: 'B screen' }));
  assert.equal(bRes.status, 201);
  const bCode = (await bRes.json()).code;

  const listA = await fetch(`${base}/api/provisioning/registration-codes?workspace_id=ws-a`, authed(tok.admin)).then((r) => r.json());
  const listB = await fetch(`${base}/api/provisioning/registration-codes?workspace_id=ws-b`, authed(tok.outsider)).then((r) => r.json());

  assert.ok(listA.length >= 3, 'ws-a has the codes minted above');
  assert.ok(listA.every((c) => c.workspace_id === 'ws-a'), 'every ws-a row is ws-a');
  assert.ok(!listA.some((c) => c.code === bCode), 'ws-b code does not leak into ws-a list');
  assert.ok(listB.some((c) => c.code === bCode), 'ws-b list has its own code');
  assert.ok(listB.every((c) => c.workspace_id === 'ws-b'));
});

test('scoping: an admin of another workspace cannot mint into ws-a', async () => {
  const res = await fetch(`${base}/api/provisioning/registration-codes`,
    postJson(tok.outsider, { workspace_id: 'ws-a' }));
  assert.equal(res.status, 403);
  const row = db.prepare("SELECT COUNT(*) AS n FROM registration_codes WHERE created_by = 'u-outsider' AND workspace_id = 'ws-a'").get();
  assert.equal(row.n, 0, 'nothing was written');
});

test('scoping: an admin of another workspace cannot list ws-a codes', async () => {
  const res = await fetch(`${base}/api/provisioning/registration-codes?workspace_id=ws-a`, authed(tok.outsider));
  assert.equal(res.status, 403);
});

test('RBAC: workspace_editor is denied (403)', async () => {
  const res = await fetch(`${base}/api/provisioning/registration-codes`, postJson(tok.editor, { workspace_id: 'ws-a' }));
  assert.equal(res.status, 403);
});

test('RBAC: workspace_viewer is denied (403)', async () => {
  const res = await fetch(`${base}/api/provisioning/registration-codes`, postJson(tok.viewer, { workspace_id: 'ws-a' }));
  assert.equal(res.status, 403);
});

test('RBAC: org_admin of the parent org is allowed (201)', async () => {
  const res = await fetch(`${base}/api/provisioning/registration-codes`, postJson(tok.orgadmin, { workspace_id: 'ws-a' }));
  assert.equal(res.status, 201);
});

test('RBAC: platform_admin is allowed (201)', async () => {
  const res = await fetch(`${base}/api/provisioning/registration-codes`, postJson(tok.platform, { workspace_id: 'ws-a' }));
  assert.equal(res.status, 201);
});

test('RBAC: no token -> 401', async () => {
  const res = await fetch(`${base}/api/provisioning/registration-codes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspace_id: 'ws-a' }),
  });
  assert.equal(res.status, 401);
});

test('validation: missing workspace_id -> 400', async () => {
  const res = await fetch(`${base}/api/provisioning/registration-codes`, postJson(tok.admin, {}));
  assert.equal(res.status, 400);
});

test('validation: unknown workspace_id -> 404', async () => {
  const res = await fetch(`${base}/api/provisioning/registration-codes`, postJson(tok.admin, { workspace_id: 'ws-nope' }));
  assert.equal(res.status, 404);
});

test('QR: endpoint returns a valid PNG that encodes the code', async () => {
  const mkRes = await fetch(`${base}/api/provisioning/registration-codes`, postJson(tok.admin, { workspace_id: 'ws-a' }));
  const { id, code } = await mkRes.json();

  const qrRes = await fetch(`${base}/api/provisioning/registration-codes/${id}/qr`, authed(tok.admin));
  assert.equal(qrRes.status, 200);
  assert.equal(qrRes.headers.get('content-type'), 'image/png');
  const buf = Buffer.from(await qrRes.arrayBuffer());

  // PNG magic number.
  assert.deepEqual([...buf.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'starts with the PNG signature');

  // It is a real, decodable 320x320 PNG (sharp parses the container + IDAT).
  const meta = await sharp(buf).metadata();
  assert.equal(meta.format, 'png');
  assert.equal(meta.width, 320);
  assert.equal(meta.height, 320);

  // Byte-identical to a fresh render of THIS code with the endpoint's options,
  // and NOT identical to a render of a different code -> the image encodes `code`.
  const opts = { type: 'png', errorCorrectionLevel: 'M', margin: 2, width: 320 };
  assert.ok(buf.equals(await QRCode.toBuffer(code, opts)), 'QR encodes the issued code');
  const otherCode = code === '000000' ? '111111' : '000000';
  assert.ok(!buf.equals(await QRCode.toBuffer(otherCode, opts)), 'QR is not a fixed image');
});

test('QR: unknown code id -> 404', async () => {
  const res = await fetch(`${base}/api/provisioning/registration-codes/does-not-exist/qr`, authed(tok.admin));
  assert.equal(res.status, 404);
});

test('QR: a non-admin of the code\'s workspace is denied (403)', async () => {
  const mkRes = await fetch(`${base}/api/provisioning/registration-codes`, postJson(tok.admin, { workspace_id: 'ws-a' }));
  const { id } = await mkRes.json();
  const res = await fetch(`${base}/api/provisioning/registration-codes/${id}/qr`, authed(tok.viewer));
  assert.equal(res.status, 403);
});

test('list: claimed code surfaces the claiming device name', async () => {
  const mkRes = await fetch(`${base}/api/provisioning/registration-codes`, postJson(tok.admin, { workspace_id: 'ws-a' }));
  const { id, code } = await mkRes.json();
  db.prepare("INSERT INTO devices (id, workspace_id, name, status) VALUES ('dev-claimed', 'ws-a', 'Front Desk TV', 'online')").run();
  db.prepare("UPDATE registration_codes SET status = 'claimed', claimed_by_device_id = 'dev-claimed', claimed_at = ? WHERE id = ?")
    .run(Math.floor(Date.now() / 1000), id);

  const list = await fetch(`${base}/api/provisioning/registration-codes?workspace_id=ws-a`, authed(tok.admin)).then((r) => r.json());
  const row = list.find((c) => c.code === code);
  assert.equal(row.status, 'claimed');
  assert.equal(row.claimed_by_device_id, 'dev-claimed');
  assert.equal(row.claimed_by_device_name, 'Front Desk TV');
});
