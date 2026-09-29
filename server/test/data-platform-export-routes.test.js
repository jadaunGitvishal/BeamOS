'use strict';

// Ref 28 Stage 3 (Extensibility & integrations - separate from the Android
// offline-resilience Ref 28): the admin visibility routes on routes/workspaces.js
//   GET  /api/workspaces/:id/data-platform-export/status
//   POST /api/workspaces/:id/data-platform-export/run-now
//
// workspaces.js's sibling tests (tickets / campaigns / regions) run the router
// against an in-memory sqlite mock, but these routes drive the real export
// sweep, whose watermark UPSERT (ON DUPLICATE KEY UPDATE) is MySQL-only - so
// this uses the in-process real-MySQL pattern instead (test/helpers/inprocess-app.js,
// as sim-inventory.test.js does), with the fake S3 client injected through the
// service's __setS3Client seam. Covers:
//   - RBAC: org_owner / workspace_admin allowed; workspace_editor, workspace_viewer
//     and a non-member all 403 on BOTH routes (admin-only, like invites/members)
//   - status: per-domain watermarks, enabled flag, last_error
//   - run-now: writes only THIS workspace's objects, advances its watermarks,
//     surfaces an S3 failure as 502 + last_error, 409 when the feature is off
//   - not on the token door: an st_ API token can't reach either route

// Must precede every require: config.js reads these once at load.
process.env.DATA_PLATFORM_EXPORT_ENABLED = 'true';
process.env.DATA_PLATFORM_S3_BUCKET = 'test-lake';
process.env.DATA_PLATFORM_S3_PREFIX = 'beamos/';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { startInProcessApp } = require('./helpers/inprocess-app');
const { randTag, cleanupUsers } = require('./helpers/disposable');
const config = require('../config');
const svc = require('../services/data-platform-export');

let base, db, stop;
const tag = randTag();
const S = {};
const created = { userIds: [] };

function fakeS3(failWhen = () => false) {
  const puts = [];
  return {
    puts,
    async putObject(p) {
      if (failWhen(p)) throw new Error('simulated S3 SignatureDoesNotMatch');
      puts.push(p);
    },
  };
}

before(async () => {
  ({ base, db, stop } = await startInProcessApp({ only: ['/api/auth', '/api/workspaces', '/api/tokens'] }));

  const mk = async (k) => (await jf('/api/auth/register', reg({ email: `dpe-${k}-${tag}@x.local`, password: 'Passw0rd123' }))).body;
  const a = await mk('a'); // org_owner of wsA
  const b = await mk('b'); // workspace_admin of wsA
  const c = await mk('c'); // workspace_editor of wsA
  const d = await mk('d'); // workspace_viewer of wsA
  const e = await mk('e'); // no membership in wsA at all
  Object.assign(S, {
    jwtA: a.token, userA: a.user.id, wsA: a.current_workspace_id,
    jwtB: b.token, userB: b.user.id,
    jwtC: c.token, userC: c.user.id,
    jwtD: d.token, userD: d.user.id,
    jwtE: e.token, userE: e.user.id, wsE: e.current_workspace_id,
  });
  assert.ok(S.jwtA && S.wsA && S.jwtE && S.wsE, 'users registered with auto-created workspaces');
  // Dependents before the org owner (deleteUserCascade ordering - see sim-inventory.test.js).
  created.userIds.push(S.userE, S.userD, S.userC, S.userB, S.userA);

  const member = (u, role) =>
    db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)').run(S.wsA, u, role);
  await member(S.userB, 'workspace_admin');
  await member(S.userC, 'workspace_editor');
  await member(S.userD, 'workspace_viewer');

  S.deviceA = 'dpe-dev-a-' + tag;
  await db.prepare("INSERT INTO devices (id, name, status, workspace_id) VALUES (?, 'DPE Route Display A', 'online', ?)").run(S.deviceA, S.wsA);
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare('INSERT INTO play_logs (device_id, content_name, started_at, ended_at, duration_sec, completed) VALUES (?, ?, ?, ?, 30, 1)')
    .run(S.deviceA, 'Route Promo', now - 600, now - 570);
});

after(async () => {
  svc.__setS3Client(null);
  if (S.wsA) await db.prepare('DELETE FROM app_settings WHERE `key` LIKE ?').run(`data_platform_export_%:${S.wsA}%`).catch(() => {});
  if (S.wsE) await db.prepare('DELETE FROM app_settings WHERE `key` LIKE ?').run(`data_platform_export_%:${S.wsE}%`).catch(() => {});
  if (S.deviceA) {
    await db.prepare('DELETE FROM play_logs WHERE device_id = ?').run(S.deviceA).catch(() => {});
    await db.prepare('DELETE FROM devices WHERE id = ?').run(S.deviceA).catch(() => {});
  }
  await cleanupUsers(db, created.userIds);
  await stop();
});

async function jf(p, opts = {}) {
  const r = await fetch(base + p, opts);
  let b = null;
  try { b = await r.json(); } catch { /* non-JSON */ }
  return { status: r.status, body: b };
}
const reg = (o) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });
const authed = (tok, method, obj) => ({
  method,
  headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
  body: obj === undefined ? undefined : JSON.stringify(obj),
});
const statusUrl = () => `/api/workspaces/${S.wsA}/data-platform-export/status`;
const runUrl = () => `/api/workspaces/${S.wsA}/data-platform-export/run-now`;

// -------------------------------------------------------------------

test('RBAC: editor, viewer and non-member are denied both routes (403); unknown workspace 404', async () => {
  for (const tok of [S.jwtC, S.jwtD, S.jwtE]) {
    assert.equal((await jf(statusUrl(), authed(tok, 'GET'))).status, 403);
    assert.equal((await jf(runUrl(), authed(tok, 'POST'))).status, 403);
  }
  assert.equal((await jf('/api/workspaces/no-such-ws-' + tag + '/data-platform-export/status', authed(S.jwtA, 'GET'))).status, 404);
});

test('status: admin sees enabled flag + every domain, nothing exported yet', async () => {
  for (const tok of [S.jwtA, S.jwtB]) {
    const r = await jf(statusUrl(), authed(tok, 'GET'));
    assert.equal(r.status, 200);
    assert.equal(r.body.enabled, true);
    assert.deepEqual(r.body.domains.map((d) => d.domain), ['device', 'uptime', 'sla', 'proof_of_play', 'tickets', 'sim_inventory']);
    assert.ok(r.body.domains.every((d) => d.exported_through === null));
    assert.equal(r.body.last_error, null);
    assert.equal(r.body.location, `s3://test-lake/beamos/<domain>/workspace_id=${S.wsA}/`);
  }
});

test('run-now: exports ONLY this workspace, advances its watermarks, returns written objects', async () => {
  const s3 = fakeS3();
  svc.__setS3Client(s3);
  const r = await jf(runUrl(), authed(S.jwtB, 'POST'));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.workspace_id, S.wsA);
  assert.equal(r.body.error, null);

  assert.ok(s3.puts.length >= 2, 'device snapshot + proof_of_play written');
  assert.ok(s3.puts.every((p) => p.Bucket === 'test-lake' && p.Key.includes(`/workspace_id=${S.wsA}/`)), 'no other workspace swept');
  const pop = s3.puts.find((p) => p.Key.startsWith('beamos/proof_of_play/'));
  const rows = zlib.gunzipSync(pop.Body).toString('utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((x) => x.pop_content_name), ['Route Promo']);
  assert.deepEqual(r.body.written.map((w) => w.key).sort(), s3.puts.map((p) => p.Key).sort());

  assert.ok(r.body.status.domains.every((d) => typeof d.exported_through === 'number'), 'every watermark advanced');
  const st = await jf(statusUrl(), authed(S.jwtA, 'GET'));
  assert.deepEqual(st.body.domains, r.body.status.domains);

  // activity trail for the manual trigger
  const act = await db
    .prepare("SELECT COUNT(*) AS n FROM activity_log WHERE user_id = ? AND action = 'data_platform_export_run'")
    .get(S.userB);
  assert.equal(Number(act.n), 1);
});

test('run-now: S3 failure -> 502 with the error, recorded as last_error in status; watermark held back', async () => {
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare('INSERT INTO play_logs (device_id, content_name, started_at, ended_at, duration_sec, completed) VALUES (?, ?, ?, ?, 30, 1)')
    .run(S.deviceA, 'Route Promo 2', now, now + 30);
  const before = (await jf(statusUrl(), authed(S.jwtA, 'GET'))).body.domains.find((d) => d.domain === 'proof_of_play').exported_through;

  // run-now within the same second as the previous run has an empty window; wait it out
  await new Promise((r) => setTimeout(r, 1100));
  svc.__setS3Client(fakeS3(() => true));
  const r = await jf(runUrl(), authed(S.jwtA, 'POST'));
  assert.equal(r.status, 502);
  assert.match(r.body.error, /simulated S3/);

  const st = (await jf(statusUrl(), authed(S.jwtA, 'GET'))).body;
  assert.match(st.last_error.message, /simulated S3/);
  assert.equal(st.domains.find((d) => d.domain === 'proof_of_play').exported_through, before, 'failed domain not advanced');

  // healthy retry clears the error
  svc.__setS3Client(fakeS3());
  const ok = await jf(runUrl(), authed(S.jwtA, 'POST'));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status.last_error, null);
});

test('run-now: 409 when the feature is disabled on this instance', async () => {
  config.dataPlatformExport.enabled = false;
  try {
    const r = await jf(runUrl(), authed(S.jwtA, 'POST'));
    assert.equal(r.status, 409);
    assert.match(r.body.error, /DATA_PLATFORM_EXPORT_ENABLED/);
    const st = await jf(statusUrl(), authed(S.jwtA, 'GET'));
    assert.equal(st.status, 200, 'status stays readable while disabled');
    assert.equal(st.body.enabled, false);
  } finally {
    config.dataPlatformExport.enabled = true;
  }
});

test('not on the token door: an st_ API token (even full scope) cannot reach these routes', async () => {
  const mint = await jf('/api/tokens', authed(S.jwtA, 'POST', { name: 'dpe-test ' + tag, scope: 'full' }));
  assert.equal(mint.status, 201, JSON.stringify(mint.body));
  assert.match(mint.body.token, /^st_/);
  assert.equal((await jf(statusUrl(), authed(mint.body.token, 'GET'))).status, 401);
  assert.equal((await jf(runUrl(), authed(mint.body.token, 'POST'))).status, 401);
});
