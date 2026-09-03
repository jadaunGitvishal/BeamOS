'use strict';

// Phase 5 Stage B — campaign delivery tracking, computed on read (never stored,
// same rationale as campaignStatus / ticket response_status).
//
// A campaign wraps ONE playlist. The content that playlist actually delivers is
// the set of content_id values in its published_snapshot - the JSON array that
// ws/deviceSocket.js buildPlaylistPayload parses and hands to devices. Each
// element looks like { content_id, widget_id, zone_id, sort_order, duration_sec,
// muted, filename, ... }; widget-only items have content_id === null and are
// skipped. A draft playlist has published_snapshot === null (nothing is live) ->
// empty content set.
//
//   actual_plays          COUNT(play_logs) where content_id is in that set,
//                         started_at is within [start_date 00:00, windowEnd 23:59]
//                         (windowEnd = min(today, end_date)), AND the play
//                         happened on a device in the campaign's OWN workspace.
//                         The workspace scope matters: shared/template content
//                         (content.workspace_id IS NULL) can be reused across
//                         unrelated workspaces, so an unscoped content_id match
//                         would credit another tenant's plays to this campaign.
//   expected_plays        target_plays_per_day * delivery_days_elapsed, or null
//                         when target_plays_per_day is not set.
//   delivery_days_elapsed calendar days from start_date through windowEnd,
//                         inclusive of both ends (so the current, partial day
//                         counts - actual_plays already includes today's plays,
//                         so expected is measured over the same span). 0 before
//                         the campaign starts.
//   delivery_pct          actual_plays / expected_plays * 100, 1 dp, NOT capped
//                         (over-delivery is real signal - a campaign at 140% is
//                         playing more than planned and an operator wants to see
//                         that, not have it clamped to look "on target"). null
//                         when expected_plays is 0 or null.
//
// playlist_id === null -> every field is null (not 0): no playlist means no
// delivery data is possible, which is different from "delivered nothing".

const { todayStr } = require('./campaign-status');

// content_id of every item in a published_snapshot string. null/empty/corrupt
// snapshot, or an all-widget playlist -> []. De-duplicated.
function playlistContentIds(publishedSnapshot) {
  if (!publishedSnapshot) return [];
  let arr;
  try {
    arr = JSON.parse(publishedSnapshot);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  return [...new Set(arr.map((i) => i && i.content_id).filter(Boolean))];
}

const dayStartEpoch = (dateStr) => Math.floor(Date.parse(dateStr + 'T00:00:00Z') / 1000);
const dayEndEpoch = (dateStr) => Math.floor(Date.parse(dateStr + 'T23:59:59Z') / 1000);

// Inclusive calendar-day span between two YYYY-MM-DD strings (from <= to).
function daysInclusive(fromStr, toStr) {
  const ms = Date.parse(toStr + 'T00:00:00Z') - Date.parse(fromStr + 'T00:00:00Z');
  return Math.round(ms / 86400000) + 1;
}

// dbh:               db handle ({ prepare })
// campaign:          row with start_date, end_date, playlist_id, target_plays_per_day
// publishedSnapshot: the playlist's published_snapshot string, or null
// Returns { actual_plays, expected_plays, delivery_pct, delivery_days_elapsed }.
async function computeCampaignDelivery(dbh, campaign, publishedSnapshot, today = todayStr()) {
  if (campaign.playlist_id == null) {
    return { actual_plays: null, expected_plays: null, delivery_pct: null, delivery_days_elapsed: null };
  }

  const started = today >= campaign.start_date;
  const windowEndDate = today < campaign.end_date ? today : campaign.end_date;
  const daysElapsed = started ? daysInclusive(campaign.start_date, windowEndDate) : 0;

  let actual = 0;
  const ids = playlistContentIds(publishedSnapshot);
  if (started && ids.length) {
    const ph = ids.map(() => '?').join(',');
    const row = await dbh
      .prepare(
        `SELECT COUNT(*) AS c FROM play_logs pl
           JOIN devices d ON d.id = pl.device_id AND d.workspace_id = ?
          WHERE pl.content_id IN (${ph}) AND pl.started_at >= ? AND pl.started_at <= ?`,
      )
      .get(campaign.workspace_id, ...ids, dayStartEpoch(campaign.start_date), dayEndEpoch(windowEndDate));
    actual = row.c;
  }

  if (campaign.target_plays_per_day == null) {
    return { actual_plays: actual, expected_plays: null, delivery_pct: null, delivery_days_elapsed: daysElapsed };
  }
  const expected = campaign.target_plays_per_day * daysElapsed;
  const pct = expected > 0 ? Math.round((actual / expected) * 1000) / 10 : null;
  return { actual_plays: actual, expected_plays: expected, delivery_pct: pct, delivery_days_elapsed: daysElapsed };
}

module.exports = { playlistContentIds, computeCampaignDelivery, daysInclusive };
