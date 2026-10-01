import { MON } from "./format";

// Shared campaign vocabulary. Used by the Campaigns page (full table) and the
// Overview "Campaigns" teaser so the status labels and the delivery-pace colour
// stay defined in exactly one place.

export const CAMPAIGN_STATUS = {
  draft: { label: "Draft", color: "var(--ink3)" },
  live: { label: "Live", color: "var(--ok)" },
  completed: { label: "Completed", color: "var(--ink2)" },
};

// grey when there's no target to measure against; green on/over pace; red when
// significantly behind. (delivery_days_elapsed counts the current partial day as
// whole, so an on-pace campaign reads a little under 100 mid-day — hence the
// green cutoff at 90, not 100.)
export function deliveryColor(pct) {
  if (pct == null) return "var(--ink3)";
  return pct >= 90 ? "var(--ok)" : "var(--bad)";
}

// --- Date helpers for the Campaigns charts. Campaign dates are 'YYYY-MM-DD'
// and the server derives status from the UTC date (server/lib/campaign-status
// todayStr), so these work in UTC too and agree with it.

// Fractional days since the epoch (UTC). For a date string it is that day's
// midnight; with no argument it is "now", including the time of day.
export function dayNum(dateStr) {
  return (dateStr ? Date.parse(`${dateStr}T00:00:00Z`) : Date.now()) / 86400000;
}

export function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// "24 Sep"
export function fmtDay(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
}

// Calendar days in the campaign, both ends inclusive.
export function campaignLength(c) {
  return Math.round(dayNum(c.end_date) - dayNum(c.start_date)) + 1;
}

// Share of the campaign's run that has passed, 0..1 (by the clock, so a live
// campaign moves through the day rather than jumping at midnight).
export function timeElapsed(c) {
  const frac = (dayNum() - dayNum(c.start_date)) / campaignLength(c);
  return Math.max(0, Math.min(1, frac));
}

// Page-level roll-up for the KPI row. Delivery is only meaningful where the
// API returned a plan (expected_plays > 0 - needs a daily target and a
// playlist), so deliveredPct sums plays over exactly those campaigns.
export function summarizeCampaigns(list) {
  const out = { total: list.length, live: 0, draft: 0, completed: 0, behind: 0, liveWithTarget: 0, totalPlays: 0 };
  let planned = 0;
  let deliveredAgainstPlan = 0;
  for (const c of list) {
    if (c.status in out) out[c.status] += 1;
    if (c.actual_plays != null) out.totalPlays += c.actual_plays;
    if (c.expected_plays > 0 && c.actual_plays != null) {
      planned += c.expected_plays;
      deliveredAgainstPlan += c.actual_plays;
    }
    if (c.status === "live" && c.delivery_pct != null) {
      out.liveWithTarget += 1;
      if (c.delivery_pct < 90) out.behind += 1;
    }
  }
  out.planned = planned;
  out.deliveredAgainstPlan = deliveredAgainstPlan;
  out.deliveredPct = planned > 0 ? Math.round((deliveredAgainstPlan / planned) * 1000) / 10 : null;
  return out;
}
