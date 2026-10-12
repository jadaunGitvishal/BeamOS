'use strict';

// Ref 30 Stage 2: device self-claim with a pre-generated registration code.
//
// Drives the REAL claimRouter (routes/registration-codes.js) mounted exactly as
// server.js mounts it - on its own public path, NO requireAuth - against the real
// MySQL test database (beamos_test via npm test). Users, orgs, workspaces, codes and
// fingerprints are test-owned (per-run prefix / random unused codes); claimed devices
// live in this file's workspaces and are removed with them. Covers:
//   - happy path with and without a planned_device_name (workspace + name assignment)
//   - the device row lands in the exact end state the pairing_code flow produces
//   - fingerprint linking (insert + update-on-reclaim)
//   - error handling: unknown code, already-claimed code, malformed code
//   - a code can be claimed exactly once (no double-claim, no second device row)
//   - device_info persistence + workspace scoping
//   - the Stage 1 admin list then shows the code 'claimed' with the device name

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { db, initDb } = require('../db/database');
const { hashDeviceToken } = require('../lib/device-token');
const { deleteOrgCascade } = require('../lib/user-deletion');

const express = require('express');
const registrationCodes = require('../routes/registration-codes');

const P = 'RC-' + crypto.randomBytes(4).toString('hex');
const id = (s) => `${P}-${s}`;
const FP = (s) => `${P}-${s}`;
const WS_A = id('ws-a'), WS_B = id('ws-b'), U_ADMIN = id('u-admin'), U_ADMIN_B = id('u-admin-b');
const codeIds = [];

// A random 6-digit code no row uses yet (codes are globally unique).
async function freshCode() {
  for (;;) {
    const c = String(crypto.randomInt(100000, 1000000));
    if (!(await db.prepare('SELECT 1 FROM registration_codes WHERE code = ?').get(c))) return c;
  }
}

let seq = 0;
async function seedCode(overrides = {}) {
  const row = {
    id: id(`rc-${seq++}`),
    code: await freshCode(),
    workspace_id: WS_A,
    planned_device_name: null,
    status: 'unused',
    created_by: U_ADMIN,
    created_at: 1700000000,
    // Default: a comfortably-in-the-future expiry so existing tests are unaffected.
    expires_at: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
    claimed_by_device_id: null,
    claimed_at: null,
    ...overrides,
  };
  await db.prepare(`INSERT INTO registration_codes
    (id, code, workspace_id, planned_device_name, status, created_by, created_at, expires_at, claimed_by_device_id, claimed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(row.id, row.code, row.workspace_id, row.planned_device_name, row.status,
    row.created_by, row.created_at, row.expires_at, row.claimed_by_device_id, row.claimed_at);
  codeIds.push(row.id);
  return row;
}
const deviceCount = async () => Number((await db.prepare('SELECT COUNT(*) AS n FROM devices').get()).n);

// --- App: mount claimRouter exactly as server.js does (public, no auth) ----
const app = express();
app.use(express.json());
app.use('/api/provisioning/registration-codes/claim', registrationCodes.claimRouter);
app.use('/api/provisioning', (req, res, next) => { req.user = { id: U_ADMIN, role: 'user' }; next(); }, registrationCodes); // Stage 1 list, for the cross-check test
app.use((err, req, res, _next) => { res.status(500).json({ error: err.message }); });

let server, base;
test.before(async () => {
  await initDb();
  // --- Seed ----------------------------------------------------------------
  await db.prepare("INSERT INTO users (id, email, role) VALUES (?, ?, 'user'), (?, ?, 'user')")
    .run(U_ADMIN, `${U_ADMIN.toLowerCase()}@a.test`, U_ADMIN_B, `${U_ADMIN_B.toLowerCase()}@b.test`);
  await db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?), (?, ?, ?)')
    .run(id('org-a'), 'Org A', U_ADMIN, id('org-b'), 'Org B', U_ADMIN_B);
  await db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?), (?, ?, ?)')
    .run(WS_A, id('org-a'), 'Workspace A', WS_B, id('org-b'), 'Workspace B');
  await db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin'), (?, ?, 'workspace_admin')")
    .run(WS_A, U_ADMIN, WS_B, U_ADMIN_B);
  server = app.listen(0);
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  base = `http://127.0.0.1:${server.address().port}`;
});

// Only this file's rows: its fingerprints, its orgs via the real cascade (workspaces,
// claimed devices, codes, memberships), any orphan code, then its users.
test.after(async () => {
  try {
    if (server) await new Promise((r) => server.close(r));
    await db.prepare('DELETE FROM device_fingerprints WHERE fingerprint LIKE ?').run(`${P}-%`);
    for (const o of [id('org-a'), id('org-b')]) await deleteOrgCascade(db, { orgId: o });
    if (codeIds.length) await db.prepare(`DELETE FROM registration_codes WHERE id IN (${codeIds.map(() => '?').join(',')})`).run(...codeIds);
    await db.prepare('DELETE FROM users WHERE id LIKE ?').run(`${P}-%`);
  } finally {
    await db.close();
  }
});

const claim = (body) => fetch(`${base}/api/provisioning/registration-codes/claim`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

test('claim: happy path with a planned_device_name assigns workspace + that name', async () => {
  const rc = await seedCode({ planned_device_name: 'Lobby screen — 2nd floor' });
  const res = await claim({
    code: rc.code,
    device_info: {
      android_version: '13', app_version: '2.1.0', screen_width: 1920, screen_height: 1080,
      // Ref 31: one-time hardware identity. The device sends honest markers, never blanks.
      hardware: {
        manufacturer: 'Rockchip', model: 'RK3588 TV Box', display_size_inches: null,
        mac_address: 'unavailable (requires Device Owner)',
        serial_number: 'unavailable (requires Device Owner)',
        sim_iccid: 'no SIM hardware', sim_provider: 'no SIM hardware', sim_network_status: 'NO_TELEPHONY',
      },
    },
    fingerprint: FP('fp-lobby'),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.match(body.device_token, /^[0-9a-f]{64}$/, 'a 32-byte hex device token is issued');
  assert.equal(body.name, 'Lobby screen — 2nd floor');
  assert.equal(body.workspace_id, WS_A);
  assert.equal(body.status, 'online');

  const dev = await db.prepare('SELECT * FROM devices WHERE id = ?').get(body.device_id);
  assert.ok(dev, 'device row created');
  assert.equal(dev.workspace_id, WS_A);
  assert.equal(dev.user_id, U_ADMIN, 'device.user_id = the code creator (so device:paired re-sends on reconnect)');
  assert.equal(dev.name, 'Lobby screen — 2nd floor');
  assert.equal(dev.status, 'online');
  assert.equal(dev.pairing_code, null);
  // Ref 2: the token is stored hashed at rest; the raw token only ever leaves in this response.
  assert.equal(dev.device_token, hashDeviceToken(body.device_token), 'stored value is the hash of the issued token');
  assert.notEqual(dev.device_token, body.device_token, 'raw token is not stored');
  assert.equal(dev.android_version, '13');
  assert.equal(dev.app_version, '2.1.0');
  assert.equal(dev.screen_width, 1920);
  // Ref 31: hardware identity persisted from the claim payload (markers stored verbatim).
  assert.equal(dev.manufacturer, 'Rockchip');
  assert.equal(dev.model, 'RK3588 TV Box');
  assert.equal(dev.display_size_inches, null, 'a null (impossible) display size stays null, not 0');
  assert.equal(dev.mac_address, 'unavailable (requires Device Owner)');
  assert.equal(dev.sim_network_status, 'NO_TELEPHONY');
  assert.ok(dev.hardware_captured_at > 0, 'hardware_captured_at stamped');

  const after = await db.prepare('SELECT * FROM registration_codes WHERE id = ?').get(rc.id);
  assert.equal(after.status, 'claimed');
  assert.equal(after.claimed_by_device_id, body.device_id);
  assert.ok(after.claimed_at > 0, 'claimed_at stamped');

  const fp = await db.prepare('SELECT * FROM device_fingerprints WHERE fingerprint = ?').get(FP('fp-lobby'));
  assert.equal(fp.device_id, body.device_id);
  assert.equal(fp.user_id, U_ADMIN);
});

test('claim: no planned_device_name -> device still assigned, gets a default name', async () => {
  const rc = await seedCode({ planned_device_name: null });
  const res = await claim({ code: rc.code });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.workspace_id, WS_A);
  assert.match(body.name, /^Display \d+$/, 'default "Display N" name, settable later like normal');
  const dev = await db.prepare('SELECT workspace_id, name FROM devices WHERE id = ?').get(body.device_id);
  assert.equal(dev.workspace_id, WS_A);
  assert.equal(dev.name, body.name);
});

test('claim: unknown code -> 404 with a clear message, no device created', async () => {
  const before = await deviceCount();
  const res = await claim({ code: await freshCode() });
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /not recognised|typo/i);
  assert.equal(await deviceCount(), before, 'no device row');
});

test('claim: already-claimed code -> 409 with a clear message', async () => {
  const rc = await seedCode();
  const first = await claim({ code: rc.code });
  assert.equal(first.status, 201);
  const firstDeviceId = (await first.json()).device_id;

  const before = await deviceCount();
  const second = await claim({ code: rc.code });
  assert.equal(second.status, 409);
  assert.match((await second.json()).error, /already been used/i);
  assert.equal(await deviceCount(), before, 'no second device row');

  // The code still points at the first device only.
  const after = await db.prepare('SELECT * FROM registration_codes WHERE id = ?').get(rc.id);
  assert.equal(after.claimed_by_device_id, firstDeviceId);
});

test('claim: malformed code -> 400', async () => {
  for (const bad of ['12345', '1234567', 'abcdef', '', undefined]) {
    const res = await claim({ code: bad });
    assert.equal(res.status, 400, `"${bad}" rejected`);
  }
});

test('claim: expired code -> 410 (distinct from the 404 for unknown), no device created', async () => {
  const rc = await seedCode({ expires_at: Math.floor(Date.now() / 1000) - 60 });
  const before = await deviceCount();
  const res = await claim({ code: rc.code, fingerprint: FP('fp-expired') });
  assert.equal(res.status, 410, 'expired -> 410, not the 404 an unknown code gets');
  assert.match((await res.json()).error, /expired/i);

  assert.equal(await deviceCount(), before, 'no device row');
  const rowAfter = await db.prepare('SELECT status FROM registration_codes WHERE id = ?').get(rc.id);
  assert.equal(rowAfter.status, 'unused', 'code left untouched (still unused, just unclaimable)');
  assert.equal(Number((await db.prepare('SELECT COUNT(*) AS n FROM device_fingerprints WHERE fingerprint = ?').get(FP('fp-expired'))).n), 0);
});

test('claim: a code expiring exactly now is unclaimable (boundary)', async () => {
  const rc = await seedCode({ expires_at: Math.floor(Date.now() / 1000) });
  const res = await claim({ code: rc.code });
  assert.equal(res.status, 410);
});

test('claim: a code with null expires_at (pre-TTL row) still claims', async () => {
  const rc = await seedCode({ expires_at: null });
  const res = await claim({ code: rc.code });
  assert.equal(res.status, 201);
});

test('claim: a code can be claimed exactly once across repeated attempts', async () => {
  const rc = await seedCode();
  const results = [];
  for (let i = 0; i < 5; i++) results.push(await claim({ code: rc.code }));
  const ok = results.filter((r) => r.status === 201);
  const conflict = results.filter((r) => r.status === 409);
  assert.equal(ok.length, 1, 'exactly one claim succeeds');
  assert.equal(conflict.length, 4, 'the rest get 409');
  assert.equal(
    Number((await db.prepare('SELECT COUNT(*) AS n FROM devices WHERE id = ?').get((await ok[0].json()).device_id)).n),
    1,
  );
});

test('claim: fingerprint is re-linked to the newest device on a later claim', async () => {
  const rc1 = await seedCode();
  const rc2 = await seedCode();
  const d1 = await (await claim({ code: rc1.code, fingerprint: FP('fp-shared') })).json();
  const d2 = await (await claim({ code: rc2.code, fingerprint: FP('fp-shared') })).json();
  assert.notEqual(d1.device_id, d2.device_id);
  const rows = await db.prepare('SELECT * FROM device_fingerprints WHERE fingerprint = ?').all(FP('fp-shared'));
  assert.equal(rows.length, 1, 'one fingerprint row, not a duplicate');
  assert.equal(rows[0].device_id, d2.device_id, 're-pointed at the most recent device');
});

test('claim: workspace scoping - a ws-b code lands the device in ws-b', async () => {
  const rc = await seedCode({ workspace_id: WS_B, created_by: U_ADMIN_B, planned_device_name: 'B lobby' });
  const body = await (await claim({ code: rc.code })).json();
  assert.equal(body.workspace_id, WS_B);
  const dev = await db.prepare('SELECT workspace_id, user_id FROM devices WHERE id = ?').get(body.device_id);
  assert.equal(dev.workspace_id, WS_B);
  assert.equal(dev.user_id, U_ADMIN_B);
});

test('claim: code for a since-deleted workspace -> 409, no orphan device', async () => {
  // registration_codes.workspace_id cascades on delete, so a deleted workspace normally
  // takes its codes with it; this guards the route's defensive branch for an orphan code
  // (e.g. a legacy row). Seed one with FK checks off for this single pinned session only.
  const code = await freshCode(), rcId = id('rc-orphan');
  await db.transaction(async (tx) => {
    await tx.exec('SET SESSION foreign_key_checks = 0');
    try {
      await tx.prepare(`INSERT INTO registration_codes (id, code, workspace_id, status, created_by, created_at, expires_at)
        VALUES (?, ?, ?, 'unused', ?, 1700000000, ?)`).run(rcId, code, id('ws-gone'), U_ADMIN, Math.floor(Date.now() / 1000) + 86400);
    } finally {
      await tx.exec('SET SESSION foreign_key_checks = 1');
    }
  })();
  codeIds.push(rcId);
  const before = await deviceCount();
  const res = await claim({ code });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /workspace/i);
  assert.equal(await deviceCount(), before);
});

test('cross-check: after a claim, the Stage 1 list shows the code claimed + device name', async () => {
  const rc = await seedCode({ planned_device_name: 'Reception TV' });
  const body = await (await claim({ code: rc.code })).json();
  const list = await fetch(`${base}/api/provisioning/registration-codes?workspace_id=${WS_A}`).then((r) => r.json());
  const row = list.find((c) => c.code === rc.code);
  assert.equal(row.status, 'claimed');
  assert.equal(row.claimed_by_device_id, body.device_id);
  assert.equal(row.claimed_by_device_name, 'Reception TV');
  // device_token must never appear in the admin listing.
  assert.ok(!('device_token' in row));
});
