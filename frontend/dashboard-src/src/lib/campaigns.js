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
