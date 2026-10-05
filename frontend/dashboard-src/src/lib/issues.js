// Pure helpers for the Issues view (GET /api/dashboard/issues): player errors
// grouped by error_fingerprint, platform-admin only, across all workspaces.
// Unit-tested in server/test/dashboard-issues-view.test.mjs.
//
// The API returns up to 50 groups ordered by affected_devices DESC with no
// tie-break, so every ordering here breaks ties by fingerprint (ascending) to
// keep rows from reshuffling between 60s polls. Fingerprints are opaque hashes
// (the web player sends a 16-char hash16; the ingest route accepts up to 64
// chars), so labels are shortened ids, not messages.

export const ISSUE_LIMIT = 50;
const HOUR = 3600;
const DAY = 86400;

const num = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
const fpOf = (i) => String(i?.error_fingerprint ?? "");

// Middle-ellipsis a fingerprint to at most `max` chars ("a1b2c3d4e5…f9a0");
// empty / missing -> "—".
export function shortFingerprint(fp, max = 16) {
  const s = String(fp ?? "");
  if (!s) return "—";
  if (s.length <= max) return s;
  const tail = Math.max(1, Math.floor((max - 1) / 4));
  return `${s.slice(0, max - 1 - tail)}…${s.slice(-tail)}`;
}

// Occurrences per affected device, or null when no device is attributed
// (affected_devices can be 0: logs from unpaired players carry no device_id).
export function perDevice(issue) {
  const occ = num(issue?.occurrence_count);
  const dev = num(issue?.affected_devices);
  if (occ === null || !dev) return null;
  return occ / dev;
}

// "Active" = last seen less than 24h before `nowSec`. Exactly 24h is not active.
export function isActive(issue, nowSec) {
  const seen = num(issue?.last_seen);
  if (seen === null || num(nowSec) === null) return false;
  return nowSec - seen < DAY;
}

// Issues by time since last seen: <1h, 1–24h, 1–7d, 7d+ (lower bound
// inclusive). A last_seen in the future counts as <1h; a null one is counted
// in `unknown` so the chart can say so.
export const LAST_SEEN_RANGES = [
  { label: "<1h", lt: HOUR },
  { label: "1–24h", lt: DAY },
  { label: "1–7d", lt: 7 * DAY },
  { label: "7d+", lt: Infinity },
];
export function lastSeenBuckets(issues, nowSec) {
  const buckets = LAST_SEEN_RANGES.map((r) => ({ label: r.label, value: 0 }));
  let unknown = 0;
  for (const i of issues || []) {
    const seen = num(i?.last_seen);
    if (seen === null || num(nowSec) === null) {
      unknown += 1;
      continue;
    }
    const age = Math.max(0, nowSec - seen);
    buckets[LAST_SEEN_RANGES.findIndex((r) => age < r.lt)].value += 1;
  }
  return { buckets, unknown };
}

// ?status= / ?sort= values the table accepts; anything else falls back.
export const ISSUE_STATUSES = ["active"];
export function parseIssueStatus(v) {
  return ISSUE_STATUSES.includes(v) ? v : "";
}
export const ISSUE_SORTS = ["devices", "occurrences", "per_device", "last_seen"];
export function parseIssueSort(v) {
  return ISSUE_SORTS.includes(v) ? v : "devices";
}

const SORT_VALUE = {
  devices: (i) => num(i.affected_devices),
  occurrences: (i) => num(i.occurrence_count),
  per_device: perDevice,
  last_seen: (i) => num(i.last_seen),
};

// Highest first; nulls last; ties by fingerprint ascending. Never mutates.
export function sortIssues(issues, sort) {
  const value = SORT_VALUE[parseIssueSort(sort)];
  return [...(issues || [])].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    if (va !== vb) {
      if (va === null) return 1;
      if (vb === null) return -1;
      return vb - va;
    }
    const fa = fpOf(a);
    const fb = fpOf(b);
    return fa < fb ? -1 : fa > fb ? 1 : 0;
  });
}

// Client-side table filter (status + case-insensitive fingerprint search).
// Only the table uses this — KPIs and charts read the full payload.
export function filterIssues(issues, { status = "", q = "", nowSec } = {}) {
  const s = parseIssueStatus(status);
  const needle = String(q || "").trim().toLowerCase();
  return (issues || []).filter(
    (i) => (!s || isActive(i, nowSec)) && (!needle || fpOf(i).toLowerCase().includes(needle)),
  );
}

// Top `n` groups by affected devices (same tie-break as the table) as chart
// rows: a short, unique label for the axis plus the full fingerprint for the
// tooltip.
export function topIssues(issues, n = 8) {
  const seen = new Map();
  return sortIssues(issues, "devices")
    .slice(0, n)
    .map((i) => {
      const base = shortFingerprint(i.error_fingerprint, 12);
      const k = (seen.get(base) || 0) + 1;
      seen.set(base, k);
      return {
        label: k === 1 ? base : `${base} (${k})`,
        full: fpOf(i) || "—",
        value: num(i.affected_devices) ?? 0,
      };
    });
}
