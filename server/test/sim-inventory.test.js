'use strict';

// Ref 65 — SIM inventory data model + CRUD routes (4400b95, d52ebf1, a2dfea1).
//
// routes/sim-inventory.js is a tenancy:true router — it reads req.workspaceId
// off resolveTenancy, unlike tickets.js's URL-param-target shape — so this
// can't reuse tickets.test.js's in-memory-sqlite + bare requireAuth mount
// (sim_inventory's UNIQUE(iccid) and assigned_device_id FK also need to be
// asserted against real MySQL, not simulated). Instead this runs in-process
// against the REAL database (test/helpers/inprocess-app.js), the same
// real-MySQL/disposable-fixture pattern block-authz.test.js / billing-authz.test.js
// use — while keeping tickets.test.js's per-test granularity and naming voice.
// Covers:
//   - full lifecycle: create (in_stock) -> assign -> active -> retired,
//     persisted at each step (asserted both via the API response and a
//     direct DB read)
//   - duplicate ICCID (409), missing iccid (400)
//   - assign without assigned_device_id (400), assign to a cross-tenant
//     device (400)
//   - RBAC: workspace_viewer reads but cannot write (403); workspace_editor
//     ALSO cannot write - the route gates at workspace_admin+, one tier
//     above the editor+ bar tickets/campaigns use (a deliberate Stage 2
//     design choice, so this doubles as its regression guard)
//
// Every fixture (3 real registered users, 2 real devices) is disposable and
// removed in after() (test/helpers/disposable.js).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startInProcessApp } = require('./helpers/inprocess-app');
const { randTag, cleanupUsers } = require('./helpers/disposable');

let base, db, stop;
const tag = randTag();
const S = {};
const created = { userIds: [] };

before(async () => {
  ({ base, db, stop } = await startInProcessApp({ only: ['/api/auth', '/api/sim-inventory'] }));

  const emailA = `siminv-a-${tag}@x.local`;
  const emailB = `siminv-b-${tag}@x.local`;
  const emailC = `siminv-c-${tag}@x.local`;
  const a = (await jf('/api/auth/register', reg({ email: emailA, password: 'Passw0rd123' }))).body;
  const b = (await jf('/api/auth/register', reg({ email: emailB, password: 'Passw0rd123' }))).body;
  const c = (await jf('/api/auth/register', reg({ email: emailC, password: 'Passw0rd123' }))).body;
  S.jwtA = a.token; S.userA = a.user.id; S.wsA = a.current_workspace_id; // org_owner -> admin-tier
  S.jwtB = b.token; S.userB = b.user.id; S.wsB = b.current_workspace_id; // own workspace, for the cross-tenant device
  S.jwtC = c.token; S.userC = c.user.id;
  assert.ok(S.jwtA && S.jwtB && S.jwtC && S.wsA && S.wsB, 'all three users registered with an auto-created workspace');
  // Dependents first: deleteUserCascade refuses to delete an org owner (A)
  // while another user still has a workspace_members row in A's org/workspace
  // (same ordering block-authz.test.js documents) - B and C both get one below.
  created.userIds.push(S.userC, S.userB, S.userA);

  // B: workspace_viewer of A's workspace (read allowed, write denied).
  await db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_viewer')").run(S.wsA, S.userB);
  // C: workspace_editor of A's workspace - proves the admin+ gate excludes
  // editor too, unlike tickets/campaigns.
  await db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_editor')").run(S.wsA, S.userC);

  // A real throwaway device in A's workspace - the assign/lifecycle target.
  S.deviceA = 'siminv-dev-a-' + tag;
  await db.prepare("INSERT INTO devices (id, name, status, workspace_id) VALUES (?, 'SIM Inv Test Display A', 'offline', ?)").run(S.deviceA, S.wsA);
  // A real device in B's OWN workspace - the cross-tenant assignment target.
  S.deviceB = 'siminv-dev-b-' + tag;
  await db.prepare("INSERT INTO devices (id, name, status, workspace_id) VALUES (?, 'SIM Inv Test Display B', 'offline', ?)").run(S.deviceB, S.wsB);
});

after(async () => {
  // sim_inventory.workspace_id is ON DELETE CASCADE from workspaces, so the
  // user cleanup below removes these too - delete explicitly first anyway so
  // cleanup doesn't silently rely on that cascade going unverified.
  if (S.wsA) await db.prepare('DELETE FROM sim_inventory WHERE workspace_id = ?').run(S.wsA).catch(() => {});
  if (S.wsB) await db.prepare('DELETE FROM sim_inventory WHERE workspace_id = ?').run(S.wsB).catch(() => {});
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
// resolveTenancy's ?workspace_id= override (validated against real access) -
// needed for B/C, whose own JWT current_workspace_id points at their own
// auto-created workspace, not A's.
const withWs = (path, wsId) => (wsId ? `${path}${path.includes('?') ? '&' : '?'}workspace_id=${encodeURIComponent(wsId)}` : path);
const mkIccid = (suffix) => `89${tag}${suffix}`;

// -------------------------------------------------------------------

test('create validation: missing iccid 400; duplicate iccid 409', async () => {
  assert.equal((await jf('/api/sim-inventory', authed(S.jwtA, 'POST', {}))).status, 400);

  const iccid = mkIccid('dup');
  const r1 = await jf('/api/sim-inventory', authed(S.jwtA, 'POST', { iccid, carrier: 'Jio' }));
  assert.equal(r1.status, 201);
  assert.equal(r1.body.status, 'in_stock');
  assert.equal(r1.body.workspace_id, S.wsA);
  assert.equal(r1.body.assigned_device_id, null);

  const dupe = await jf('/api/sim-inventory', authed(S.jwtA, 'POST', { iccid, carrier: 'Airtel' }));
  assert.equal(dupe.status, 409);
});

test('full lifecycle: create (in_stock) -> assign -> active -> retired, persisted at each step', async () => {
  const iccid = mkIccid('lifecycle');
  const createResp = await jf('/api/sim-inventory', authed(S.jwtA, 'POST', { iccid, carrier: 'Airtel', serial_number: 'SN-1' }));
  assert.equal(createResp.status, 201);
  const sim = createResp.body;
  assert.equal(sim.status, 'in_stock');
  assert.equal(sim.assigned_device_id, null);

  let row = await db.prepare('SELECT status, assigned_device_id FROM sim_inventory WHERE id = ?').get(sim.id);
  assert.equal(row.status, 'in_stock');
  assert.equal(row.assigned_device_id, null);

  const assigned = await jf(`/api/sim-inventory/${sim.id}`, authed(S.jwtA, 'PATCH', { status: 'assigned', assigned_device_id: S.deviceA }));
  assert.equal(assigned.status, 200);
  assert.equal(assigned.body.status, 'assigned');
  assert.equal(assigned.body.assigned_device_id, S.deviceA);
  assert.equal(assigned.body.assigned_device_name, 'SIM Inv Test Display A');
  row = await db.prepare('SELECT status, assigned_device_id FROM sim_inventory WHERE id = ?').get(sim.id);
  assert.equal(row.status, 'assigned');
  assert.equal(row.assigned_device_id, S.deviceA);

  const active = await jf(`/api/sim-inventory/${sim.id}`, authed(S.jwtA, 'PATCH', { status: 'active' }));
  assert.equal(active.status, 200);
  assert.equal(active.body.status, 'active');
  assert.equal(active.body.assigned_device_id, S.deviceA, 'device retained moving assigned -> active');
  row = await db.prepare('SELECT status, assigned_device_id FROM sim_inventory WHERE id = ?').get(sim.id);
  assert.equal(row.status, 'active');
  assert.equal(row.assigned_device_id, S.deviceA);

  const retired = await jf(`/api/sim-inventory/${sim.id}`, authed(S.jwtA, 'PATCH', { status: 'retired' }));
  assert.equal(retired.status, 200);
  assert.equal(retired.body.status, 'retired');
  assert.equal(retired.body.assigned_device_id, null, 'device cleared on retire');
  row = await db.prepare('SELECT status, assigned_device_id FROM sim_inventory WHERE id = ?').get(sim.id);
  assert.equal(row.status, 'retired');
  assert.equal(row.assigned_device_id, null);
});

test('PATCH validation: assigning without assigned_device_id -> 400, status unchanged', async () => {
  const iccid = mkIccid('noassign');
  const sim = (await jf('/api/sim-inventory', authed(S.jwtA, 'POST', { iccid }))).body;
  const r = await jf(`/api/sim-inventory/${sim.id}`, authed(S.jwtA, 'PATCH', { status: 'assigned' }));
  assert.equal(r.status, 400);
  const row = await db.prepare('SELECT status FROM sim_inventory WHERE id = ?').get(sim.id);
  assert.equal(row.status, 'in_stock');
});

test('PATCH validation: assigning to a device in a DIFFERENT workspace -> 400, unchanged', async () => {
  const iccid = mkIccid('crosstenant');
  const sim = (await jf('/api/sim-inventory', authed(S.jwtA, 'POST', { iccid }))).body;
  const r = await jf(`/api/sim-inventory/${sim.id}`, authed(S.jwtA, 'PATCH', { status: 'assigned', assigned_device_id: S.deviceB }));
  assert.equal(r.status, 400);
  const row = await db.prepare('SELECT status, assigned_device_id FROM sim_inventory WHERE id = ?').get(sim.id);
  assert.equal(row.status, 'in_stock');
  assert.equal(row.assigned_device_id, null);
});

test('RBAC: workspace_viewer reads but cannot write (403); workspace_editor is ALSO denied writes (admin+ gate)', async () => {
  const listAsViewer = await jf(withWs('/api/sim-inventory', S.wsA), authed(S.jwtB, 'GET'));
  assert.equal(listAsViewer.status, 200);
  assert.ok(Array.isArray(listAsViewer.body));

  const viewerCreate = await jf(withWs('/api/sim-inventory', S.wsA), authed(S.jwtB, 'POST', { iccid: mkIccid('viewer-blocked') }));
  assert.equal(viewerCreate.status, 403);

  const listAsEditor = await jf(withWs('/api/sim-inventory', S.wsA), authed(S.jwtC, 'GET'));
  assert.equal(listAsEditor.status, 200);

  // The gate is workspace_admin+, one tier above how tickets/campaigns gate
  // their own writes (workspace_editor+) - an editor here is still 403.
  const editorCreate = await jf(withWs('/api/sim-inventory', S.wsA), authed(S.jwtC, 'POST', { iccid: mkIccid('editor-blocked') }));
  assert.equal(editorCreate.status, 403);

  const sim = (await jf('/api/sim-inventory', authed(S.jwtA, 'POST', { iccid: mkIccid('editor-patch-blocked') }))).body;
  const editorPatch = await jf(withWs(`/api/sim-inventory/${sim.id}`, S.wsA), authed(S.jwtC, 'PATCH', { carrier: 'Vi' }));
  assert.equal(editorPatch.status, 403);
  const row = await db.prepare('SELECT carrier FROM sim_inventory WHERE id = ?').get(sim.id);
  assert.notEqual(row.carrier, 'Vi', 'editor PATCH must not have applied');
});
