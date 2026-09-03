'use strict';

// Phase 5 Stage A — a campaign's status is derived on read from its date range
// vs. the current day, never stored (see schema.sql campaigns note). Same
// rationale as tickets' response_status: a pure function of the dates + today,
// so a stored column would need a nightly flip job and would drift on a miss.
//
//   draft     today <  start_date
//   live      start_date <= today <= end_date
//   completed today >  end_date
//
// start_date / end_date are 'YYYY-MM-DD' strings; ISO dates compare correctly
// as plain strings, so no Date parsing is needed.

function todayStr(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function campaignStatus(campaign, today = todayStr()) {
  if (today < campaign.start_date) return 'draft';
  if (today > campaign.end_date) return 'completed';
  return 'live';
}

// A campaign row is done (past its window) — handy for callers that only care
// about active/upcoming work.
function isCampaignActive(campaign, today = todayStr()) {
  return campaignStatus(campaign, today) !== 'completed';
}

module.exports = { todayStr, campaignStatus, isCampaignActive };
