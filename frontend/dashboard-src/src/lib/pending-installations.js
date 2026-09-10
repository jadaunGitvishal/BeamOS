// Shared vocabulary for the pending-installation surfaces — the Overview
// "Pending installations" teaser and the full Pending Installations view — so the
// phrasing of what "pending" vs "abandoned" means stays in one place
// (cf. lib/reconciliation.js, lib/regions.js, lib/campaigns.js).

// epoch seconds -> 'YYYY-MM-DD' (UTC), or "—" when absent
export function pendingDate(epochSeconds) {
  if (epochSeconds === null || epochSeconds === undefined) return "—";
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

// A "days until expiry" figure -> a short human label. Negative / zero (an
// already-expired code) reads as "expired".
export function expiryLabel(days) {
  if (days === null || days === undefined) return "no expiry";
  if (days <= 0) return "expired";
  return `${days} day${days === 1 ? "" : "s"}`;
}

export const PENDING_HINT = (grace) =>
  `A registration code was generated ${grace}+ days ago for an on-site install, but no device has been activated against it yet — the code is still valid, so there's time to chase it before it expires.`;

export const ABANDONED_HINT =
  "The registration code's 30-day window lapsed without a single device ever activating against it — a genuinely dropped install. Staff must regenerate a fresh code from the Screens list to try again.";
