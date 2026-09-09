'use strict';

// ============================================================================
//  Ref 17 — tamper-evident hash chaining for activity_log.
//
//  Every audit row carries:
//    - entry_hash: SHA-256 over the row's core, meant-to-be-permanent content
//    - prev_hash:  the immediately-preceding row's entry_hash
//  so any later edit, deletion, or reordering of a row breaks the chain from
//  that point forward and the verifier (verifyChain / GET /api/activity/
//  verify-integrity) pinpoints where.
//
//  ---- EXACTLY what feeds entry_hash --------------------------------------
//  computeEntryHash hashes a JSON array of, IN THIS ORDER:
//
//      [ prev_hash, user_id, action, details, ip_address, created_at ]
//
//  A JSON array is used so field boundaries are unambiguous and null is
//  distinct from the empty string.
//
//  Included:
//    prev_hash    - chains this entry to all history before it
//    user_id      - who
//    action       - what
//    details      - specifics (email attempted, resource name, refusal reason…)
//    ip_address   - from where
//    created_at   - when (UNIX seconds; appendEntry sets it explicitly so the
//                   stored value and the hashed value always agree)
//
//  Deliberately EXCLUDED:
//    workspace_id, organization_id
//        Legitimately set to NULL by ON DELETE SET NULL when a workspace or org
//        is deleted. Hashing them would turn a lawful account-deletion cascade
//        into a false "tampering" signal. They still ride on the row, just
//        outside the integrity envelope.
//    id
//        Assigned by AUTO_INCREMENT only after the row is built. Row ORDER is
//        already pinned by the prev_hash linkage (and created_at).
//    device_id, acting_user_id, was_acting_as
//        Not part of Ref 17's "core permanent fields" list. They are stored but
//        not covered by the hash.
//
//  ---- Concurrency (the correctness-critical part) -----------------------
//  appendEntry() runs lock + read-head + insert + advance-head inside ONE
//  transaction. The first statement is an UPDATE of the single activity_log_chain
//  row (id=1) - which takes an exclusive lock on that row (InnoDB locks the row
//  an UPDATE matches whether or not a value changes). A second concurrent append
//  blocks on that lock until the first commits, and only then reads last_hash -
//  by which point it is the first append's freshly-written hash. Two entries
//  therefore can NEVER chain from the same predecessor, so the chain cannot fork
//  under concurrent logActivity(). (An explicit `SELECT ... FOR UPDATE` would do
//  the same on MySQL, but the lock-via-UPDATE form is also valid SQLite, which
//  the unit tests run on.)
//
//  ---- Known limitation --------------------------------------------------
//  Deleting the CURRENT newest row(s) (tail truncation) leaves no successor to
//  notice the missing link. activity_log_chain.last_hash still points past the
//  deleted rows, so verifyChain() flags a head mismatch — but it cannot say
//  which rows were removed, only that some were. Middle deletions are pinpointed.
// ============================================================================

const crypto = require('crypto');

// The prev_hash of the very first row ever. Fixed and permanent.
const GENESIS_PREV_HASH = '0'.repeat(64);

function computeEntryHash({ prev_hash, user_id, action, details, ip_address, created_at }) {
  const payload = JSON.stringify([
    prev_hash,
    user_id ?? null,
    action ?? null,
    details ?? null,
    ip_address ?? null,
    Number(created_at),
  ]);
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

const INSERT_SQL = `INSERT INTO activity_log
  (user_id, device_id, action, details, ip_address, workspace_id, organization_id,
   acting_user_id, was_acting_as, created_at, prev_hash, entry_hash)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

// Append one audit row, chained. Concurrency-safe (see the header). `db` is the
// wrapper from db/database.js. Returns { id, entry_hash, prev_hash }.
//
// Callers pass whatever subset of fields they have; the rest default to NULL.
// created_at defaults to "now" (UNIX seconds) and is what gets hashed.
async function appendEntry(db, fields = {}) {
  const {
    user_id = null,
    device_id = null,
    action,
    details = null,
    ip_address = null,
    workspace_id = null,
    organization_id = null,
    acting_user_id = null,
    was_acting_as = 0,
    created_at = Math.floor(Date.now() / 1000),
  } = fields;

  if (!action) throw new Error('appendEntry: action is required');

  // db.transaction(fn) returns a runner; invoke it (trailing ()) to actually run.
  return db.transaction(async (tx) => {
    // (1) Take the exclusive lock: an UPDATE of chain row 1 serializes every
    // concurrent append here (see the header). Doubles as the "chain last
    // touched" timestamp.
    const locked = await tx
      .prepare('UPDATE activity_log_chain SET updated_at = ? WHERE id = 1')
      .run(Math.floor(Date.now() / 1000));
    if (!locked.changes) {
      // Should never happen: schema.sql seeds row 1 and backfillChain() re-asserts
      // it at boot. Fail loudly rather than silently forking from genesis.
      throw new Error('activity_log_chain row 1 is missing — run backfillChain()');
    }

    // (2) Read the head. We hold the row lock, so this is the true current head
    // even if another append was racing us a moment ago.
    const head = await tx
      .prepare('SELECT last_hash, entry_count FROM activity_log_chain WHERE id = 1')
      .get();
    const prev_hash = head.last_hash;
    const entry_hash = computeEntryHash({ prev_hash, user_id, action, details, ip_address, created_at });

    const res = await tx.prepare(INSERT_SQL).run(
      user_id, device_id, action, details, ip_address, workspace_id, organization_id,
      acting_user_id, was_acting_as ? 1 : 0, created_at, prev_hash, entry_hash,
    );

    await tx
      .prepare('UPDATE activity_log_chain SET last_hash = ?, entry_count = entry_count + 1, updated_at = ? WHERE id = 1')
      .run(entry_hash, Math.floor(Date.now() / 1000));

    return { id: res.lastInsertRowid, entry_hash, prev_hash };
  })();
}

// Boot-time, runs BEFORE the server accepts requests (so no concurrent writes).
// Fills prev_hash/entry_hash for any rows that predate the columns, chaining them
// in id order from the last already-chained row (or genesis). ALREADY-hashed rows
// are the anchor and are NEVER rewritten — rewriting them would erase tamper
// evidence. Also re-asserts the activity_log_chain head row.
async function backfillChain(db) {
  await db.exec("INSERT IGNORE INTO activity_log_chain (id, last_hash, entry_count) VALUES (1, REPEAT('0', 64), 0)");

  const gap = await db.prepare('SELECT COUNT(*) AS n FROM activity_log WHERE entry_hash IS NULL').get();
  const unchained = gap ? Number(gap.n) : 0;

  if (unchained === 0) {
    // Nothing to migrate. Make sure the head row still points at the real last
    // chained row + count (covers "columns added, table already had 0 rows" and
    // a head row that drifted).
    const tail = await db
      .prepare('SELECT entry_hash FROM activity_log WHERE entry_hash IS NOT NULL ORDER BY id DESC LIMIT 1')
      .get();
    const total = await db.prepare('SELECT COUNT(*) AS n FROM activity_log WHERE entry_hash IS NOT NULL').get();
    await db
      .prepare('UPDATE activity_log_chain SET last_hash = ?, entry_count = ?, updated_at = ? WHERE id = 1')
      .run(tail ? tail.entry_hash : GENESIS_PREV_HASH, total ? Number(total.n) : 0, Math.floor(Date.now() / 1000));
    return { backfilled: 0 };
  }

  const anchor = await db
    .prepare('SELECT id, entry_hash FROM activity_log WHERE entry_hash IS NOT NULL ORDER BY id DESC LIMIT 1')
    .get();
  let prev = anchor ? anchor.entry_hash : GENESIS_PREV_HASH;
  let lastId = anchor ? Number(anchor.id) : 0;
  let chainedCount = await db.prepare('SELECT COUNT(*) AS n FROM activity_log WHERE entry_hash IS NOT NULL').get();
  chainedCount = chainedCount ? Number(chainedCount.n) : 0;

  const upd = db.prepare('UPDATE activity_log SET prev_hash = ?, entry_hash = ? WHERE id = ?');
  const BATCH = 500;
  let filled = 0;
  for (;;) {
    const rows = await db
      .prepare(
        'SELECT id, user_id, action, details, ip_address, created_at FROM activity_log WHERE id > ? AND entry_hash IS NULL ORDER BY id ASC LIMIT ?',
      )
      .all(lastId, BATCH);
    if (!rows.length) break;
    for (const r of rows) {
      const entry_hash = computeEntryHash({
        prev_hash: prev,
        user_id: r.user_id,
        action: r.action,
        details: r.details,
        ip_address: r.ip_address,
        created_at: r.created_at,
      });
      await upd.run(prev, entry_hash, r.id);
      prev = entry_hash;
      lastId = Number(r.id);
      filled++;
    }
  }

  await db
    .prepare('UPDATE activity_log_chain SET last_hash = ?, entry_count = ?, updated_at = ? WHERE id = 1')
    .run(prev, chainedCount + filled, Math.floor(Date.now() / 1000));

  console.log(`[activity-chain] backfilled ${filled} pre-existing activity_log row(s) into the hash chain`);
  return { backfilled: filled };
}

// Walk the chain (optionally a [startId, endId] id range) and check, for every
// entry:
//   1. entry_hash == a fresh recomputation of its stored content  -> content intact
//   2. prev_hash  == the ACTUAL preceding row's entry_hash        -> nothing deleted/reordered before it
// Plus, for a full-chain check, that the newest row matches activity_log_chain
// (catches tail truncation) and that the row count matches.
//
// Returns:
//   { ok, checked, range:{start_id,end_id}, chain_head:{...}, failures:[ {id, type, detail} ] }
// failure types: 'unchained' | 'content_altered' | 'broken_link' | 'head_mismatch' | 'count_mismatch'
async function verifyChain(db, opts = {}) {
  const startId = opts.startId != null ? Number(opts.startId) : null;
  const endId = opts.endId != null ? Number(opts.endId) : null;
  const fullChain = startId == null && endId == null;

  // Anchor: the entry_hash the first in-range row's prev_hash must equal.
  let expectedPrev = GENESIS_PREV_HASH;
  let firstRowId = null;
  if (startId != null) {
    const before = await db
      .prepare('SELECT id, entry_hash FROM activity_log WHERE id < ? ORDER BY id DESC LIMIT 1')
      .get(startId);
    if (before) expectedPrev = before.entry_hash; // genesis stays if nothing precedes the range
  }

  const failures = [];
  let checked = 0;
  let lastSeen = null; // { id, entry_hash }
  let cursor = startId != null ? startId - 1 : 0;
  const BATCH = 1000;

  for (;;) {
    let sql = 'SELECT id, user_id, action, details, ip_address, created_at, prev_hash, entry_hash FROM activity_log WHERE id > ?';
    const params = [cursor];
    if (endId != null) { sql += ' AND id <= ?'; params.push(endId); }
    sql += ' ORDER BY id ASC LIMIT ?';
    params.push(BATCH);
    const rows = await db.prepare(sql).all(...params);
    if (!rows.length) break;

    for (const r of rows) {
      if (firstRowId == null) firstRowId = r.id;
      checked++;
      cursor = Number(r.id);

      if (r.entry_hash == null || r.prev_hash == null) {
        failures.push({ id: Number(r.id), type: 'unchained', detail: 'row has no prev_hash/entry_hash (never chained, or columns cleared)' });
        // Still advance the anchor as best we can so we don't cascade-fail every
        // following row off one hole.
        expectedPrev = r.entry_hash ?? expectedPrev;
        lastSeen = { id: Number(r.id), entry_hash: r.entry_hash };
        continue;
      }

      // (2) link check — does this row point at the actual previous row?
      if (r.prev_hash !== expectedPrev) {
        failures.push({
          id: Number(r.id),
          type: 'broken_link',
          detail: `prev_hash ${short(r.prev_hash)} does not match the preceding entry's hash ${short(expectedPrev)} — an earlier entry was deleted, reordered, or this link was altered`,
        });
      }

      // (1) content check — recompute from stored content + stored prev_hash.
      const recomputed = computeEntryHash({
        prev_hash: r.prev_hash,
        user_id: r.user_id,
        action: r.action,
        details: r.details,
        ip_address: r.ip_address,
        created_at: r.created_at,
      });
      if (recomputed !== r.entry_hash) {
        failures.push({
          id: Number(r.id),
          type: 'content_altered',
          detail: `stored entry_hash ${short(r.entry_hash)} != hash of current content ${short(recomputed)} — user_id/action/details/ip_address/created_at was modified`,
        });
      }

      expectedPrev = r.entry_hash;
      lastSeen = { id: Number(r.id), entry_hash: r.entry_hash };
    }
  }

  const result = {
    ok: failures.length === 0,
    checked,
    range: { start_id: firstRowId, end_id: lastSeen ? lastSeen.id : null },
    failures,
  };

  if (fullChain) {
    const head = await db.prepare('SELECT last_hash, entry_count FROM activity_log_chain WHERE id = 1').get();
    const total = await db.prepare('SELECT COUNT(*) AS n FROM activity_log').get();
    const actualCount = total ? Number(total.n) : 0;
    const actualHead = lastSeen ? lastSeen.entry_hash : GENESIS_PREV_HASH;
    const headMatches = !!head && head.last_hash === actualHead;
    const countMatches = !!head && Number(head.entry_count) === actualCount;
    result.chain_head = {
      stored: head ? head.last_hash : null,
      actual: actualHead,
      matches: headMatches,
      stored_count: head ? Number(head.entry_count) : null,
      actual_count: actualCount,
      count_matches: countMatches,
    };
    if (!headMatches) {
      result.ok = false;
      result.failures.push({ id: lastSeen ? lastSeen.id : null, type: 'head_mismatch', detail: 'newest row does not match activity_log_chain.last_hash — the most recent entries may have been truncated' });
    }
    if (!countMatches) {
      result.ok = false;
      result.failures.push({ id: null, type: 'count_mismatch', detail: `activity_log has ${actualCount} rows but the chain expected ${head ? head.entry_count : '?'}` });
    }
  }

  return result;
}

function short(h) {
  return typeof h === 'string' ? h.slice(0, 12) + '…' : String(h);
}

module.exports = { GENESIS_PREV_HASH, computeEntryHash, appendEntry, backfillChain, verifyChain };
