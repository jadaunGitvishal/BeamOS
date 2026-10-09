'use strict';

// Ref 7: lib/entra-role-sync.js - computeTargetMemberships (pure) and
// syncEntraRoles against the REAL MySQL database. Fixtures are disposable,
// randomly tagged users/orgs created through the real /api/auth/register route
// (helpers/inprocess-app.js) and deleted in after(). Claim values carry the run
// tag, because syncEntraRoles loads the mappings of EVERY org in the shared DB.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { db, initDb } = require('../db/database');
const { startInProcessApp } = require('./helpers/inprocess-app');
const { randTag, cleanupUsers } = require('./helpers/disposable');
const { verifyChain } = require('../lib/activity-chain');
const {
  computeTargetMemberships,
  normalizeRoleClaims,
  syncEntraRoles,
  MAX_CLAIM_VALUES,
} = require('../lib/entra-role-sync');

// ===================== computeTargetMemberships (pure) =====================

const M = (organization_id, claim_value, role, workspace_id = null) => ({ organization_id, claim_value, role, workspace_id });

test('compute: empty / invalid claim -> no targets', () => {
  const maps = [M('o1', 'A', 'org_admin'), M('o1', 'A', 'workspace_viewer', 'w1')];
  const none = { org: [], workspace: [] };
  for (const claim of [undefined, null, 'A', 42, {}, [], [null, 7, {}, ['A']], ['', '   ']]) {
    assert.deepEqual(computeTargetMemberships(claim, maps), none, JSON.stringify(claim));
  }
  assert.deepEqual(computeTargetMemberships(['A'], []), none);
  assert.deepEqual(computeTargetMemberships(['A'], undefined), none);
});

test('compute: one mapping, several mappings, org + workspace for the same value', () => {
  assert.deepEqual(computeTargetMemberships(['A'], [M('o1', 'A', 'workspace_editor', 'w1')]), {
    org: [],
    workspace: [{ workspace_id: 'w1', organization_id: 'o1', role: 'workspace_editor' }],
  });
  const maps = [
    M('o1', 'A', 'org_admin'),
    M('o1', 'A', 'workspace_admin', 'w1'),
    M('o1', 'B', 'workspace_viewer', 'w2'),
    M('o2', 'B', 'org_admin'),
  ];
  assert.deepEqual(computeTargetMemberships(['A', 'B'], maps), {
    org: [{ organization_id: 'o1', role: 'org_admin' }, { organization_id: 'o2', role: 'org_admin' }],
    workspace: [
      { workspace_id: 'w1', organization_id: 'o1', role: 'workspace_admin' },
      { workspace_id: 'w2', organization_id: 'o1', role: 'workspace_viewer' },
    ],
  });
  assert.deepEqual(computeTargetMemberships(['A'], maps), {
    org: [{ organization_id: 'o1', role: 'org_admin' }],
    workspace: [{ workspace_id: 'w1', organization_id: 'o1', role: 'workspace_admin' }],
  });
});

test('compute: highest workspace role wins, in any order', () => {
  const maps = [
    M('o1', 'V', 'workspace_viewer', 'w1'),
    M('o1', 'A', 'workspace_admin', 'w1'),
    M('o1', 'E', 'workspace_editor', 'w1'),
  ];
  const role = (claims, m = maps) => computeTargetMemberships(claims, m).workspace[0].role;
  assert.equal(role(['V', 'E']), 'workspace_editor');
  assert.equal(role(['E', 'V']), 'workspace_editor');
  assert.equal(role(['V', 'A', 'E']), 'workspace_admin');
  assert.equal(role(['V', 'A', 'E'], [...maps].reverse()), 'workspace_admin');
  assert.equal(role(['V']), 'workspace_viewer');
});

test('compute: unknown values ignored; exact, case-sensitive match; trimmed; bad mapping rows ignored', () => {
  const maps = [
    M('o1', 'Editors', 'workspace_editor', 'w1'),
    M('o1', 'Owners', 'org_owner'),            // not mappable
    M('o1', 'Techs', 'field_technician'),      // not mappable
    M('o1', 'Plat', 'platform_admin'),         // not mappable
    M('o1', 'OrgWs', 'org_admin', 'w1'),       // org role with a workspace
    M('o1', 'WsNoWs', 'workspace_admin'),      // workspace role without one
  ];
  const none = { org: [], workspace: [] };
  assert.deepEqual(computeTargetMemberships(['Nope', 'editors', 'EDITORS'], maps), none);
  assert.deepEqual(computeTargetMemberships(['Owners', 'Techs', 'Plat', 'OrgWs', 'WsNoWs'], maps), none);
  assert.equal(computeTargetMemberships(['  Editors  '], maps).workspace[0].role, 'workspace_editor');
});

test('compute: claim cap (100 values) and length limit (255, dropped not truncated)', () => {
  const long = 'x'.repeat(256);
  assert.deepEqual(normalizeRoleClaims([long, 'x'.repeat(255)]), ['x'.repeat(255)]);
  // A 256-char value must not match a mapping on its 255-char prefix.
  assert.deepEqual(computeTargetMemberships([long], [M('o1', 'x'.repeat(255), 'org_admin')]), { org: [], workspace: [] });

  const many = Array.from({ length: 150 }, (_, i) => `r${i}`);
  const norm = normalizeRoleClaims(many);
  assert.equal(MAX_CLAIM_VALUES, 100);
  assert.equal(norm.length, 100);
  assert.deepEqual(norm.slice(-1), ['r99']);
  const maps = [M('o1', 'r99', 'workspace_viewer', 'w1'), M('o1', 'r100', 'workspace_admin', 'w1')];
  assert.equal(computeTargetMemberships(many, maps).workspace[0].role, 'workspace_viewer', 'r100 is past the cap');
  // non-strings and duplicates don't use up the cap
  assert.deepEqual(normalizeRoleClaims([1, 'a', 'a', ' a ', null, 'b']), ['a', 'b']);
});

// ===================== syncEntraRoles (real MySQL) =====================

const TAG = randTag();
const C = (name) => `Ref7Sync.${name}.${TAG}`;
let app;
const cleanup = [];
let subject, ownerA, ownerB, orgA, orgB, wsA1, wsA2, wsA3, wsB1;
let firstAuditId = null;

async function j(method, path, body) {
  const res = await fetch(`${app.base}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function registerUser(prefix) {
  const email = `${prefix}-${randTag()}@ref7sync.local`;
  const r = await j('POST', '/api/auth/register', { email, password: 'ref7-sync-pass-1', name: prefix, createOrg: true });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  cleanup.push(r.body.user.id);
  const ws = await app.db.prepare('SELECT organization_id FROM workspaces WHERE id = ?').get(r.body.current_workspace_id);
  return { id: r.body.user.id, email, workspaceId: r.body.current_workspace_id, orgId: ws.organization_id };
}

async function addWorkspace(orgId, name) {
  const id = crypto.randomUUID();
  await app.db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run(id, orgId, `${name}-${TAG}`);
  return id;
}

const addMapping = async (orgId, claim, role, wsId = null) =>
  (await app.db
    .prepare('INSERT INTO entra_role_mappings (organization_id, claim_value, workspace_id, role) VALUES (?, ?, ?, ?)')
    .run(orgId, claim, wsId, role)).lastInsertRowid;

// The subject's memberships in the fixture orgs, as sortable strings.
async function memberships(userId = subject.id) {
  const o = await app.db
    .prepare('SELECT organization_id AS id, role, source FROM organization_members WHERE user_id = ? ORDER BY organization_id')
    .all(userId);
  const w = await app.db
    .prepare('SELECT workspace_id AS id, role, source FROM workspace_members WHERE user_id = ? ORDER BY workspace_id')
    .all(userId);
  return [
    ...o.map((r) => `org:${r.id}:${r.role}:${r.source ?? 'manual'}`),
    ...w.map((r) => `ws:${r.id}:${r.role}:${r.source ?? 'manual'}`),
  ].sort();
}
const auditRows = (userId = subject.id) =>
  app.db.prepare("SELECT id, details FROM activity_log WHERE action = 'entra_role_sync' AND user_id = ? ORDER BY id").all(userId);

test.before(async () => {
  await initDb();
  app = await startInProcessApp({ only: ['/api/organizations'] });
  ownerA = await registerUser('ref7owna');
  ownerB = await registerUser('ref7ownb');
  subject = await registerUser('ref7subj');
  orgA = ownerA.orgId;
  orgB = ownerB.orgId;
  wsA1 = ownerA.workspaceId;
  wsA2 = await addWorkspace(orgA, 'ref7-wsA2');
  wsA3 = await addWorkspace(orgA, 'ref7-wsA3');
  wsB1 = ownerB.workspaceId;

  await addMapping(orgA, C('Admins'), 'org_admin');
  await addMapping(orgA, C('Editors'), 'workspace_editor', wsA1);
  await addMapping(orgA, C('Viewers'), 'workspace_viewer', wsA1);
  await addMapping(orgA, C('Viewers'), 'workspace_editor', wsA3);
  await addMapping(orgA, C('A2Admins'), 'workspace_admin', wsA2);
  // A manual membership where a mapping points.
  await app.db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)').run(wsA2, subject.id, 'workspace_viewer');
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

let personal; // the subject's own org (manual org_owner + workspace_admin), never mapped
test('sync: adds org + workspace memberships with source = entra; audit row written', async () => {
  personal = (await memberships()).filter((m) => m.includes(subject.orgId) || m.includes(subject.workspaceId));
  assert.deepEqual(personal, [`org:${subject.orgId}:org_owner:manual`, `ws:${subject.workspaceId}:workspace_admin:manual`].sort());

  const s = await syncEntraRoles(app.db, subject.id, [C('Admins'), C('Editors'), 'Unmapped.Value']);
  assert.deepEqual(s, {
    added: [`org:${orgA}:org_admin`, `ws:${wsA1}:workspace_editor`],
    updated: [],
    removed: [],
    skipped_manual: [],
  });
  assert.deepEqual(await memberships(), [
    ...personal,
    `org:${orgA}:org_admin:entra`,
    `ws:${wsA1}:workspace_editor:entra`,
    `ws:${wsA2}:workspace_viewer:manual`,
  ].sort());
  const rows = await auditRows();
  assert.equal(rows.length, 1);
  firstAuditId = rows[0].id;
  assert.deepEqual(JSON.parse(rows[0].details), s);

  // Same claim again: nothing changes, no new audit row.
  assert.deepEqual(await syncEntraRoles(app.db, subject.id, [C('Admins'), C('Editors')]), { added: [], updated: [], removed: [], skipped_manual: [] });
  assert.equal((await auditRows()).length, 1);
});

test('sync: demote and promote an entra row (highest of several mappings wins)', async () => {
  let s = await syncEntraRoles(app.db, subject.id, [C('Admins'), C('Viewers')]);
  assert.deepEqual(s.updated, [`ws:${wsA1}:workspace_viewer`]);
  assert.deepEqual(s.added, [`ws:${wsA3}:workspace_editor`]);
  assert.deepEqual(s.removed, []);
  s = await syncEntraRoles(app.db, subject.id, [C('Admins'), C('Viewers'), C('Editors')]);
  assert.deepEqual(s.updated, [`ws:${wsA1}:workspace_editor`]);
  assert.deepEqual(await memberships(), [
    ...personal,
    `org:${orgA}:org_admin:entra`,
    `ws:${wsA1}:workspace_editor:entra`,
    `ws:${wsA2}:workspace_viewer:manual`,
    `ws:${wsA3}:workspace_editor:entra`,
  ].sort());
});

test('sync: a manual row is skipped and left unchanged (role and source), and never removed', async () => {
  const before = await memberships();
  const auditBefore = (await auditRows()).length;
  const s = await syncEntraRoles(app.db, subject.id, [C('Admins'), C('Viewers'), C('Editors'), C('A2Admins')]);
  assert.deepEqual(s, { added: [], updated: [], removed: [], skipped_manual: [`ws:${wsA2}:workspace_admin`] });
  assert.deepEqual(await memberships(), before, 'wsA2 stays workspace_viewer / manual');
  assert.equal((await auditRows()).length, auditBefore, 'a skip-only sync writes NO audit entry');
  // Claim gone: the manual row survives too.
  const s2 = await syncEntraRoles(app.db, subject.id, [C('Admins'), C('Viewers'), C('Editors')]);
  assert.deepEqual(s2, { added: [], updated: [], removed: [], skipped_manual: [] });
  assert.ok((await memberships()).includes(`ws:${wsA2}:workspace_viewer:manual`));
  // The manual org_owner row of the subject's own org is never touched either.
  assert.ok(personal.every((p) => before.includes(p)));
});

test('sync: a forced error mid-sync rolls everything back (nothing changed, no audit row)', async () => {
  const before = await memberships();
  const auditBefore = (await auditRows()).length;
  // This claim would UPDATE wsA1 (editor -> viewer), keep wsA3, and DELETE the
  // org_admin row. Make the DELETE fail after the UPDATE already ran.
  let updatesRan = 0;
  const failing = {
    ...app.db,
    transaction(fn) {
      return app.db.transaction(async (tx) =>
        fn({
          exec: tx.exec,
          prepare(sql) {
            const st = tx.prepare(sql);
            if (/^UPDATE/.test(sql)) return { ...st, run: async (...a) => { updatesRan++; return st.run(...a); } };
            if (/^DELETE/.test(sql)) return { ...st, run: async () => { throw new Error('forced mid-sync failure'); } };
            return st;
          },
        }),
      );
    },
  };
  await assert.rejects(syncEntraRoles(failing, subject.id, [C('Viewers')]), /forced mid-sync failure/);
  assert.equal(updatesRan, 1, 'the UPDATE ran before the failure');
  assert.deepEqual(await memberships(), before, 'rolled back');
  assert.equal((await auditRows()).length, auditBefore, 'no audit row for a failed sync');
});

test('sync: entra rows are removed when the claim is gone', async () => {
  const s = await syncEntraRoles(app.db, subject.id, [C('Editors')]);
  assert.deepEqual(s.removed.sort(), [`org:${orgA}:org_admin`, `ws:${wsA3}:workspace_editor`].sort());
  assert.deepEqual(await memberships(), [...personal, `ws:${wsA1}:workspace_editor:entra`, `ws:${wsA2}:workspace_viewer:manual`].sort());
});

test("sync: removal after the org's LAST mapping is deleted", async () => {
  const id = await addMapping(orgB, C('BEditors'), 'workspace_editor', wsB1);
  let s = await syncEntraRoles(app.db, subject.id, [C('Editors'), C('BEditors')]);
  assert.deepEqual(s.added, [`ws:${wsB1}:workspace_editor`]);
  await app.db.prepare('DELETE FROM entra_role_mappings WHERE id = ?').run(id);
  assert.equal((await app.db.prepare('SELECT COUNT(*) AS n FROM entra_role_mappings WHERE organization_id = ?').get(orgB)).n, 0);
  s = await syncEntraRoles(app.db, subject.id, [C('Editors'), C('BEditors')]);
  assert.deepEqual(s, { added: [], updated: [], removed: [`ws:${wsB1}:workspace_editor`], skipped_manual: [] });
});

test('sync: an org with no mappings and no entra rows is untouched', async () => {
  // ownerB's org has no mappings now; give the subject a MANUAL row there.
  await app.db.prepare('INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, ?)').run(orgB, subject.id, 'org_admin');
  const before = await memberships();
  const s = await syncEntraRoles(app.db, subject.id, []);
  assert.deepEqual(s.removed, [`ws:${wsA1}:workspace_editor`]);
  const after = await memberships();
  assert.ok(after.includes(`org:${orgB}:org_admin:manual`));
  assert.deepEqual(after, before.filter((m) => m !== `ws:${wsA1}:workspace_editor:entra`));
  assert.deepEqual(after.filter((m) => m.includes(subject.orgId) || m.includes(subject.workspaceId)), personal);
});

test('audit: entra_role_sync entries carry ids and roles only (no claim values, email, oid); chain verifies', async () => {
  const rows = await auditRows();
  assert.ok(rows.length >= 5, `got ${rows.length}`);
  for (const r of rows) {
    const d = JSON.parse(r.details);
    assert.deepEqual(Object.keys(d).sort(), ['added', 'removed', 'skipped_manual', 'updated']);
    for (const item of [...d.added, ...d.updated, ...d.removed, ...d.skipped_manual]) {
      assert.match(item, /^(org|ws):[0-9a-f-]{36}:(org_admin|workspace_admin|workspace_editor|workspace_viewer)$/, item);
    }
    assert.ok(!r.details.includes(TAG), 'no claim value');
    assert.ok(!r.details.includes('Ref7Sync'), 'no claim value');
    assert.ok(!r.details.includes('@'), 'no email');
    assert.ok(!/oid|token|preferred_username/i.test(r.details));
  }
  const report = await verifyChain(app.db, { startId: firstAuditId, endId: rows[rows.length - 1].id });
  assert.equal(report.ok, true, JSON.stringify(report.failures));
  assert.ok(report.checked >= rows.length);
});
