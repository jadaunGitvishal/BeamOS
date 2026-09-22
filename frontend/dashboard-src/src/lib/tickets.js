// Shared ticket vocabulary + ranking. Used by both the Operations page (full
// ranked queue) and the Overview "Priority actions" teaser so the labels,
// colours and sort order stay defined in exactly one place.

export const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };
export const PRIORITY_COLOR = { high: "var(--bad)", medium: "var(--warn)", low: "var(--ink3)" };

// Ref 58: proactive (system found it first) / reactive (a human filed it,
// the default) / emergency (manual override, independent of source or
// priority). Separate axis from priority - a badge, not a sort key.
export const CATEGORY_LABEL = { proactive: "Proactive", reactive: "Reactive", emergency: "Emergency" };
export const CATEGORY_COLOR = { proactive: "var(--ink3)", reactive: "var(--ink3)", emergency: "var(--bad)" };

export const RESPONSE_STATUS = {
  breached: { label: "Breached", color: "var(--bad)" },
  due_today: { label: "Due today", color: "var(--warn)" },
  within_sla: { label: "Within SLA", color: "var(--ok)" },
};

// Human-readable outage root-cause hint for auto-created tickets. 'unknown' (and
// null) deliberately map to nothing — showing "Unknown" as if it were a finding
// is worse than showing nothing.
export const CAUSE_LABELS = {
  weak_wifi: "Weak Wi-Fi",
  low_storage: "Low storage",
  correlated_outage: "Multiple screens affected",
};
export const causeHint = (t) =>
  t && t.auto_source === "sla_breach" ? CAUSE_LABELS[t.likely_cause] || null : null;

// Open work, ranked: priority first, then oldest first — the same order the
// Operations "Ranked queue" shows.
export function rankOpenTickets(tickets) {
  return (tickets || [])
    .filter((t) => t.status === "open" || t.status === "in_progress")
    .sort(
      (a, b) =>
        (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9) ||
        a.created_at - b.created_at,
    );
}
