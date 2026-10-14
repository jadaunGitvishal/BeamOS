'use strict';

// Phase 4 Stage A — ticketing data model + manual management endpoints.
//
// The REAL workspaces router in-process (helpers/inprocess-app.js, mounted exactly as
// server.js mounts it: activityLogger, then requireAuth only — the router gates
// per-handler via canWriteWorkspace / canAccessWorkspace, no resolveTenancy) against
// the REAL MySQL test DB (beamos_test via npm test). Covers:
//   - full RBAC matrix (editor+ can manage, viewer read-only, cross-workspace
//     and non-member denied, org/platform paths)
//   - create/update validation (title, enum fields, device cross-workspace guard)
//   - status transitions stamping / clearing resolved_at
//   - list filtering + newest-first ordering
//   - every mutation writes an activity_log row
//
// Fixtures are test-owned (tk- prefix, generated ids) and removed afterwards (newest
// user first, so each org owner goes last). outage_history has no FK, so its rows are
// deleted by device id.

const test = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const { generateToken } = require('../middleware/auth');
const { startInProcessApp } = require('./helpers/inprocess-app');
const { randTag, cleanupUsers } = require('./helpers/disposable');
const { waitForAuditRows, maxAuditId } = require('./helpers/wait-for-audit');

const P = `tk-${randTag()}`;
const id = (name) => `${P}-${name}`;
let app;
const userIds = [];
const U = {};
const T = {};
const ID = {
  orgA: id('org-a'), orgB: id('org-b'),
  wsA: id('ws-a'), wsB: id('ws-b'), wsSla: id('ws-sla'), wsF: id('ws-f'), wsCat: id('ws-cat'), wsSum: id('ws-sum'),
  devA1: id('dev-a1'), devB1: id('dev-b1'),
};

async function mkUser(key, role = 'user') {
  const uid = id(key);
  const email = `${uid}@t.test`;
  await app.db.prepare("INSERT INTO users (id, email, name, password_hash, auth_provider, role) VALUES (?, ?, ?, NULL, 'local', ?)")
    .run(uid, email, uid, role);
  userIds.push(uid);
  U[key] = uid;
  T[key] = generateToken({ id: uid, email, role }, null);
}

test.before(async () => {
  app = await startInProcessApp({ only: ['/api/workspaces'] });
  const run = (sql, ...p) => app.db.prepare(sql).run(...p);

  await mkUser('plat', 'platform_admin');
  await mkUser('orgOwner');
  await mkUser('wsAdmin');
  await mkUser('editor');
  await mkUser('viewer');
  await mkUser('other');
  await mkUser('nobody');

  const org = "INSERT INTO organizations (id, name, owner_user_id, plan_id, subscription_status) VALUES (?, ?, ?, 'enterprise', 'active')";
  await run(org, ID.orgA, `${P} Org A`, U.orgOwner);
  await run(org, ID.orgB, `${P} Org B`, U.other);
  const om = 'INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, ?)';
  await run(om, ID.orgA, U.orgOwner, 'org_owner');
  await run(om, ID.orgB, U.other, 'org_owner');

  const ws = 'INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)';
  await run(ws, ID.wsA, ID.orgA, `${P} WS A`);
  await run(ws, ID.wsB, ID.orgB, `${P} WS B`);
  const wm = 'INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)';
  await run(wm, ID.wsA, U.wsAdmin, 'workspace_admin');
  await run(wm, ID.wsA, U.editor, 'workspace_editor');
  await run(wm, ID.wsA, U.viewer, 'workspace_viewer');
  await run(wm, ID.wsB, U.other, 'workspace_admin');

  await run('INSERT INTO devices (id, workspace_id, name) VALUES (?, ?, ?)', ID.devA1, ID.wsA, 'Lobby A');
  await run('INSERT INTO devices (id, workspace_id, name) VALUES (?, ?, ?)', ID.devB1, ID.wsB, 'Lobby B');

  // Phase 4 Stage C: a clean workspace for the response-time SLA tests so counts
  // are deterministic (ws-a accumulates tickets from the earlier tests).
  await run(ws, ID.wsSla, ID.orgA, `${P} WS SLA`);
  await run(wm, ID.wsSla, U.editor, 'workspace_editor');
  await run(wm, ID.wsSla, U.viewer, 'workspace_viewer');
});

test.after(async () => {
  try {
    if (app) {
      await app.db.prepare('DELETE FROM outage_history WHERE device_id IN (?, ?)').run(ID.devA1, ID.devB1);
      await cleanupUsers(app.db, [...userIds].reverse());
    }
  } finally {
    if (app) await app.stop(); else await db.close();
  }
});

const call = (method, path, token, body) =>
  fetch(app.base + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const tix = (ws) => `/api/workspaces/${ws}/tickets`;
// Only this file's rows: the shared test DB holds other files' audit rows too.
const auditCount = async (action) => Number((await app.db
  .prepare(`SELECT COUNT(*) AS c FROM activity_log WHERE action = ? AND user_id IN (${userIds.map(() => '?').join(',')})`)
  .get(action, ...userIds)).c);

// -------------------------------------------------------------------

test('workspace_editor can create a ticket; defaults + activity_log row', async () => {
  const before = await auditCount('ticket_created');
  const sinceId = await maxAuditId(app.db);
  const r = await call('POST', tix(ID.wsA), T.editor, { title: 'Screen is black' });
  assert.equal(r.status, 201);
  await waitForAuditRows(app.db, { sinceId, userId: U.editor, actions: ['ticket_created'] });
  const t = await r.json();
  assert.equal(t.title, 'Screen is black');
  assert.equal(t.workspace_id, ID.wsA);
  assert.equal(t.status, 'open');
  assert.equal(t.priority, 'medium');
  assert.equal(t.owner_category, 'unassigned');
  assert.equal(t.ticket_category, 'reactive', 'Ref 58: manual tickets default to reactive');
  assert.equal(t.device_id, null);
  assert.equal(t.created_by, U.editor);
  assert.equal(t.created_by_email, `${U.editor}@t.test`);
  assert.equal(t.resolved_at, null);
  assert.equal(await auditCount('ticket_created'), before + 1);
});

test('create with all fields + device in the same workspace', async () => {
  const r = await call('POST', tix(ID.wsA), T.wsAdmin, {
    title: 'Player crash loop', description: 'Restarts every 5 min', device_id: ID.devA1,
    owner_category: 'hardware', priority: 'high',
  });
  assert.equal(r.status, 201);
  const t = await r.json();
  assert.equal(t.device_id, ID.devA1);
  assert.equal(t.device_name, 'Lobby A');
  assert.equal(t.owner_category, 'hardware');
  assert.equal(t.priority, 'high');
  assert.equal(t.description, 'Restarts every 5 min');
});

test('create validation: missing title, bad enum values, unknown + cross-workspace device', async () => {
  assert.equal((await call('POST', tix(ID.wsA), T.editor, {})).status, 400);
  assert.equal((await call('POST', tix(ID.wsA), T.editor, { title: '   ' })).status, 400);
  assert.equal((await call('POST', tix(ID.wsA), T.editor, { title: 'x', priority: 'urgent' })).status, 400);
  assert.equal((await call('POST', tix(ID.wsA), T.editor, { title: 'x', owner_category: 'nobody' })).status, 400);
  assert.equal((await call('POST', tix(ID.wsA), T.editor, { title: 'x', ticket_category: 'urgent' })).status, 400);
  assert.equal((await call('POST', tix(ID.wsA), T.editor, { title: 'x', device_id: id('dev-missing') })).status, 404);
  // device belongs to ws-b, not ws-a
  assert.equal((await call('POST', tix(ID.wsA), T.editor, { title: 'x', device_id: ID.devB1 })).status, 400);
});

test('RBAC: viewer can read but not create or update', async () => {
  const list = await call('GET', tix(ID.wsA), T.viewer);
  assert.equal(list.status, 200);
  assert.ok((await list.json()).length >= 1);

  assert.equal((await call('POST', tix(ID.wsA), T.viewer, { title: 'nope' })).status, 403);

  const anyTicket = (await (await call('GET', tix(ID.wsA), T.viewer)).json())[0];
  assert.equal((await call('PATCH', `${tix(ID.wsA)}/${anyTicket.id}`, T.viewer, { status: 'closed' })).status, 403);
});

test('RBAC: non-member and other-org user get 403 on everything; cross-workspace denied', async () => {
  for (const who of [T.nobody, T.other]) {
    assert.equal((await call('GET', tix(ID.wsA), who)).status, 403);
    assert.equal((await call('POST', tix(ID.wsA), who, { title: 'x' })).status, 403);
  }
  // ws-b admin cannot reach into ws-a
  assert.equal((await call('GET', tix(ID.wsA), T.other)).status, 403);
  // unknown workspace
  assert.equal((await call('GET', tix(id('ws-zzz')), T.plat)).status, 404);
  assert.equal((await call('POST', tix(id('ws-zzz')), T.plat, { title: 'x' })).status, 404);
});

test('RBAC: org_owner and platform_admin can manage without a workspace_members row', async () => {
  assert.equal((await call('POST', tix(ID.wsA), T.orgOwner, { title: 'from org owner' })).status, 201);
  assert.equal((await call('POST', tix(ID.wsA), T.plat, { title: 'from platform' })).status, 201);
});

test('PATCH: status/priority/owner transitions + resolved_at lifecycle + audit', async () => {
  const t = await (await call('POST', tix(ID.wsA), T.editor, { title: 'lifecycle', priority: 'low' })).json();
  const url = `${tix(ID.wsA)}/${t.id}`;
  const before = await auditCount('ticket_updated');
  const sinceId = await maxAuditId(app.db);

  let u = await (await call('PATCH', url, T.editor, { status: 'in_progress', priority: 'high' })).json();
  assert.equal(u.status, 'in_progress');
  assert.equal(u.priority, 'high');
  assert.equal(u.resolved_at, null);

  u = await (await call('PATCH', url, T.editor, { status: 'resolved' })).json();
  assert.equal(u.status, 'resolved');
  assert.ok(u.resolved_at > 0, 'resolved_at stamped on entering resolved');

  const firstResolvedAt = u.resolved_at;
  u = await (await call('PATCH', url, T.editor, { status: 'closed' })).json();
  assert.equal(u.status, 'closed');
  assert.equal(u.resolved_at, firstResolvedAt, 'resolved_at unchanged moving resolved -> closed');

  u = await (await call('PATCH', url, T.editor, { status: 'open' })).json();
  assert.equal(u.status, 'open');
  assert.equal(u.resolved_at, null, 'resolved_at cleared moving back to open');

  u = await (await call('PATCH', url, T.editor, { owner_category: 'customer_it' })).json();
  assert.equal(u.owner_category, 'customer_it');

  await waitForAuditRows(app.db, { sinceId, userId: U.editor, actions: ['ticket_updated'], count: 5 });
  assert.equal(await auditCount('ticket_updated'), before + 5);
});

test('PATCH validation: bad values 400, no keys 400, unknown ticket 404, wrong-workspace ticket 404', async () => {
  const t = await (await call('POST', tix(ID.wsA), T.editor, { title: 'v' })).json();
  const url = `${tix(ID.wsA)}/${t.id}`;
  assert.equal((await call('PATCH', url, T.editor, {})).status, 400);
  assert.equal((await call('PATCH', url, T.editor, { status: 'done' })).status, 400);
  assert.equal((await call('PATCH', url, T.editor, { priority: 'p1' })).status, 400);
  assert.equal((await call('PATCH', url, T.editor, { owner_category: 'space_force' })).status, 400);
  assert.equal((await call('PATCH', `${tix(ID.wsA)}/nope`, T.editor, { status: 'closed' })).status, 404);
  // ticket exists but in ws-b -> not found under ws-a
  const tb = await app.db.prepare("INSERT INTO tickets (id, workspace_id, title) VALUES (?, ?, 'B ticket')").run(id('tk-b'), ID.wsB);
  assert.equal(tb.changes, 1);
  assert.equal((await call('PATCH', `${tix(ID.wsA)}/${id('tk-b')}`, T.editor, { status: 'closed' })).status, 404);
});

test('PATCH with only no-op values returns the row unchanged, 200', async () => {
  const t = await (await call('POST', tix(ID.wsA), T.editor, { title: 'noop', priority: 'medium' })).json();
  const r = await call('PATCH', `${tix(ID.wsA)}/${t.id}`, T.editor, { priority: 'medium', status: 'open' });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).priority, 'medium');
});

test('GET single ticket + 404 for other workspace', async () => {
  const t = await (await call('POST', tix(ID.wsA), T.editor, { title: 'detail me' })).json();
  const got = await call('GET', `${tix(ID.wsA)}/${t.id}`, T.viewer);
  assert.equal(got.status, 200);
  assert.equal((await got.json()).title, 'detail me');
  assert.equal((await call('GET', `${tix(ID.wsB)}/${t.id}`, T.other)).status, 404);
});

test('GET list: filters by status / priority / owner_category, newest first', async () => {
  // dedicated workspace so counts are deterministic
  await app.db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run(ID.wsF, ID.orgA, `${P} WS F`);
  const mk = (body) => call('POST', tix(ID.wsF), T.orgOwner, body);
  const t1 = await (await mk({ title: 'one', priority: 'low', owner_category: 'platform' })).json();
  const t2 = await (await mk({ title: 'two', priority: 'high', owner_category: 'store_staff' })).json();
  const t3 = await (await mk({ title: 'three', priority: 'high', owner_category: 'platform' })).json();
  await call('PATCH', `${tix(ID.wsF)}/${t2.id}`, T.orgOwner, { status: 'closed' });
  // space out created_at so ordering is unambiguous
  await app.db.prepare('UPDATE tickets SET created_at = ? WHERE id = ?').run(100, t1.id);
  await app.db.prepare('UPDATE tickets SET created_at = ? WHERE id = ?').run(200, t2.id);
  await app.db.prepare('UPDATE tickets SET created_at = ? WHERE id = ?').run(300, t3.id);

  const all = await (await call('GET', tix(ID.wsF), T.viewer ? T.orgOwner : T.orgOwner)).json();
  assert.deepEqual(all.map((t) => t.title), ['three', 'two', 'one']);

  const high = await (await call('GET', `${tix(ID.wsF)}?priority=high`, T.orgOwner)).json();
  assert.deepEqual(high.map((t) => t.title).sort(), ['three', 'two']);

  const open = await (await call('GET', `${tix(ID.wsF)}?status=open`, T.orgOwner)).json();
  assert.deepEqual(open.map((t) => t.title).sort(), ['one', 'three']);

  const platform = await (await call('GET', `${tix(ID.wsF)}?owner_category=platform`, T.orgOwner)).json();
  assert.deepEqual(platform.map((t) => t.title).sort(), ['one', 'three']);

  assert.equal((await call('GET', `${tix(ID.wsF)}?status=bogus`, T.orgOwner)).status, 400);
});

// ===================== Ref 58 — ticket_category (proactive/reactive/emergency) =====================

test('create can explicitly set ticket_category to emergency', async () => {
  const r = await call('POST', tix(ID.wsA), T.editor, { title: 'fire alarm tripped', ticket_category: 'emergency' });
  assert.equal(r.status, 201);
  const t = await r.json();
  assert.equal(t.ticket_category, 'emergency');
});

test('PATCH can escalate an existing ticket to emergency and back', async () => {
  const t = await (await call('POST', tix(ID.wsA), T.editor, { title: 'category patch me' })).json();
  assert.equal(t.ticket_category, 'reactive');
  const url = `${tix(ID.wsA)}/${t.id}`;

  let u = await (await call('PATCH', url, T.editor, { ticket_category: 'emergency' })).json();
  assert.equal(u.ticket_category, 'emergency');

  u = await (await call('PATCH', url, T.editor, { ticket_category: 'reactive' })).json();
  assert.equal(u.ticket_category, 'reactive');

  assert.equal((await call('PATCH', url, T.editor, { ticket_category: 'bogus' })).status, 400);
});

test('GET list: filters by ticket_category', async () => {
  await app.db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run(ID.wsCat, ID.orgA, `${P} WS Cat`);
  await app.db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_editor')").run(ID.wsCat, U.editor);
  const mk = (body) => call('POST', tix(ID.wsCat), T.editor, body);
  await mk({ title: 'r1' });
  await mk({ title: 'e1', ticket_category: 'emergency' });
  await mk({ title: 'p1', ticket_category: 'proactive' });

  const emergency = await (await call('GET', `${tix(ID.wsCat)}?ticket_category=emergency`, T.editor)).json();
  assert.deepEqual(emergency.map((t) => t.title), ['e1']);

  const reactive = await (await call('GET', `${tix(ID.wsCat)}?ticket_category=reactive`, T.editor)).json();
  assert.deepEqual(reactive.map((t) => t.title), ['r1']);

  assert.equal((await call('GET', `${tix(ID.wsCat)}?ticket_category=bogus`, T.editor)).status, 400);
});

// ===================== Phase 4 Stage C — response-time SLA =====================

const H = 3600;
const now = () => Math.floor(Date.now() / 1000);
// create a ticket in ws-sla and back-date it `ageH` hours; returns the id
async function seedAged(priority, ageH, status = 'open') {
  const t = await (await call('POST', tix(ID.wsSla), T.editor, { title: `${priority} @${ageH}h`, priority })).json();
  await app.db.prepare('UPDATE tickets SET created_at = ? WHERE id = ?').run(now() - Math.round(ageH * H), t.id);
  if (status !== 'open') await app.db.prepare('UPDATE tickets SET status = ? WHERE id = ?').run(status, t.id);
  return t.id;
}

test('list carries response_status / sla_due_at / sla_target_hours per ticket', async () => {
  const tid = await seedAged('high', 1); // 1h old, 4h target -> 3h left > 2h -> within_sla
  const rows = await (await call('GET', tix(ID.wsSla), T.viewer)).json();
  const t = rows.find((x) => x.id === tid);
  assert.equal(t.response_status, 'within_sla');
  assert.equal(t.sla_target_hours, 4);
  assert.equal(t.sla_due_at, t.created_at + 4 * H);
});

test('boundary: exactly at target -> breached; exactly at 50%-of-target remaining -> due_today; just inside -> within_sla', async () => {
  const atLine = await seedAged('high', 4);      // exactly 4h old -> breached
  const atHalf = await seedAged('high', 2);      // exactly 2h left (50% of 4h) -> due_today
  const justInside = await seedAged('high', 1.99); // just over 2h left -> within_sla
  const lowHalf = await seedAged('low', 36);     // exactly 36h left (50% of 72h) -> due_today
  const rows = await (await call('GET', tix(ID.wsSla), T.viewer)).json();
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(byId[atLine].response_status, 'breached', 'age == target -> breached');
  assert.equal(byId[atHalf].response_status, 'due_today', 'exactly 50% of budget left -> due_today');
  assert.equal(byId[justInside].response_status, 'within_sla', 'just over 50% left -> within_sla');
  assert.equal(byId[lowHalf].response_status, 'due_today', 'low ticket at its own 36h boundary -> due_today');
});

test('resolved / closed tickets: response_status null in the list, excluded from the summary', async () => {
  const res = await seedAged('high', 99, 'resolved');
  const clo = await seedAged('high', 99, 'closed');
  const rows = await (await call('GET', tix(ID.wsSla), T.viewer)).json();
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(byId[res].response_status, null);
  assert.equal(byId[clo].response_status, null);
  // sla_due_at is still a fact about the ticket
  assert.equal(typeof byId[res].sla_due_at, 'number');

  const s = await (await call('GET', `${tix(ID.wsSla)}/sla-summary`, T.viewer)).json();
  // the resolved + closed tickets contribute to none of the buckets
  assert.equal(s.counts.breached + s.counts.due_today + s.counts.within_sla, s.total_open);
});

test('sla-summary: hand-checked counts over a known spread', async () => {
  // fresh workspace so the spread is the whole population
  await app.db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run(ID.wsSum, ID.orgA, `${P} WS Sum`);
  await app.db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_editor')").run(ID.wsSum, U.editor);
  const mk = async (priority, ageH, status = 'open') => {
    const t = await (await call('POST', tix(ID.wsSum), T.editor, { title: `${priority}@${ageH}`, priority })).json();
    await app.db.prepare('UPDATE tickets SET created_at = ? WHERE id = ?').run(now() - Math.round(ageH * H), t.id);
    if (status !== 'open') await app.db.prepare('UPDATE tickets SET status = ? WHERE id = ?').run(status, t.id);
  };
  await mk('high', 6);            // breached (6h > 4h)
  await mk('medium', 30);         // breached (30h > 24h)
  await mk('high', 3);            // due_today (1h left <= 2h)
  await mk('medium', 18);         // due_today (6h left <= 12h)
  await mk('low', 50);            // due_today (22h left <= 36h)
  await mk('low', 10);            // within_sla (62h left > 36h)
  await mk('high', 0.5);          // within_sla (3.5h left > 2h)
  await mk('high', 100, 'resolved'); // excluded
  await mk('medium', 100, 'closed'); // excluded

  const r = await call('GET', `${tix(ID.wsSum)}/sla-summary`, T.editor);
  assert.equal(r.status, 200);
  const s = await r.json();
  assert.equal(s.workspace_id, ID.wsSum);
  assert.deepEqual(s.targets, { high: 4, medium: 24, low: 72 });
  assert.deepEqual(s.counts, { breached: 2, due_today: 3, within_sla: 2 });
  assert.equal(s.total_open, 7);
});

test('sla-summary RBAC: viewer can read, non-member 403, unknown workspace 404', async () => {
  assert.equal((await call('GET', `${tix(ID.wsSla)}/sla-summary`, T.viewer)).status, 200);
  assert.equal((await call('GET', `${tix(ID.wsSla)}/sla-summary`, T.other)).status, 403);
  assert.equal((await call('GET', `${tix(ID.wsSla)}/sla-summary`, T.nobody)).status, 403);
  assert.equal((await call('GET', `${tix(id('ws-nope'))}/sla-summary`, T.plat)).status, 404);
});

// ===================== Step 5 Stage B — outage root-cause on tickets ==========

test('likely_cause is joined from outage_history onto an auto-created ticket', async () => {
  const outageStart = 1_700_000_000;
  await app.db.prepare(
    "INSERT INTO outage_history (device_id, workspace_id, started_at, ended_at, duration_seconds, likely_cause) VALUES (?, ?, ?, ?, 900, 'weak_wifi')",
  ).run(ID.devA1, ID.wsA, outageStart, outageStart + 900);
  const tkId = id('tk-auto-1');
  await app.db.prepare(
    "INSERT INTO tickets (id, workspace_id, device_id, title, status, priority, auto_source, source_outage_start) VALUES (?, ?, ?, 'SLA breach: Lobby A offline 3h', 'open', 'high', 'sla_breach', ?)",
  ).run(tkId, ID.wsA, ID.devA1, outageStart);

  const single = await (await call('GET', `${tix(ID.wsA)}/${tkId}`, T.viewer)).json();
  assert.equal(single.likely_cause, 'weak_wifi');
  assert.equal(single.auto_source, 'sla_breach');

  const inList = (await (await call('GET', tix(ID.wsA), T.viewer)).json()).find((t) => t.id === tkId);
  assert.equal(inList.likely_cause, 'weak_wifi');
});

test('likely_cause is null for a manually-created ticket (no source_outage_start)', async () => {
  const t = await (await call('POST', tix(ID.wsA), T.editor, { title: 'manual one', device_id: ID.devA1 })).json();
  assert.equal(t.likely_cause ?? null, null, 'POST response');
  const single = await (await call('GET', `${tix(ID.wsA)}/${t.id}`, T.viewer)).json();
  assert.equal(single.likely_cause ?? null, null);
});

test('an auto-ticket whose outage has likely_cause=unknown passes it through verbatim (frontend hides it, backend does not lie)', async () => {
  const s = 1_700_100_000;
  await app.db.prepare(
    "INSERT INTO outage_history (device_id, workspace_id, started_at, ended_at, duration_seconds, likely_cause) VALUES (?, ?, ?, ?, 600, 'unknown')",
  ).run(ID.devA1, ID.wsA, s, s + 600);
  await app.db.prepare(
    "INSERT INTO tickets (id, workspace_id, device_id, title, status, priority, auto_source, source_outage_start) VALUES (?, ?, ?, 'x', 'open', 'high', 'sla_breach', ?)",
  ).run(id('tk-auto-2'), ID.wsA, ID.devA1, s);
  const single = await (await call('GET', `${tix(ID.wsA)}/${id('tk-auto-2')}`, T.viewer)).json();
  assert.equal(single.likely_cause, 'unknown');
});

test('an auto-ticket whose outage predates Step 5A (likely_cause NULL) -> null, no join error', async () => {
  const s = 1_700_200_000;
  await app.db.prepare(
    "INSERT INTO outage_history (device_id, workspace_id, started_at, ended_at, duration_seconds, likely_cause) VALUES (?, ?, ?, ?, 600, NULL)",
  ).run(ID.devA1, ID.wsA, s, s + 600);
  await app.db.prepare(
    "INSERT INTO tickets (id, workspace_id, device_id, title, status, priority, auto_source, source_outage_start) VALUES (?, ?, ?, 'y', 'open', 'high', 'sla_breach', ?)",
  ).run(id('tk-auto-3'), ID.wsA, ID.devA1, s);
  const single = await (await call('GET', `${tix(ID.wsA)}/${id('tk-auto-3')}`, T.viewer)).json();
  assert.equal(single.likely_cause ?? null, null);
});
