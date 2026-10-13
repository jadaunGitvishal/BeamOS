'use strict';

// Shared helper for tests that assert on activity_log rows.
//
// logActivity (and the central request audit) is fire-and-forget: the response is sent
// before its row is written. So a test that reads activity_log right after a request -
// or opens an "exactly N rows" window after one - depends on timing. Instead:
//
//   const sinceId = await maxAuditId(db);
//   ...the request(s)...
//   await waitForAuditRows(db, { sinceId, userId, actions: ['ticket_created'] });
//   ...assert as before...
//
// Works with both the real MySQL wrapper (async prepare().get/all) and a better-sqlite3
// mock (sync) - every call is awaited. No side effects at load. test/helpers/ is excluded
// from the runner's file list, so this is never run as a test itself.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Current MAX(id) of activity_log (0 when empty).
async function maxAuditId(db) {
  const row = await db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM activity_log').get();
  return Number(row.m);
}

// Polls activity_log rows with id > sinceId (optionally only userId's, and only the
// given exact actions) until every listed action is present AND, if `count` is given,
// at least `count` such rows exist. Returns those rows ({ id, user_id, action }, id
// order). On timeout throws, listing what was expected and what was found.
async function waitForAuditRows(db, { sinceId, userId, actions, count, timeoutMs = 5000, intervalMs = 50 } = {}) {
  if (!Number.isFinite(Number(sinceId))) throw new Error('waitForAuditRows: sinceId is required (use maxAuditId before the request)');
  if (!actions?.length && count == null) throw new Error('waitForAuditRows: give actions and/or count');
  let sql = 'SELECT id, user_id, action FROM activity_log WHERE id > ?';
  const params = [sinceId];
  if (userId != null) { sql += ' AND user_id = ?'; params.push(userId); }
  if (actions?.length) { sql += ` AND action IN (${actions.map(() => '?').join(', ')})`; params.push(...actions); }
  sql += ' ORDER BY id';

  const done = (rows) => (!actions?.length || actions.every((a) => rows.some((r) => r.action === a)))
    && (count == null || rows.length >= count);
  const deadline = Date.now() + timeoutMs;
  let rows = [];
  for (;;) {
    rows = await db.prepare(sql).all(...params);
    if (done(rows)) return rows;
    if (Date.now() >= deadline) break;
    await sleep(intervalMs);
  }
  const want = [
    actions?.length ? `actions ${JSON.stringify(actions)}` : null,
    count != null ? `at least ${count} row(s)` : null,
  ].filter(Boolean).join(' and ');
  const found = rows.map((r) => ({ id: Number(r.id), user_id: r.user_id, action: r.action }));
  throw new Error(`waitForAuditRows: timed out after ${timeoutMs}ms waiting for ${want} with id > ${sinceId}`
    + `${userId != null ? ` by user ${userId}` : ''}; found ${found.length}: ${JSON.stringify(found)}`);
}

module.exports = { waitForAuditRows, maxAuditId };
