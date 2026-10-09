'use strict';

// Refs 49/67: the region tree API (routes/organizations.js /:orgId/regions) over
// real HTTP against the REAL MySQL database (helpers/inprocess-app.js). Levels:
// region > cluster > area > territory; a parent must be a strictly higher level
// (skipping is fine), so depth is at most 4; names are unique per parent; a region
// with children can't be deleted; deleting a leaf unassigns its workspaces and
// drops regional_viewer scopes on it. Disposable fixtures, deleted in after().

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { db, initDb } = require('../db/database');
const { startInProcessApp } = require('./helpers/inprocess-app');
const { randTag, cleanupUsers } = require('./helpers/disposable');

const TAG = randTag();
let app;
const cleanup = [];
let owner, other;

async function j(method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${app.base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

async function registerUser(prefix, createOrg = true) {
  const email = `${prefix}-${randTag()}@ref49tree.local`;
  const r = await j('POST', '/api/auth/register', { body: { email, password: 'ref49-tree-pass-1', name: prefix, createOrg } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  cleanup.push(r.body.user.id);
  const ws = r.body.current_workspace_id
    ? await app.db.prepare('SELECT organization_id FROM workspaces WHERE id = ?').get(r.body.current_workspace_id)
    : null;
  return { id: r.body.user.id, email, token: r.body.token, workspaceId: r.body.current_workspace_id, orgId: ws?.organization_id };
}

const regs = (orgId, id) => `/api/organizations/${orgId}/regions${id ? `/${id}` : ''}`;
async function make(name, level, parentId, who = owner) {
  const r = await j('POST', regs(who.orgId), { token: who.token, body: { name: `${name}-${TAG}`, level, parent_id: parentId } });
  assert.equal(r.status, 201, `${name}: ${JSON.stringify(r.body)}`);
  return r.body;
}
const tryMake = (name, level, parentId, who = owner) =>
  j('POST', regs(who.orgId), { token: who.token, body: { name: `${name}-${TAG}`, level, parent_id: parentId } });

test.before(async () => {
  await initDb();
  app = await startInProcessApp({ only: ['/api/organizations', '/api/workspaces'] });
  owner = await registerUser('ref49own');
  other = await registerUser('ref49other');
});

test.after(async () => {
  try {
    if (app) {
      await cleanupUsers(app.db, cleanup.reverse());
    }
  } finally {
    if (app) await app.stop(); else await db.close();
  }
});

test('levels: unknown level 400; omitted level = top-level region; GET lists level and parent_id', async () => {
  for (const level of ['country', 'Region', 'tse', 42]) {
    const r = await tryMake('bad', level, null);
    assert.equal(r.status, 400, JSON.stringify(level));
  }
  const plain = await j('POST', regs(owner.orgId), { token: owner.token, body: { name: `Plain-${TAG}` } });
  assert.equal(plain.status, 201);
  assert.equal(plain.body.level, 'region');
  assert.equal(plain.body.parent_id, null);
  const list = await j('GET', regs(owner.orgId), { token: owner.token });
  const row = list.body.find((x) => x.id === plain.body.id);
  assert.equal(row.level, 'region');
  assert.equal(row.parent_id, null);
});

test('parent must be strictly higher; skipping a level is fine; depth tops out at 4', async () => {
  const r = await make('North', 'region', null);
  const c = await make('NorthC', 'cluster', r.id);
  const a = await make('NorthA', 'area', c.id);
  const t = await make('NorthT', 'territory', a.id);
  assert.equal((await make('SkipT', 'territory', c.id)).parent_id, c.id, 'territory directly under cluster');
  assert.equal((await make('SkipA', 'area', r.id)).parent_id, r.id, 'area directly under region');

  assert.equal((await tryMake('RegUnderReg', 'region', r.id)).status, 400, 'same level');
  assert.equal((await tryMake('ClusterUnderArea', 'cluster', a.id)).status, 400, 'lower parent');
  assert.equal((await tryMake('AreaUnderArea', 'area', a.id)).status, 400);
  for (const level of ['region', 'cluster', 'area', 'territory']) {
    assert.equal((await tryMake(`Under-T-${level}`, level, t.id)).status, 400, `nothing below a territory (${level})`);
  }
  assert.equal((await tryMake('NoParent', 'cluster', crypto.randomUUID())).status, 400, 'unknown parent');
});

test('cross-org parent refused (API 400, and the composite FK refuses it in the DB too)', async () => {
  const theirs = await make('TheirRegion', 'region', null, other);
  const r = await tryMake('Sneaky', 'cluster', theirs.id);
  assert.equal(r.status, 400, JSON.stringify(r.body));
  await assert.rejects(
    app.db.prepare('INSERT INTO regions (id, organization_id, name, level, parent_id) VALUES (?, ?, ?, ?, ?)')
      .run(crypto.randomUUID(), owner.orgId, `DbSneaky-${TAG}`, 'cluster', theirs.id),
    (e) => e.code === 'ER_NO_REFERENCED_ROW_2',
  );
});

test('names are unique per parent: same name under different parents OK; same parent 409 (API and DB)', async () => {
  const r = await make('Names', 'region', null);
  const c1 = await make('NamesC1', 'cluster', r.id);
  const c2 = await make('NamesC2', 'cluster', r.id);
  const a1 = await j('POST', regs(owner.orgId), { token: owner.token, body: { name: `Central-${TAG}`, level: 'area', parent_id: c1.id } });
  const a2 = await j('POST', regs(owner.orgId), { token: owner.token, body: { name: `Central-${TAG}`, level: 'area', parent_id: c2.id } });
  assert.equal(a1.status, 201);
  assert.equal(a2.status, 201, 'same name under a different parent');
  const dup = await j('POST', regs(owner.orgId), { token: owner.token, body: { name: `Central-${TAG}`, level: 'area', parent_id: c1.id } });
  assert.equal(dup.status, 409);
  assert.equal((await tryMake('Names', 'region', null)).status, 409, 'top-level duplicate');
  // rename / move into a sibling's name
  assert.equal((await j('PATCH', regs(owner.orgId, c2.id), { token: owner.token, body: { name: `NamesC1-${TAG}` } })).status, 409);
  assert.equal((await j('PATCH', regs(owner.orgId, a2.body.id), { token: owner.token, body: { parent_id: c1.id } })).status, 409, 'moving next to a same-named sibling');
  // the DB backs it up, including the top level (parent_key)
  await assert.rejects(
    app.db.prepare('INSERT INTO regions (id, organization_id, name, level) VALUES (?, ?, ?, ?)').run(crypto.randomUUID(), owner.orgId, `Names-${TAG}`, 'region'),
    (e) => e.code === 'ER_DUP_ENTRY',
  );
});

test('PATCH: self / descendant parent refused; a level change that would break a child refused; a valid move works', async () => {
  const r = await make('Move', 'region', null);
  const c = await make('MoveC', 'cluster', r.id);
  const c2 = await make('MoveC2', 'cluster', r.id);
  const a = await make('MoveA', 'area', c.id);
  const t = await make('MoveT', 'territory', a.id);

  const self = await j('PATCH', regs(owner.orgId, c.id), { token: owner.token, body: { parent_id: c.id } });
  assert.equal(self.status, 400);
  const desc = await j('PATCH', regs(owner.orgId, c.id), { token: owner.token, body: { parent_id: t.id } });
  assert.equal(desc.status, 400);
  assert.match(desc.body.error, /descendant/);

  for (const level of ['area', 'territory']) {
    const br = await j('PATCH', regs(owner.orgId, c.id), { token: owner.token, body: { level } });
    assert.equal(br.status, 400, `cluster -> ${level} with an area child`);
  }
  assert.equal((await j('PATCH', regs(owner.orgId, r.id), { token: owner.token, body: { level: 'cluster' } })).status, 400, 'region -> cluster with cluster children');
  assert.equal((await j('PATCH', regs(owner.orgId, a.id), { token: owner.token, body: { level: 'region' } })).status, 400, 'area -> region under a cluster parent');
  assert.equal((await j('PATCH', regs(owner.orgId, a.id), { token: owner.token, body: {} })).status, 400, 'nothing to update');

  const mv = await j('PATCH', regs(owner.orgId, a.id), { token: owner.token, body: { parent_id: c2.id } });
  assert.equal(mv.status, 200, JSON.stringify(mv.body));
  assert.equal(mv.body.parent_id, c2.id);
  const lvl = await j('PATCH', regs(owner.orgId, t.id), { token: owner.token, body: { level: 'territory', name: `MoveT2-${TAG}` } });
  assert.equal(lvl.status, 200);
  // a top-level region can be re-parented only under something higher - nothing is
  const up = await j('PATCH', regs(owner.orgId, c2.id), { token: owner.token, body: { parent_id: null } });
  assert.equal(up.status, 200, 'a cluster may become a top-level node (parent null)');
  assert.equal(up.body.parent_id, null);
});

test('delete: 409 while it has children; deleting a leaf unassigns its workspaces and drops scopes on it', async () => {
  const r = await make('Del', 'region', null);
  const leaf = await make('DelLeaf', 'territory', r.id);
  assert.equal((await j('DELETE', regs(owner.orgId, r.id), { token: owner.token })).status, 409);

  const ws = crypto.randomUUID();
  await app.db.prepare('INSERT INTO workspaces (id, organization_id, name, region_id) VALUES (?, ?, ?, ?)').run(ws, owner.orgId, `ref49-del-${TAG}`, leaf.id);
  const rv = await registerUser('ref49delrv', false);
  const add = await j('POST', `/api/organizations/${owner.orgId}/members`, { token: owner.token, body: { email: rv.email, role: 'regional_viewer' } });
  assert.equal(add.status, 201, JSON.stringify(add.body));
  const put = await j('PUT', `/api/organizations/${owner.orgId}/members/${rv.id}/region-scopes`, { token: owner.token, body: { region_ids: [leaf.id, r.id] } });
  assert.equal(put.status, 200, JSON.stringify(put.body));

  const del = await j('DELETE', regs(owner.orgId, leaf.id), { token: owner.token });
  assert.equal(del.status, 200);
  assert.deepEqual(del.body, { success: true, workspaces_unassigned: 1 });
  assert.equal((await app.db.prepare('SELECT region_id FROM workspaces WHERE id = ?').get(ws)).region_id, null);
  const scopes = await app.db.prepare('SELECT region_id FROM region_viewer_scopes WHERE user_id = ?').all(rv.id);
  assert.deepEqual(scopes.map((s) => s.region_id), [r.id], 'the scope on the deleted leaf is gone, the other stays');
  assert.equal((await j('DELETE', regs(owner.orgId, r.id), { token: owner.token })).status, 200, 'no children left');
  assert.equal((await app.db.prepare('SELECT COUNT(*) AS n FROM region_viewer_scopes WHERE user_id = ?').get(rv.id)).n, 0);
});

test('workspace region assignment still refuses another org\'s region', async () => {
  const theirs = await make('TheirsWs', 'region', null, other);
  const r = await j('PATCH', `/api/workspaces/${owner.workspaceId}/region`, { token: owner.token, body: { region_id: theirs.id } });
  assert.equal(r.status, 400);
});
