'use strict';

// Refs 49/67: what a regional_viewer can and cannot reach, end to end over real
// HTTP + a real socket.io dashboard namespace, against the REAL MySQL database
// (helpers/inprocess-app.js mounts every router server.js mounts). Disposable,
// randomly tagged fixtures, deleted in after().
//
// Org A tree (levels region > cluster > area > territory):
//   R ─ C ─ A1 ─ T1          workspaces: wsR, wsC, wsA1, wsT1
//       ├ T2 (skips area)                 wsT2
//       └ A2                              wsA2
//   R2 (sibling region)                   wsR2
//   (no region)                           wsNone, plus the owner's own Default
// Org B: RB -> wsB; and wsBad - an org-B workspace whose region_id (inconsistently,
// written straight to the DB) names org A's A1, to prove the org match holds.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { Server } = require('socket.io');
const ioClient = require('socket.io-client');

const config = require('../config');
const { db, initDb } = require('../db/database');
const { accessibleWorkspaceIds, accessContext } = require('../lib/tenancy');
const { canAccessWorkspace } = require('../lib/permissions');
const { deleteUserCascade, deleteOrgCascade } = require('../lib/user-deletion');
const { generateToken: generateApiToken, hashToken, displayPrefix } = require('../middleware/apiToken');
const { startInProcessApp } = require('./helpers/inprocess-app');
const { randTag, cleanupUsers } = require('./helpers/disposable');

const TAG = randTag();
const PASSWORD = 'ref49-access-pass-1';
let app;
const cleanup = [];
const scratchOrgs = [];
let ownerA, ownerB, tech;
const RV = {}; // regional viewers by key
const R = {}; // region ids
const W = {}; // workspace ids
const D = {}; // one device id per workspace key

async function j(method, path, { token, body, ws } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (ws) headers['X-Workspace-Id'] = ws;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${app.base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed, headers: res.headers };
}

async function registerUser(prefix, createOrg = false) {
  const email = `${prefix}-${randTag()}@ref49acc.local`;
  const r = await j('POST', '/api/auth/register', { body: { email, password: PASSWORD, name: prefix, createOrg } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  cleanup.push(r.body.user.id);
  const ws = r.body.current_workspace_id
    ? await app.db.prepare('SELECT organization_id FROM workspaces WHERE id = ?').get(r.body.current_workspace_id)
    : null;
  return { id: r.body.user.id, email, token: r.body.token, workspaceId: r.body.current_workspace_id, orgId: ws?.organization_id };
}

async function login(user) {
  const r = await j('POST', '/api/auth/login', { body: { email: user.email, password: PASSWORD } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  user.token = r.body.token;
  return r.body;
}

const addOrgMember = (orgId, userId, role) =>
  app.db.prepare('INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, ?)').run(orgId, userId, role);
const setScopes = async (user, regionKeys, org = ownerA) => {
  const r = await j('PUT', `/api/organizations/${org.orgId}/members/${user.id}/region-scopes`, { token: org.token, body: { region_ids: regionKeys.map((k) => R[k]) } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
};
const wsRow = (key) => app.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(W[key]);

const ALL_KEYS = ['R', 'C', 'A1', 'T1', 'T2', 'A2', 'R2', 'None', 'Default', 'B', 'Bad'];
const EXPECT = {
  T: ['T1'],
  A: ['A1', 'T1'],
  R: ['R', 'C', 'A1', 'T1', 'T2', 'A2'],
  M: ['A2', 'R2'],
};
const ids = (keys) => keys.map((k) => W[k]).sort();

test.before(async () => {
  await initDb();
  app = await startInProcessApp();
  ownerA = await registerUser('ref49aown', true);
  ownerB = await registerUser('ref49bown', true);
  W.Default = ownerA.workspaceId;
  const mk = async (key, level, parent, org = ownerA) => {
    const r = await j('POST', `/api/organizations/${org.orgId}/regions`, { token: org.token, body: { name: `${key}-${TAG}`, level, parent_id: parent ? R[parent] : null } });
    assert.equal(r.status, 201, `${key}: ${JSON.stringify(r.body)}`);
    R[key] = r.body.id;
  };
  await mk('R', 'region'); await mk('C', 'cluster', 'R'); await mk('A1', 'area', 'C'); await mk('T1', 'territory', 'A1');
  await mk('T2', 'territory', 'C'); await mk('A2', 'area', 'C'); await mk('R2', 'region'); await mk('RB', 'region', null, ownerB);
  const ws = async (key, orgId, regionKey) => {
    W[key] = crypto.randomUUID();
    await app.db.prepare('INSERT INTO workspaces (id, organization_id, name, region_id) VALUES (?, ?, ?, ?)')
      .run(W[key], orgId, `ref49-ws-${key}-${TAG}`, regionKey ? R[regionKey] : null);
  };
  for (const k of ['R', 'C', 'A1', 'T1', 'T2', 'A2', 'R2']) await ws(k, ownerA.orgId, k);
  await ws('None', ownerA.orgId, null);
  await ws('B', ownerB.orgId, 'RB');
  await ws('Bad', ownerB.orgId, null);
  await app.db.prepare('UPDATE workspaces SET region_id = ? WHERE id = ?').run(R.A1, W.Bad); // cross-org, on purpose
  for (const k of ALL_KEYS) {
    D[k] = crypto.randomUUID();
    await app.db.prepare("INSERT INTO devices (id, user_id, workspace_id, name, status, created_at) VALUES (?, ?, ?, ?, 'offline', UNIX_TIMESTAMP())")
      .run(D[k], ownerA.id, W[k], `ref49-dev-${k}-${TAG}`);
  }
  for (const k of Object.keys(EXPECT)) {
    RV[k] = await registerUser(`ref49rv${k.toLowerCase()}`);
    await addOrgMember(ownerA.orgId, RV[k].id, 'regional_viewer');
  }
  await setScopes(RV.T, ['T1']);
  await setScopes(RV.A, ['A1']);
  await setScopes(RV.R, ['R']);
  await setScopes(RV.M, ['A2', 'R2']);
  tech = await registerUser('ref49tech');
  await addOrgMember(ownerA.orgId, tech.id, 'field_technician');
  for (const u of Object.values(RV)) await login(u);
});

test.after(async () => {
  try {
    if (app) {
      for (const orgId of scratchOrgs) { try { await deleteOrgCascade(app.db, { orgId }); } catch { /* */ } }
      // members first, the org owners last
      const owners = [ownerA.id, ownerB.id];
      await cleanupUsers(app.db, [...cleanup.filter((id) => !owners.includes(id)).reverse(), ...owners]);
    }
  } finally {
    if (app) await app.stop(); else await db.close();
  }
});

test('accessibleWorkspaceIds and /me: exactly the scoped workspaces (region scope covers everything below it)', async () => {
  for (const [k, keys] of Object.entries(EXPECT)) {
    assert.deepEqual((await accessibleWorkspaceIds(RV[k].id, 'user')).sort(), ids(keys), `accessibleWorkspaceIds rv${k}`);
    const me = await j('GET', '/api/auth/me', { token: RV[k].token });
    assert.equal(me.status, 200);
    const listed = me.body.accessible_workspaces;
    assert.deepEqual(listed.map((w) => w.id).sort(), ids(keys), `/me rv${k}`);
    for (const w of listed) {
      assert.equal(w.access, 'regional');
      assert.equal(w.workspace_role, null);
      assert.equal(w.can_admin, false);
      const key = Object.keys(W).find((x) => W[x] === w.id);
      assert.equal(w.region_id, R[key], `region_id on ${key}`);
    }
    assert.equal(me.body.current_org_role, 'regional_viewer');
    assert.ok(ids(keys).includes(me.body.current_workspace_id), 'landed in a scoped workspace');
  }
});

test('REST with explicit X-Workspace-Id: in scope 200 (that workspace only); siblings, out-of-scope, no-region, other-org 403', async () => {
  for (const [k, keys] of Object.entries(EXPECT)) {
    for (const wk of ALL_KEYS) {
      const r = await j('GET', '/api/devices', { token: RV[k].token, ws: W[wk] });
      if (keys.includes(wk)) {
        assert.equal(r.status, 200, `rv${k} -> ${wk}`);
        assert.deepEqual(r.body.map((d) => d.id), [D[wk]]);
      } else {
        assert.equal(r.status, 403, `rv${k} -> ${wk}: ${JSON.stringify(r.body)}`);
      }
    }
  }
});

test('switch-workspace and the CSV export follow the same scope', async () => {
  for (const [k, keys] of Object.entries(EXPECT)) {
    for (const wk of ALL_KEYS) {
      const sw = await j('POST', '/api/auth/switch-workspace', { token: RV[k].token, body: { workspace_id: W[wk] } });
      const ex = await fetch(`${app.base}/api/dashboard/devices/export?format=csv`, { headers: { Authorization: `Bearer ${RV[k].token}`, 'X-Workspace-Id': W[wk] } });
      const csv = await ex.text();
      if (keys.includes(wk)) {
        assert.equal(sw.status, 200, `switch rv${k} -> ${wk}`);
        assert.equal(ex.status, 200, `export rv${k} -> ${wk}`);
        assert.match(ex.headers.get('content-disposition') || '', /attachment/);
        assert.ok(csv.includes(`ref49-dev-${wk}-${TAG}`));
      } else {
        assert.equal(sw.status, 403, `switch rv${k} -> ${wk}`);
        assert.equal(ex.status, 403, `export rv${k} -> ${wk}`);
      }
    }
  }
});

test('regions/sla-overview: only the regions of visible workspaces; another org 403', async () => {
  const r = await j('GET', `/api/organizations/${ownerA.orgId}/regions/sla-overview`, { token: RV.A.token });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.regions.map((x) => x.region_id).sort(), [R.A1, R.T1].sort());
  assert.equal(r.body.regions.reduce((n, x) => n + x.workspace_count, 0), 2);
  assert.ok(!r.body.regions.some((x) => x.region_id === null), 'no Unassigned bucket (no-region workspaces are invisible)');
  assert.equal((await j('GET', `/api/organizations/${ownerB.orgId}/regions/sla-overview`, { token: RV.A.token })).status, 403);
});

test('cross-org guard: a workspace in another org whose region_id names an in-scope region is never reachable', async () => {
  const bad = await wsRow('Bad');
  assert.equal(bad.region_id, R.A1);
  for (const k of Object.keys(EXPECT)) {
    assert.ok(!(await accessibleWorkspaceIds(RV[k].id, 'user')).includes(W.Bad), `rv${k} accessible`);
    assert.equal(await accessContext(RV[k].id, 'user', bad), null);
    assert.equal(await canAccessWorkspace(app.db, { id: RV[k].id, role: 'user' }, bad), false);
  }
});

test('canAccessWorkspace: scoped reads of tickets / campaigns / members; field_technician results unchanged', async () => {
  for (const wk of ALL_KEYS) {
    const want = EXPECT.A.includes(wk) ? 200 : 403;
    for (const sub of ['tickets', 'campaigns', 'members']) {
      const r = await j('GET', `/api/workspaces/${W[wk]}/${sub}`, { token: RV.A.token });
      assert.equal(r.status, want, `rvA ${sub} ${wk}: ${JSON.stringify(r.body).slice(0, 120)}`);
    }
  }
  // field_technician: org-wide visibility exactly as before, and canAccessWorkspace still false
  const orgAWs = (await app.db.prepare('SELECT id FROM workspaces WHERE organization_id = ?').all(ownerA.orgId)).map((r) => r.id).sort();
  assert.deepEqual((await accessibleWorkspaceIds(tech.id, 'user')).sort(), orgAWs);
  for (const wk of ['T1', 'None']) {
    const ws = await wsRow(wk);
    assert.deepEqual(await accessContext(tech.id, 'user', ws), { workspaceRole: 'workspace_viewer', actingAs: false });
    assert.equal(await canAccessWorkspace(app.db, { id: tech.id, role: 'user' }, ws), false);
  }
  assert.equal((await j('GET', `/api/workspaces/${W.T1}/tickets`, { token: tech.token })).status, 403);
});

test('a direct workspace_members row wins: a regional_viewer with an editor row can write there', async () => {
  const body = { name: `ref49-direct-${TAG}` };
  assert.equal((await j('POST', '/api/playlists', { token: RV.T.token, ws: W.T1, body })).status, 403, 'read-only via the scope');
  await app.db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)').run(W.T1, RV.T.id, 'workspace_editor');
  const ok = await j('POST', '/api/playlists', { token: RV.T.token, ws: W.T1, body });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const me = await j('GET', '/api/auth/me', { token: RV.T.token });
  assert.equal(me.body.accessible_workspaces.find((w) => w.id === W.T1).access, 'direct');
  await app.db.prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?').run(W.T1, RV.T.id);
  assert.equal((await j('POST', '/api/playlists', { token: RV.T.token, ws: W.T1, body })).status, 403, 'back to read-only');
});

test('changes apply on the next request: moving a workspace between regions; adding / removing a scope', async () => {
  assert.equal((await j('GET', '/api/devices', { token: RV.T.token, ws: W.A2 })).status, 403);
  assert.equal((await j('PATCH', `/api/workspaces/${W.A2}/region`, { token: ownerA.token, body: { region_id: R.T1 } })).status, 200);
  assert.equal((await j('GET', '/api/devices', { token: RV.T.token, ws: W.A2 })).status, 200, 'moved into T1');
  assert.equal((await j('PATCH', `/api/workspaces/${W.A2}/region`, { token: ownerA.token, body: { region_id: R.A2 } })).status, 200);
  assert.equal((await j('GET', '/api/devices', { token: RV.T.token, ws: W.A2 })).status, 403, 'moved back out');

  assert.equal((await j('GET', '/api/devices', { token: RV.T.token, ws: W.R2 })).status, 403);
  await setScopes(RV.T, ['T1', 'R2']);
  assert.equal((await j('GET', '/api/devices', { token: RV.T.token, ws: W.R2 })).status, 200, 'scope added');
  await setScopes(RV.T, ['T1']);
  assert.equal((await j('GET', '/api/devices', { token: RV.T.token, ws: W.R2 })).status, 403, 'scope removed');
});

test('socket.io: the dashboard socket joins exactly the scoped workspace rooms', async () => {
  const setupDashboardSocket = require('../ws/dashboardSocket');
  const { workspaceRoom } = require('../lib/socket-rooms');
  const httpServer = http.createServer();
  const io = new Server(httpServer);
  const dashboardNs = setupDashboardSocket(io);
  await new Promise((r) => httpServer.listen(0, r));
  const base = `http://127.0.0.1:${httpServer.address().port}`;
  try {
    for (const [k, keys] of Object.entries(EXPECT)) {
      const sock = ioClient(`${base}/dashboard`, { auth: { token: RV[k].token }, transports: ['websocket'], reconnection: false, forceNew: true });
      const got = new Set();
      sock.on('test:ping', (id) => got.add(id));
      await new Promise((resolve, reject) => { sock.on('connect', resolve); sock.on('connect_error', reject); });
      await new Promise((r) => setTimeout(r, 400)); // room joins run after the accessibleWorkspaceIds query
      for (const wk of ALL_KEYS) dashboardNs.to(workspaceRoom(W[wk])).emit('test:ping', W[wk]);
      await new Promise((r) => setTimeout(r, 300));
      sock.close();
      assert.deepEqual([...got].sort(), ids(keys), `rooms of rv${k}`);
    }
  } finally {
    io.close();
    await new Promise((r) => httpServer.close(r));
  }
});

test('tokens: a regional_viewer cannot mint one; a token they hold never reads outside their scope', async () => {
  const mint = await j('POST', '/api/tokens', { token: RV.A.token, ws: W.A1, body: { name: 'nope', scope: 'read' } });
  assert.equal(mint.status, 403);
  assert.deepEqual(mint.body, { error: 'Read-only access' });

  const tokenFor = async (wsKey) => {
    const secret = generateApiToken();
    await app.db.prepare("INSERT INTO api_tokens (id, token_hash, prefix, name, user_id, workspace_id, scope, created_at) VALUES (?, ?, ?, ?, ?, ?, 'read', UNIX_TIMESTAMP())")
      .run(crypto.randomUUID(), hashToken(secret), displayPrefix(secret), `ref49-${wsKey}`, RV.A.id, W[wsKey]);
    return secret;
  };
  const inScope = await tokenFor('A1');
  const r1 = await j('GET', '/api/devices', { token: inScope, ws: W.B }); // header is ignored for tokens
  assert.equal(r1.status, 200);
  assert.deepEqual(r1.body.map((d) => d.id), [D.A1]);
  // bound to a workspace outside the scope: never lands there or anywhere else out of scope
  const outScope = await tokenFor('R2');
  const r2 = await j('GET', '/api/devices', { token: outScope });
  const seen = (Array.isArray(r2.body) ? r2.body : []).map((d) => d.id);
  const allowed = new Set(EXPECT.A.map((k) => D[k]));
  assert.ok(seen.every((id) => allowed.has(id)), `out-of-scope token saw ${JSON.stringify(seen)}`);
  assert.ok(!seen.includes(D.R2));
});

test('login: a regional_viewer with no direct row lands in scope and gets NO personal org; a brand-new user still gets one', async () => {
  const saved = config.autoCreateOrgOnSignup;
  config.autoCreateOrgOnSignup = true;
  try {
    for (const [k, keys] of Object.entries(EXPECT)) {
      const body = await login(RV[k]);
      assert.ok(ids(keys).includes(body.current_workspace_id), `rv${k} landed in scope`);
      assert.equal((await app.db.prepare('SELECT COUNT(*) AS n FROM organizations WHERE owner_user_id = ?').get(RV[k].id)).n, 0, `rv${k} owns no org`);
    }
    const fresh = await registerUser('ref49fresh');
    const body = await login(fresh);
    assert.ok(body.current_workspace_id, 'a fresh user is minted a workspace');
    assert.equal((await app.db.prepare('SELECT COUNT(*) AS n FROM organizations WHERE owner_user_id = ?').get(fresh.id)).n, 1);
  } finally {
    config.autoCreateOrgOnSignup = saved;
  }
});

test('cleanup: scopes go on member removal, role change, user deletion, org deletion (region deletion: regions-hierarchy.test.js)', async () => {
  const count = async (userId) => (await app.db.prepare('SELECT COUNT(*) AS n FROM region_viewer_scopes WHERE user_id = ?').get(userId)).n;
  const fresh = async (key) => {
    const u = await registerUser(`ref49c${key}`);
    await addOrgMember(ownerA.orgId, u.id, 'regional_viewer');
    await setScopes(u, ['R', 'R2']);
    assert.equal(await count(u.id), 2);
    return u;
  };
  const removed = await fresh('rm');
  assert.equal((await j('DELETE', `/api/organizations/${ownerA.orgId}/members/${removed.id}`, { token: ownerA.token })).status, 200);
  assert.equal(await count(removed.id), 0, 'member removal');

  const changed = await fresh('role');
  assert.equal((await j('PUT', `/api/organizations/${ownerA.orgId}/members/${changed.id}`, { token: ownerA.token, body: { role: 'org_admin' } })).status, 200);
  assert.equal(await count(changed.id), 0, 'role change');

  const deleted = await fresh('del');
  await deleteUserCascade(app.db, { targetId: deleted.id, actingAdminId: ownerA.id });
  cleanup.splice(cleanup.indexOf(deleted.id), 1);
  assert.equal(await count(deleted.id), 0, 'user deletion');

  // a scratch org with its own tree, member and scope, deleted whole
  const orgOwner = await registerUser('ref49corg', true);
  const reg = await j('POST', `/api/organizations/${orgOwner.orgId}/regions`, { token: orgOwner.token, body: { name: `Scratch-${TAG}` } });
  const sub = await j('POST', `/api/organizations/${orgOwner.orgId}/regions`, { token: orgOwner.token, body: { name: `ScratchC-${TAG}`, level: 'cluster', parent_id: reg.body.id } });
  assert.equal(sub.status, 201);
  const member = await registerUser('ref49corgrv');
  await addOrgMember(orgOwner.orgId, member.id, 'regional_viewer');
  await app.db.prepare('INSERT INTO region_viewer_scopes (organization_id, user_id, region_id) VALUES (?, ?, ?)').run(orgOwner.orgId, member.id, sub.body.id);
  await deleteOrgCascade(app.db, { orgId: orgOwner.orgId });
  assert.equal(await count(member.id), 0, 'org deletion');
  assert.equal((await app.db.prepare('SELECT COUNT(*) AS n FROM regions WHERE organization_id = ?').get(orgOwner.orgId)).n, 0, 'the whole tree went with the org');
});
