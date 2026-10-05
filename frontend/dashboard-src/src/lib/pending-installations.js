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

// ── Pending Installations page charts + filter (pure, unit-tested in
// server/test/dashboard-pending-installations-view.test.mjs) ──────────────────

// The same "act soon" threshold the table highlights: a pending code with a
// known expiry 7 days or less away. Codes with no expiry are never "soon".
export const EXPIRING_SOON_DAYS = 7;
export function isExpiringSoon(code) {
  const d = code?.days_until_expiry;
  return d !== null && d !== undefined && Number.isFinite(Number(d)) && Number(d) <= EXPIRING_SOON_DAYS;
}

// Pending codes by days until expiry: ≤7d, 8–14d, 15d+. Codes with a NULL
// days_until_expiry (legacy rows with no expires_at) aren't bucketed; they're
// counted in `unknown` so the chart can say so.
export const EXPIRY_RANGES = [
  { label: "≤7d", hi: 7 },
  { label: "8–14d", hi: 14 },
  { label: "15d+", hi: Infinity },
];
export function expiryBuckets(pending) {
  const buckets = EXPIRY_RANGES.map((r) => ({ label: r.label, value: 0 }));
  let unknown = 0;
  for (const c of pending || []) {
    const d = c?.days_until_expiry;
    if (d === null || d === undefined || !Number.isFinite(Number(d))) {
      unknown += 1;
      continue;
    }
    buckets[EXPIRY_RANGES.findIndex((r) => Number(d) <= r.hi)].value += 1;
  }
  return { buckets, unknown };
}

// Abandoned codes by time since expiry, measured against `nowSec` (the API's
// generated_at, i.e. server time — not the browser clock):
//   <7d, 7–29d, 30–89d, 90d+   (whole days, floored)
// Rows with no expires_at are counted in `unknown`.
export const EXPIRED_AGE_RANGES = [
  { label: "<7d", hi: 6 },
  { label: "7–29d", hi: 29 },
  { label: "30–89d", hi: 89 },
  { label: "90d+", hi: Infinity },
];
export function expiredAgeBuckets(abandoned, nowSec) {
  const buckets = EXPIRED_AGE_RANGES.map((r) => ({ label: r.label, value: 0 }));
  let unknown = 0;
  for (const c of abandoned || []) {
    const exp = c?.expires_at;
    if (exp === null || exp === undefined || !Number.isFinite(Number(exp)) || !Number.isFinite(Number(nowSec))) {
      unknown += 1;
      continue;
    }
    const days = Math.max(0, Math.floor((Number(nowSec) - Number(exp)) / 86400));
    buckets[EXPIRED_AGE_RANGES.findIndex((r) => days <= r.hi)].value += 1;
  }
  return { buckets, unknown };
}

// ?type= values the table filter accepts; anything else means "all".
export const PENDING_TYPES = ["pending", "abandoned"];
export function parsePendingType(v) {
  return PENDING_TYPES.includes(v) ? v : "";
}

// Client-side table filter. Only the tables use this — KPIs and charts always
// read the full, unfiltered payload. Search matches the code OR the planned
// device name, case-insensitive.
export function filterPending({ pending, abandoned }, { type = "", q = "" } = {}) {
  const t = parsePendingType(type);
  const needle = String(q || "").trim().toLowerCase();
  const match = (c) =>
    !needle ||
    String(c.code || "").toLowerCase().includes(needle) ||
    String(c.planned_device_name || "").toLowerCase().includes(needle);
  return {
    pending: t === "abandoned" ? [] : (pending || []).filter(match),
    abandoned: t === "pending" ? [] : (abandoned || []).filter(match),
  };
}
