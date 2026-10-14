'use strict';

// Ref 30 Stage 1: advance device registration codes.
//
// Drives the REAL router (routes/registration-codes.js) mounted exactly as
// server.js mounts it - requireAuth + the router, JWT-only, no resolveTenancy
// (helpers/inprocess-app.js) - against the REAL MySQL test DB (beamos_test via
// npm test). Covers:
//   - a code generates correctly (6 digits, status 'unused', persisted)
//   - codes are scoped to the workspace they were minted for
//   - RBAC: only workspace_admin and above can generate / list codes
//   - the QR endpoint returns a valid PNG that DECODES to the /activate/<code> URL
//
// Fixtures are test-owned (rc- prefix, generated ids) and removed afterwards:
// registration_codes.created_by has no ON DELETE action, so this file's codes are
// deleted first, then the users (newest first, so each org owner goes last).

const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const jsQR = require('jsqr');
const { db } = require('../db/database');
const { generateToken } = require('../middleware/auth');
const { startInProcessApp } = require('./helpers/inprocess-app');
const { randTag, cleanupUsers } = require('./helpers/disposable');

const P = `rc-${randTag()}`;
const id = (name) => `${P}-${name}`;
const ID = { orgA: id('org-a'), orgB: id('org-b'), wsA: id('ws-a'), wsB: id('ws-b'), devClaimed: id('dev-claimed') };
const U = {};
const tok = {};
const userIds = [];
let app;

test.before(async () => {
  app = await startInProcessApp({ only: ['/api/provisioning'] });
  const run = (sql, ...p) => app.db.prepare(sql).run(...p);

  // --- Seed: two orgs / workspaces, and a user at every role tier ---
  const mk = async (key, role, wsId) => {
    const uid = id(key);
    const email = `${uid}@t.test`;
    await run("INSERT INTO users (id, email, name, password_hash, auth_provider, role) VALUES (?, ?, ?, NULL, 'local', ?)", uid, email, uid, role);
    userIds.push(uid);
    U[key] = uid;
    tok[key] = generateToken({ id: uid, email, role }, wsId);
  };
  await mk('admin', 'user', ID.wsA);
  await mk('editor', 'user', ID.wsA);
  await mk('viewer', 'user', ID.wsA);
  await mk('orgadmin', 'user', ID.wsA);
  await mk('outsider', 'user', ID.wsB);
  await mk('platform', 'platform_admin', ID.wsA);

  const org = "INSERT INTO organizations (id, name, owner_user_id, plan_id, subscription_status) VALUES (?, ?, ?, 'enterprise', 'active')";
  await run(org, ID.orgA, `${P} Org A`, U.admin);
  await run(org, ID.orgB, `${P} Org B`, U.outsider);

  await run('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)', ID.wsA, ID.orgA, 'Workspace A');
  await run('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)', ID.wsB, ID.orgB, 'Workspace B');

  const wm = 'INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)';
  await run(wm, ID.wsA, U.admin, 'workspace_admin');
  await run(wm, ID.wsA, U.editor, 'workspace_editor');
  await run(wm, ID.wsA, U.viewer, 'workspace_viewer');
  await run("INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'org_admin')", ID.orgA, U.orgadmin);
  await run(wm, ID.wsB, U.outsider, 'workspace_admin');
});

test.after(async () => {
  try {
    if (app) {
      await app.db.prepare('DELETE FROM registration_codes WHERE workspace_id IN (?, ?)').run(ID.wsA, ID.wsB);
      await cleanupUsers(app.db, [...userIds].reverse());
    }
  } finally {
    if (app) await app.stop(); else await db.close();
  }
});

const codeRow = (codeId) => app.db.prepare('SELECT * FROM registration_codes WHERE id = ?').get(codeId);
const codeCount = async (codeId) => Number((await app.db.prepare('SELECT COUNT(*) AS n FROM registration_codes WHERE id = ?').get(codeId)).n);
const setExpiry = (codeId, at) => app.db.prepare('UPDATE registration_codes SET expires_at = ? WHERE id = ?').run(at, codeId);
const setClaimed = (codeId) => app.db.prepare("UPDATE registration_codes SET status = 'claimed' WHERE id = ?").run(codeId);

const authed = (token, extra = {}) => ({ headers: { Authorization: `Bearer ${token}`, ...extra } });
const postJson = (token, body) => ({
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const codes = () => `${app.base}/api/provisioning/registration-codes`;

test('generate: workspace_admin mints a 6-digit unused code, persisted + scoped', async () => {
  const res = await fetch(codes(), postJson(tok.admin, { workspace_id: ID.wsA, planned_device_name: '  Lobby screen  ' }));
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.match(body.code, /^[0-9]{6}$/, 'code is exactly 6 digits');
  assert.equal(body.status, 'unused');
  assert.equal(body.workspace_id, ID.wsA);
  assert.equal(body.planned_device_name, 'Lobby screen', 'planned name is trimmed');
  assert.equal(body.claimed_by_device_id, null);

  const row = await codeRow(body.id);
  assert.ok(row, 'row persisted');
  assert.equal(row.code, body.code);
  assert.equal(row.workspace_id, ID.wsA);
  assert.equal(row.created_by, U.admin);
});

test('generate: planned_device_name is optional', async () => {
  const res = await fetch(codes(), postJson(tok.admin, { workspace_id: ID.wsA }));
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.planned_device_name, null);
});

test('generate: sets expires_at ~30 days out and returns it', async () => {
  const t0 = Math.floor(Date.now() / 1000);
  const res = await fetch(codes(), postJson(tok.admin, { workspace_id: ID.wsA }));
  assert.equal(res.status, 201);
  const body = await res.json();
  const THIRTY_D = 30 * 24 * 60 * 60;
  assert.ok(Math.abs(body.expires_at - (t0 + THIRTY_D)) < 120, `expires_at ≈ created_at + 30d (got ${body.expires_at - t0}s)`);
  assert.equal(body.expired, false);

  const row = await codeRow(body.id);
  assert.equal(row.expires_at, body.expires_at, 'persisted');

  // And it shows up in the admin list.
  const list = await fetch(`${codes()}?workspace_id=${ID.wsA}`, authed(tok.admin)).then((r) => r.json());
  const listed = list.find((c) => c.code === body.code);
  assert.equal(listed.expires_at, body.expires_at);
  assert.equal(listed.expired, false);
});

test('list: an unused code past expires_at is reported expired:true', async () => {
  const res = await fetch(codes(), postJson(tok.admin, { workspace_id: ID.wsA }));
  const { id: codeId, code } = await res.json();
  await setExpiry(codeId, Math.floor(Date.now() / 1000) - 10);
  const list = await fetch(`${codes()}?workspace_id=${ID.wsA}`, authed(tok.admin)).then((r) => r.json());
  const row = list.find((c) => c.code === code);
  assert.equal(row.status, 'unused');
  assert.equal(row.expired, true);
});

test('regenerate: expired unused code -> fresh code + expiry, old row untouched (audit trail)', async () => {
  const mk = await fetch(codes(), postJson(tok.admin, { workspace_id: ID.wsA, planned_device_name: 'Warehouse gate' }));
  const oldRow = await mk.json();
  // Age it out.
  const staleExpiry = Math.floor(Date.now() / 1000) - 3600;
  await setExpiry(oldRow.id, staleExpiry);

  const t0 = Math.floor(Date.now() / 1000);
  const regen = await fetch(`${codes()}/${oldRow.id}/regenerate`, postJson(tok.admin, {}));
  assert.equal(regen.status, 201);
  const fresh = await regen.json();

  assert.notEqual(fresh.id, oldRow.id);
  assert.notEqual(fresh.code, oldRow.code);
  assert.equal(fresh.workspace_id, ID.wsA, 'reuses workspace');
  assert.equal(fresh.planned_device_name, 'Warehouse gate', 'reuses planned name');
  assert.equal(fresh.status, 'unused');
  assert.equal(fresh.expired, false);
  assert.ok(fresh.expires_at > t0 + 29 * 24 * 60 * 60, 'fresh 30-day expiry');

  // Old row is NOT deleted and NOT mutated - still unused, still with its stale expiry.
  const stillThere = await codeRow(oldRow.id);
  assert.ok(stillThere, 'old row kept for the audit trail');
  assert.equal(stillThere.status, 'unused');
  assert.equal(stillThere.expires_at, staleExpiry, 'old expiry unchanged');
  assert.equal(stillThere.code, oldRow.code);
});

test('regenerate: works on a still-valid unused code too', async () => {
  const mk = await fetch(codes(), postJson(tok.admin, { workspace_id: ID.wsA }));
  const oldRow = await mk.json();
  const regen = await fetch(`${codes()}/${oldRow.id}/regenerate`, postJson(tok.admin, {}));
  assert.equal(regen.status, 201);
  assert.notEqual((await regen.json()).code, oldRow.code);
});

test('regenerate: a claimed code cannot be regenerated (409)', async () => {
  const mk = await fetch(codes(), postJson(tok.admin, { workspace_id: ID.wsA }));
  const row = await mk.json();
  await setClaimed(row.id);
  const regen = await fetch(`${codes()}/${row.id}/regenerate`, postJson(tok.admin, {}));
  assert.equal(regen.status, 409);
});

test('regenerate: unknown id -> 404; non-admin -> 403', async () => {
  assert.equal((await fetch(`${codes()}/nope/regenerate`, postJson(tok.admin, {}))).status, 404);
  const mk = await fetch(codes(), postJson(tok.admin, { workspace_id: ID.wsA }));
  const row = await mk.json();
  assert.equal((await fetch(`${codes()}/${row.id}/regenerate`, postJson(tok.viewer, {}))).status, 403);
});

test('generate: codes are unique across repeated calls', async () => {
  const seen = new Set();
  for (let i = 0; i < 15; i++) {
    const res = await fetch(codes(), postJson(tok.admin, { workspace_id: ID.wsA }));
    assert.equal(res.status, 201);
    const { code } = await res.json();
    assert.equal(seen.has(code), false, `code ${code} was issued twice`);
    seen.add(code);
  }
});

test('scoping: list returns only the target workspace\'s codes', async () => {
  // Mint one code in ws-b (as its own admin).
  const bRes = await fetch(codes(), postJson(tok.outsider, { workspace_id: ID.wsB, planned_device_name: 'B screen' }));
  assert.equal(bRes.status, 201);
  const bCode = (await bRes.json()).code;

  const listA = await fetch(`${codes()}?workspace_id=${ID.wsA}`, authed(tok.admin)).then((r) => r.json());
  const listB = await fetch(`${codes()}?workspace_id=${ID.wsB}`, authed(tok.outsider)).then((r) => r.json());

  assert.ok(listA.length >= 3, 'ws-a has the codes minted above');
  assert.ok(listA.every((c) => c.workspace_id === ID.wsA), 'every ws-a row is ws-a');
  assert.ok(!listA.some((c) => c.code === bCode), 'ws-b code does not leak into ws-a list');
  assert.ok(listB.some((c) => c.code === bCode), 'ws-b list has its own code');
  assert.ok(listB.every((c) => c.workspace_id === ID.wsB));
});

test('scoping: an admin of another workspace cannot mint into ws-a', async () => {
  const res = await fetch(codes(), postJson(tok.outsider, { workspace_id: ID.wsA }));
  assert.equal(res.status, 403);
  const row = await app.db.prepare('SELECT COUNT(*) AS n FROM registration_codes WHERE created_by = ? AND workspace_id = ?').get(U.outsider, ID.wsA);
  assert.equal(Number(row.n), 0, 'nothing was written');
});

test('scoping: an admin of another workspace cannot list ws-a codes', async () => {
  const res = await fetch(`${codes()}?workspace_id=${ID.wsA}`, authed(tok.outsider));
  assert.equal(res.status, 403);
});

test('RBAC: workspace_editor is denied (403)', async () => {
  const res = await fetch(codes(), postJson(tok.editor, { workspace_id: ID.wsA }));
  assert.equal(res.status, 403);
});

test('RBAC: workspace_viewer is denied (403)', async () => {
  const res = await fetch(codes(), postJson(tok.viewer, { workspace_id: ID.wsA }));
  assert.equal(res.status, 403);
});

test('RBAC: org_admin of the parent org is allowed (201)', async () => {
  const res = await fetch(codes(), postJson(tok.orgadmin, { workspace_id: ID.wsA }));
  assert.equal(res.status, 201);
});

test('RBAC: platform_admin is allowed (201)', async () => {
  const res = await fetch(codes(), postJson(tok.platform, { workspace_id: ID.wsA }));
  assert.equal(res.status, 201);
});

test('RBAC: no token -> 401', async () => {
  const res = await fetch(codes(), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspace_id: ID.wsA }),
  });
  assert.equal(res.status, 401);
});

test('validation: missing workspace_id -> 400', async () => {
  const res = await fetch(codes(), postJson(tok.admin, {}));
  assert.equal(res.status, 400);
});

test('validation: unknown workspace_id -> 404', async () => {
  const res = await fetch(codes(), postJson(tok.admin, { workspace_id: id('ws-nope') }));
  assert.equal(res.status, 404);
});

// Decode a PNG QR buffer back to its string payload (real decode, not a
// byte-compare) — sharp rasterizes, jsQR reads the modules.
async function decodeQr(pngBuffer) {
  const { data, info } = await sharp(pngBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const res = jsQR(new Uint8ClampedArray(data), info.width, info.height);
  return res ? res.data : null;
}

test('QR: endpoint returns a valid PNG that DECODES to the /activate/<code> URL', async () => {
  const mkRes = await fetch(codes(), postJson(tok.admin, { workspace_id: ID.wsA }));
  const { id: codeId, code } = await mkRes.json();

  const qrRes = await fetch(`${codes()}/${codeId}/qr`, authed(tok.admin));
  assert.equal(qrRes.status, 200);
  assert.equal(qrRes.headers.get('content-type'), 'image/png');
  const buf = Buffer.from(await qrRes.arrayBuffer());

  // PNG magic number + a real, decodable 320x320 image.
  assert.deepEqual([...buf.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'starts with the PNG signature');
  const meta = await sharp(buf).metadata();
  assert.equal(meta.format, 'png');
  assert.equal(meta.width, 320);
  assert.equal(meta.height, 320);

  // ACTUALLY decode the QR (rasterize + read the modules) and check its payload.
  const decoded = await decodeQr(buf);
  assert.ok(decoded, 'the QR image decodes to a payload');
  // `app.base` here is http://127.0.0.1:<port>; the endpoint builds the URL from
  // req.protocol + req.get('host'), which is exactly that for this request.
  assert.equal(decoded, `${app.base}/activate/${code}`, 'QR payload is the full activation URL');
  assert.match(decoded, /^https?:\/\/[^/]+\/activate\/[0-9]{6}$/);
  assert.notEqual(decoded, code, 'it is NOT the bare 6-digit code any more');
});

test('QR: unknown code id -> 404', async () => {
  const res = await fetch(`${codes()}/does-not-exist/qr`, authed(tok.admin));
  assert.equal(res.status, 404);
});

test('QR: a non-admin of the code\'s workspace is denied (403)', async () => {
  const mkRes = await fetch(codes(), postJson(tok.admin, { workspace_id: ID.wsA }));
  const { id: codeId } = await mkRes.json();
  const res = await fetch(`${codes()}/${codeId}/qr`, authed(tok.viewer));
  assert.equal(res.status, 403);
});

test('list: claimed code surfaces the claiming device name', async () => {
  const mkRes = await fetch(codes(), postJson(tok.admin, { workspace_id: ID.wsA }));
  const { id: codeId, code } = await mkRes.json();
  await app.db.prepare("INSERT INTO devices (id, workspace_id, name, status) VALUES (?, ?, 'Front Desk TV', 'online')").run(ID.devClaimed, ID.wsA);
  await app.db.prepare("UPDATE registration_codes SET status = 'claimed', claimed_by_device_id = ?, claimed_at = ? WHERE id = ?")
    .run(ID.devClaimed, Math.floor(Date.now() / 1000), codeId);

  const list = await fetch(`${codes()}?workspace_id=${ID.wsA}`, authed(tok.admin)).then((r) => r.json());
  const row = list.find((c) => c.code === code);
  assert.equal(row.status, 'claimed');
  assert.equal(row.claimed_by_device_id, ID.devClaimed);
  assert.equal(row.claimed_by_device_name, 'Front Desk TV');
});

const del = (codeId, token, opts = '') => fetch(`${codes()}/${codeId}${opts}`, {
  method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
});

test('delete: an unused code is removed from the list', async () => {
  const { id: codeId, code } = await (await fetch(codes(), postJson(tok.admin, { workspace_id: ID.wsA }))).json();
  const res = await del(codeId, tok.admin);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { success: true });
  assert.equal(await codeCount(codeId), 0, 'row gone');
  const list = await fetch(`${codes()}?workspace_id=${ID.wsA}`, authed(tok.admin)).then((r) => r.json());
  assert.ok(!list.some((c) => c.code === code));
});

test('delete: an expired unused code is freely deletable', async () => {
  const { id: codeId } = await (await fetch(codes(), postJson(tok.admin, { workspace_id: ID.wsA }))).json();
  await setExpiry(codeId, Math.floor(Date.now() / 1000) - 100);
  assert.equal((await del(codeId, tok.admin)).status, 200);
  assert.equal(await codeCount(codeId), 0);
});

test('delete: a claimed code is refused without force (409, row kept)', async () => {
  const { id: codeId } = await (await fetch(codes(), postJson(tok.admin, { workspace_id: ID.wsA }))).json();
  await setClaimed(codeId);

  const res = await del(codeId, tok.admin);
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.requires_confirmation, true);
  assert.match(body.error, /claimed by a device/i);
  assert.equal(await codeCount(codeId), 1, 'row kept');
});

test('delete: a claimed code IS deletable with ?force=true', async () => {
  const { id: codeId } = await (await fetch(codes(), postJson(tok.admin, { workspace_id: ID.wsA }))).json();
  await setClaimed(codeId);
  assert.equal((await del(codeId, tok.admin, '?force=true')).status, 200);
  assert.equal(await codeCount(codeId), 0);
});

test('delete: unknown id -> 404', async () => {
  assert.equal((await del('nope', tok.admin)).status, 404);
});

test('delete: RBAC - workspace_viewer denied (403), row kept', async () => {
  const { id: codeId } = await (await fetch(codes(), postJson(tok.admin, { workspace_id: ID.wsA }))).json();
  assert.equal((await del(codeId, tok.viewer)).status, 403);
  assert.equal(await codeCount(codeId), 1);
});

test('delete: RBAC - an admin of another workspace cannot delete a ws-a code (403)', async () => {
  const { id: codeId } = await (await fetch(codes(), postJson(tok.admin, { workspace_id: ID.wsA }))).json();
  assert.equal((await del(codeId, tok.outsider)).status, 403);
  assert.equal(await codeCount(codeId), 1);
});
