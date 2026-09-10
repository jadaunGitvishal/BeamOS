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
