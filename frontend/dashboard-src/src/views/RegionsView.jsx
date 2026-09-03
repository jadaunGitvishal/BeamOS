import { useCallback } from "react";
import { useApi } from "../hooks/useApi";
import { useSession } from "../hooks/useSession";
import { usePeriod } from "../hooks/usePeriod";
import { useClock } from "../hooks/useClock";
import { apiFetch, UnauthenticatedError } from "../lib/api";
import { n0, cCol, periodWindow, periodLabel, isoDateOnly } from "../lib/format";
import { REGION_STATUS as STATUS } from "../lib/regions";

// Phase 3 Stage C — per-region SLA rollup, read off
// GET /api/organizations/:orgId/regions/sla-overview (Stage B). The endpoint
// already scopes to exactly the workspaces the caller can see and returns an
// "Unassigned" bucket for region-less workspaces, so this view just renders it.
// Status label/colour vocabulary lives in lib/regions.js, shared with the
// Overview "Regions" teaser.

export default function RegionsView() {
  const { me } = useSession();
  const { period } = usePeriod();
  const asof = useClock();
  const orgId = me?.current_organization?.id || null;
  const orgName = me?.current_organization?.name || "";

  const fetcher = useCallback(
    async ({ signal }) => {
      const { start } = periodWindow(period);
      // 403 (no accessible workspace in the org) or any non-auth failure must
      // not blow up the view — degrade to null and show a message.
      return apiFetch(
        `/api/organizations/${encodeURIComponent(orgId)}/regions/sla-overview?start=${encodeURIComponent(isoDateOnly(start))}`,
        { signal },
      ).catch((e) => {
        if (e instanceof UnauthenticatedError || e.name === "AbortError") throw e;
        return { __denied: true };
      });
    },
    [orgId, period],
  );

  const { data, error } = useApi(fetcher, { pollMs: 60000, deps: [orgId, period], enabled: !!orgId });

  const header = (
    <div className="pt">
      <h1>Regions</h1>
      <span className="stamp">as of {asof}</span>
    </div>
  );

  if (!orgId) {
    return (
      <>
        {header}
        <div className="card">
          <p className="empty" style={{ padding: 0 }}>
            No organization context for this session.
          </p>
        </div>
      </>
    );
  }
  if (error) {
    return (
      <>
        {header}
        <div className="card">
          <h2>Something went wrong</h2>
          <p style={{ margin: "6px 0 0", fontSize: 12.5, color: "var(--ink2)" }}>{error.message}</p>
        </div>
      </>
    );
  }
  if (!data) return <p className="sub">Loading…</p>;

  if (data.__denied) {
    return (
      <>
        {header}
        <div className="card">
          <p className="empty" style={{ padding: 0 }}>
            You don’t have access to any workspaces in this organization.
          </p>
        </div>
      </>
    );
  }

  const target = data.target?.uptime_target_pct ?? null;
  const regions = data.regions || [];
  // The rollup always returns an "Unassigned" bucket when the org has
  // region-less workspaces, so "no regions" means "no bucket with a real id".
  const namedRegions = regions.filter((r) => r.region_id !== null);

  return (
    <>
      {header}
      <p className="sub">
        SLA compliance by region for {orgName ? <b>{orgName}</b> : "your organization"}, over the {periodLabel(period)}
        {target !== null ? ` — target ${target}% uptime` : ""}.
      </p>

      {!regions.length ? (
        <div className="card">
          <p className="empty" style={{ padding: 0 }}>
            No workspaces you can see in this organization yet.
          </p>
        </div>
      ) : (
        <>
          {!namedRegions.length ? (
            <div className="card" style={{ marginBottom: 10 }}>
              <p className="empty" style={{ padding: 0 }}>
                No regions defined yet. An organization admin can create regions and assign workspaces to them in
                Settings — until then every workspace counts as Unassigned.
              </p>
            </div>
          ) : null}
          <div className="card pad0">
          <table>
            <thead>
              <tr>
                <th>Region</th>
                <th className="r">Workspaces</th>
                <th className="r">Screens</th>
                <th className="r">Avg uptime</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {regions.map((r) => {
                const s = STATUS[r.sla_status] || STATUS.unknown;
                return (
                  <tr key={r.region_id || "__unassigned__"}>
                    <td>
                      {r.region_id === null ? (
                        <span style={{ color: "var(--ink3)" }}>{r.region_name}</span>
                      ) : (
                        r.region_name
                      )}
                    </td>
                    <td className="r mono">{n0(r.workspace_count)}</td>
                    <td className="r mono">
                      {n0(r.device_count)}
                      {r.devices_with_data < r.device_count ? (
                        <small style={{ color: "var(--ink3)" }}> ({n0(r.devices_with_data)} w/ data)</small>
                      ) : null}
                    </td>
                    <td className="r mono" style={{ color: r.avg_uptime_pct !== null ? cCol(r.avg_uptime_pct) : "var(--ink3)" }}>
                      {r.avg_uptime_pct !== null ? `${r.avg_uptime_pct}%` : "—"}
                    </td>
                    <td>
                      <span style={{ color: s.color, fontWeight: 500 }}>{s.label}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </>
      )}
    </>
  );
}
