'use strict';

// Phase 5 Stage B — campaign delivery tracking (lib/campaign-delivery.js).
// In-memory sqlite for the play_logs count; the rest is pure arithmetic.

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { playlistContentIds, computeCampaignDelivery, daysInclusive } = require('../lib/campaign-delivery');

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE devices (id TEXT PRIMARY KEY, workspace_id TEXT);
  CREATE TABLE play_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT, content_id TEXT, started_at INTEGER NOT NULL);
`);
db.prepare("INSERT INTO devices (id, workspace_id) VALUES ('dev-ws1', 'ws-1')").run();
db.prepare("INSERT INTO devices (id, workspace_id) VALUES ('dev-ws2', 'ws-2')").run(); // a DIFFERENT workspace
const epoch = (s) => Math.floor(Date.parse(s) / 1000);
// default device is in ws-1 (the campaign's workspace); pass `device` to override.
const addPlay = (contentId, iso, device = 'dev-ws1') =>
  db.prepare('INSERT INTO play_logs (device_id, content_id, started_at) VALUES (?, ?, ?)').run(device, contentId, epoch(iso));

// A published_snapshot: array of items, content_id null on widget items.
const SNAP = JSON.stringify([
  { content_id: 'con-A', widget_id: null, sort_order: 0, filename: 'a.mp4' },
  { content_id: 'con-B', widget_id: null, sort_order: 1, filename: 'b.mp4' },
  { content_id: null, widget_id: 'wid-1', sort_order: 2 }, // widget item - skipped
  { content_id: 'con-A', widget_id: null, sort_order: 3 }, // dup content - deduped
]);

test('playlistContentIds: pulls non-null content_id, de-dupes, skips widgets', () => {
  assert.deepEqual(playlistContentIds(SNAP).sort(), ['con-A', 'con-B']);
});

test('playlistContentIds: null / empty / corrupt / non-array -> []', () => {
  assert.deepEqual(playlistContentIds(null), []);
  assert.deepEqual(playlistContentIds(''), []);
  assert.deepEqual(playlistContentIds('not json'), []);
  assert.deepEqual(playlistContentIds('{"a":1}'), []);
  assert.deepEqual(playlistContentIds('[]'), []);
  assert.deepEqual(playlistContentIds(JSON.stringify([{ widget_id: 'w', content_id: null }])), []);
});

test('daysInclusive counts both ends', () => {
  assert.equal(daysInclusive('2026-06-01', '2026-06-01'), 1);
  assert.equal(daysInclusive('2026-06-01', '2026-06-03'), 3);
  assert.equal(daysInclusive('2026-06-01', '2026-06-30'), 30);
});

// ---- seed a realistic scenario ------------------------------------------
// Campaign: con-A/con-B, 2026-06-01 .. 2026-06-10, target 10/day.
// "today" = 2026-06-05 (day 5 -> 5 days elapsed).
//   in-window matching plays: 6-01 x2, 6-02 x1, 6-03 x3, 6-05 x1  = 7
//   NOT counted: con-C (wrong content), 6-06 (after today), 5-31 (before start)
addPlay('con-A', '2026-06-01T09:00:00Z');
addPlay('con-B', '2026-06-01T18:00:00Z');
addPlay('con-A', '2026-06-02T10:00:00Z');
addPlay('con-A', '2026-06-03T08:00:00Z');
addPlay('con-B', '2026-06-03T12:00:00Z');
addPlay('con-A', '2026-06-03T20:00:00Z');
addPlay('con-A', '2026-06-05T11:00:00Z');
addPlay('con-C', '2026-06-03T10:00:00Z'); // different content
addPlay('con-A', '2026-06-06T10:00:00Z'); // after "today"
addPlay('con-A', '2026-05-31T23:00:00Z'); // before start

const camp = (over = {}) => ({
  workspace_id: 'ws-1', playlist_id: 'pl-1', start_date: '2026-06-01', end_date: '2026-06-10', target_plays_per_day: 10, ...over,
});

test('mid-flight: actual=7, days_elapsed=5, expected=50, delivery_pct=14.0', async () => {
  const d = await computeCampaignDelivery(db, camp(), SNAP, '2026-06-05');
  assert.equal(d.actual_plays, 7);
  assert.equal(d.delivery_days_elapsed, 5);
  assert.equal(d.expected_plays, 50);
  assert.equal(d.delivery_pct, 14.0);
});

test('workspace scope: a play of the SAME content on a device in ANOTHER workspace is NOT counted', async () => {
  // matching content, in-window, but device dev-ws2 belongs to ws-2
  addPlay('con-A', '2026-06-02T11:00:00Z', 'dev-ws2');
  addPlay('con-B', '2026-06-04T11:00:00Z', 'dev-ws2');
  // ws-1 campaign is unchanged - still 7
  assert.equal((await computeCampaignDelivery(db, camp(), SNAP, '2026-06-05')).actual_plays, 7);
  // the same campaign scoped to ws-2 would see exactly those 2
  assert.equal((await computeCampaignDelivery(db, camp({ workspace_id: 'ws-2' }), SNAP, '2026-06-05')).actual_plays, 2);
  // a play on a device that doesn't exist / has no workspace is also not counted
  addPlay('con-A', '2026-06-02T12:00:00Z', 'dev-ghost');
  assert.equal((await computeCampaignDelivery(db, camp(), SNAP, '2026-06-05')).actual_plays, 7);
  // clean up the extra rows so the later tests' counts stay as written
  db.prepare("DELETE FROM play_logs WHERE device_id IN ('dev-ws2', 'dev-ghost')").run();
});

test('completed campaign: window is the full range, plays after end_date excluded', async () => {
  // today past end_date -> window end = 2026-06-10; the 6-06 play now counts (8 total)
  const d = await computeCampaignDelivery(db, camp(), SNAP, '2026-07-01');
  assert.equal(d.actual_plays, 8);
  assert.equal(d.delivery_days_elapsed, 10);
  assert.equal(d.expected_plays, 100);
  assert.equal(d.delivery_pct, 8.0);
});

test('not started yet: everything zero, delivery_pct null (0 expected)', async () => {
  const d = await computeCampaignDelivery(db, camp(), SNAP, '2026-05-15');
  assert.equal(d.actual_plays, 0);
  assert.equal(d.delivery_days_elapsed, 0);
  assert.equal(d.expected_plays, 0);
  assert.equal(d.delivery_pct, null);
});

test('over-delivery shows as >100% (not capped)', async () => {
  const d = await computeCampaignDelivery(db, camp({ target_plays_per_day: 1 }), SNAP, '2026-06-05');
  // actual 7 / expected (1 * 5) = 5 -> 140%
  assert.equal(d.expected_plays, 5);
  assert.equal(d.delivery_pct, 140.0);
});

test('null target: actual_plays still computed, expected_plays + delivery_pct null', async () => {
  const d = await computeCampaignDelivery(db, camp({ target_plays_per_day: null }), SNAP, '2026-06-05');
  assert.equal(d.actual_plays, 7);
  assert.equal(d.expected_plays, null);
  assert.equal(d.delivery_pct, null);
  assert.equal(d.delivery_days_elapsed, 5);
});

test('null playlist: every delivery field null (not zero)', async () => {
  const d = await computeCampaignDelivery(db, camp({ playlist_id: null }), null, '2026-06-05');
  assert.deepEqual(d, { actual_plays: null, expected_plays: null, delivery_pct: null, delivery_days_elapsed: null });
});

test('playlist set but no published_snapshot (draft): actual_plays 0, not null', async () => {
  const d = await computeCampaignDelivery(db, camp(), null, '2026-06-05');
  assert.equal(d.actual_plays, 0);
  assert.equal(d.expected_plays, 50);
  assert.equal(d.delivery_pct, 0);
});

test('single-day campaign', async () => {
  addPlay('con-A', '2026-08-01T10:00:00Z');
  addPlay('con-A', '2026-08-01T14:00:00Z');
  const d = await computeCampaignDelivery(
    db, camp({ start_date: '2026-08-01', end_date: '2026-08-01', target_plays_per_day: 5 }), SNAP, '2026-08-01',
  );
  assert.equal(d.actual_plays, 2);
  assert.equal(d.delivery_days_elapsed, 1);
  assert.equal(d.expected_plays, 5);
  assert.equal(d.delivery_pct, 40.0);
});

test.after(() => db.close());
