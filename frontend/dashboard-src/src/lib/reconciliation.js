// Shared vocabulary for the reconciliation surfaces — the Overview "Reconciliation"
// teaser and the full Reconciliation view — so the phrasing of what a ghost / stale
// device actually is stays in one place (cf. lib/regions.js, lib/campaigns.js).

// epoch seconds -> 'YYYY-MM-DD' (UTC), or "—" when absent
export function reconDate(epochSeconds) {
  if (epochSeconds === null || epochSeconds === undefined) return "—";
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

export const GHOST_HINT =
  "Registered in BeamOS but has never once reported — most likely provisioned and never deployed, or never got past first boot on site.";

export const staleHint = (days) =>
  `Reported before, but no heartbeat for ${days}+ days — most likely powered down, decommissioned, or physically removed without being deleted here.`;

// ── Reconciliation page charts + filter (pure, unit-tested in
// server/test/dashboard-reconciliation-view.test.mjs) ─────────────────────────

// Stale devices by days silent. Ranges start at `staleAfterDays` (N) and never
// overlap or go empty-negative:
//   N < 30       -> N–29d, 30–89d, 90d+
//   30 <= N < 90 -> N–89d, 90d+
//   N >= 90      -> Nd+
// Rows with a null days_since_heartbeat aren't bucketed; they're counted in
// `unknown` so the chart can say so instead of guessing.
export function staleBuckets(stale, staleAfterDays) {
  const n = Math.max(0, Math.floor(Number(staleAfterDays) || 0));
  const edges = [30, 90].filter((e) => e > n);
  const ranges = [];
  let lo = n;
  for (const e of edges) {
    ranges.push({ label: lo === e - 1 ? `${lo}d` : `${lo}–${e - 1}d`, lo, hi: e - 1 });
    lo = e;
  }
  ranges.push({ label: `${lo}d+`, lo, hi: Infinity });

  const buckets = ranges.map((r) => ({ label: r.label, value: 0 }));
  let unknown = 0;
  for (const d of stale || []) {
    const days = d?.days_since_heartbeat;
    if (days === null || days === undefined || !Number.isFinite(Number(days))) {
      unknown += 1;
      continue;
    }
    // The API only lists devices silent >= N days, but clamp anything below N
    // into the first range rather than dropping it.
    const i = ranges.findIndex((r) => Number(days) <= r.hi);
    buckets[i === -1 ? buckets.length - 1 : i].value += 1;
  }
  return { buckets, unknown };
}

// Ghost devices by time since registration, measured against `nowSec` (the
// API's generated_at, i.e. server time — not the browser clock).
//   <7d, 7–29d, 30–89d, 90d+   (whole days, floored)
// Rows with no registered_at are counted in `unknown`.
export const GHOST_AGE_RANGES = [
  { label: "<7d", hi: 6 },
  { label: "7–29d", hi: 29 },
  { label: "30–89d", hi: 89 },
  { label: "90d+", hi: Infinity },
];
export function ghostAgeBuckets(ghosts, nowSec) {
  const buckets = GHOST_AGE_RANGES.map((r) => ({ label: r.label, value: 0 }));
  let unknown = 0;
  for (const d of ghosts || []) {
    const reg = d?.registered_at;
    if (reg === null || reg === undefined || !Number.isFinite(Number(reg)) || !Number.isFinite(Number(nowSec))) {
      unknown += 1;
      continue;
    }
    const days = Math.max(0, Math.floor((Number(nowSec) - Number(reg)) / 86400));
    buckets[GHOST_AGE_RANGES.findIndex((r) => days <= r.hi)].value += 1;
  }
  return { buckets, unknown };
}

// ?type= values the table filter accepts; anything else means "all".
export const RECON_TYPES = ["ghost", "stale"];
export function parseReconType(v) {
  return RECON_TYPES.includes(v) ? v : "";
}

// Client-side table filter. Only the tables use this — KPIs and charts always
// read the full, unfiltered payload. Search matches name (or device_id when a
// device has no name), case-insensitive.
export function filterRecon({ ghosts, stale }, { type = "", q = "" } = {}) {
  const t = parseReconType(type);
  const needle = String(q || "").trim().toLowerCase();
  const match = (d) => !needle || String(d.name || d.device_id || "").toLowerCase().includes(needle);
  return {
    ghosts: t === "stale" ? [] : (ghosts || []).filter(match),
    stale: t === "ghost" ? [] : (stale || []).filter(match),
  };
}
