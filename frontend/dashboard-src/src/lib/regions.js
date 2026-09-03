// Shared region-rollup vocabulary. Used by the Regions page (full table) and the
// Overview "Regions" teaser so the status labels/colours stay in one place.

export const REGION_STATUS = {
  compliant: { label: "Compliant", color: "var(--ok)" },
  breach: { label: "Breach", color: "var(--bad)" },
  unknown: { label: "No data", color: "var(--ink3)" },
};

// Teaser order: surface problems first (breach, then no-data, then compliant),
// tie-break by name, and always sink the region-less "Unassigned" bucket last.
const RANK = { breach: 0, unknown: 1, compliant: 2 };
export function rankRegionsByAttention(regions) {
  return [...(regions || [])].sort(
    (a, b) =>
      (a.region_id === null) - (b.region_id === null) ||
      (RANK[a.sla_status] ?? 3) - (RANK[b.sla_status] ?? 3) ||
      String(a.region_name).localeCompare(String(b.region_name)),
  );
}
