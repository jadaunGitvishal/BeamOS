'use strict';

// #13 regression: platform_operator gets cross-org workspace read/write (via the
// canWrite broadening to isPlatformStaff) but must STILL be denied writing
// shared/global assets (workspace_id IS NULL), which carry a SEPARATE
// PLATFORM_ROLES gate on top of canWrite. This is the highest-blast-radius deny
// (operator editing platform-wide content), so we prove both halves:
//   (a) operator CAN update/delete a workspace-scoped content row, and
//   (b) operator CANNOT update/delete a shared (workspace_id IS NULL) row.
//
// The REAL content router behind bearerAuth + resolveTenancy (helpers/inprocess-app.js)
// against the REAL MySQL test DB (beamos_test via npm test). Fixtures are test-owned
// (opp- prefix, generated ids). The shared content row has no workspace, so it is deleted
// by id; deleting the org owner cascades the org, workspace and its content.

const test = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const { generateToken } = require('../middleware/auth');
const { startInProcessApp } = require('./helpers/inprocess-app');
const { randTag, cleanupUsers, cleanupContent } = require('./helpers/disposable');

const P = `opp-${randTag()}`;
const id = (name) => `${P}-${name}`;
const ID = { owner: id('owner'), op: id('u-op'), org: id('org-a'), ws: id('ws-a') };

const wsContentId = uuidv4();
const sharedContentId = uuidv4();
let app;
let base;
let opToken;

test.before(async () => {
  app = await startInProcessApp({ only: ['/api/content'] });
  base = app.base;
  const run = (sql, ...p) => db.prepare(sql).run(...p);
  // Seed: org + workspace (owned by a plain user), a platform_operator user, and two content rows.
  await run("INSERT INTO users (id, email, role, password_hash, auth_provider) VALUES (?, ?, 'user', NULL, 'local')", ID.owner, `${P}-owner@test.local`);
  await run("INSERT INTO users (id, email, role, password_hash, auth_provider) VALUES (?, ?, 'platform_operator', NULL, 'local')", ID.op, `${P}-op@test.local`);
  await run("INSERT INTO organizations (id, name, owner_user_id, plan_id, subscription_status) VALUES (?, ?, ?, 'enterprise', 'active')", ID.org, `${P} Org A`, ID.owner);
  await run('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)', ID.ws, ID.org, 'Workspace A');
  // JWT carries current_workspace_id so resolveTenancy lands the operator (acting-as) in ws-a.
  opToken = generateToken({ id: ID.op, email: `${P}-op@test.local`, role: 'platform_operator' }, ID.ws);

  const seedContent = (cid, workspaceId) => run(
    `INSERT INTO content (id, filename, filepath, mime_type, file_size, workspace_id)
     VALUES (?, 'orig.png', '/does/not/exist.png', 'image/png', 123, ?)`, cid, workspaceId);
  await seedContent(wsContentId, ID.ws); // workspace-scoped
  await seedContent(sharedContentId, null); // shared / platform-global (workspace_id IS NULL)
});

test.after(async () => {
  try {
    if (app) {
      await cleanupContent(db, [sharedContentId, wsContentId]);
      await cleanupUsers(db, [ID.op, ID.owner]);
    }
  } finally {
    if (app) await app.stop(); else await db.close();
  }
});

const op = (method, cid, body) => fetch(`${base}/api/content/${cid}`, {
  method,
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opToken}` },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
const contentRow = (cid) => db.prepare('SELECT filename FROM content WHERE id = ?').get(cid);

// (a) Proves the operator's cross-org write actually works (so (b) isn't just
// "operator can't write anything").
test('operator CAN update a workspace-scoped content row', async () => {
  const res = await op('PUT', wsContentId, { filename: 'renamed.png' });
  assert.equal(res.status, 200);
  assert.equal((await contentRow(wsContentId)).filename, 'renamed.png');
});

// (b) The separate PLATFORM_ROLES gate on workspace_id IS NULL must deny operator.
test('operator CANNOT update a shared (workspace_id IS NULL) content row -> 403', async () => {
  const res = await op('PUT', sharedContentId, { filename: 'hijacked.png' });
  assert.equal(res.status, 403);
  assert.equal((await contentRow(sharedContentId)).filename, 'orig.png',
    'shared row must be unchanged');
});

test('operator CANNOT delete a shared (workspace_id IS NULL) content row -> 403', async () => {
  const res = await op('DELETE', sharedContentId);
  assert.equal(res.status, 403);
  assert.ok(await contentRow(sharedContentId), 'shared row must still exist');
});

// Delete last so the workspace-scoped row survives the update assertion above.
test('operator CAN delete a workspace-scoped content row', async () => {
  const res = await op('DELETE', wsContentId);
  assert.equal(res.status, 200);
  assert.ok(!(await contentRow(wsContentId)), 'workspace row deleted');
});
