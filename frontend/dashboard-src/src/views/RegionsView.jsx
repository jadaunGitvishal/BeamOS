import { useCallback } from "react";
import { useApi } from "../hooks/useApi";
import { useSession } from "../hooks/useSession";
import { usePeriod } from "../hooks/usePeriod";
import { useClock } from "../hooks/useClock";
import { apiFetch, UnauthenticatedError } from "../lib/api";
import { n0, periodWindow, periodLabel, isoDateOnly } from "../lib/format";
import { REGION_STATUS as STATUS, rankRegionsByAttention } from "../lib/regions";
import ProgressBar from "../components/ProgressBar";
import KpiCard from "../components/KpiCard";
import ShareBars from "../components/ShareBars";

// Phase 3 Stage C — per-region SLA rollup, read off
// GET /api/organizations/:orgId/regions/sla-overview (Stage B). The endpoint
// already scopes to exactly the workspaces the caller can see and returns an
// "Unassigned" bucket for region-less workspaces, so this view just renders it.
// Status label/colour vocabulary lives in lib/regions.js, shared with the
// Overview "Regions" teaser.
//
// The endpoint returns one period average per region, not a daily series, so
// rows get a ProgressBar vs the target (no Sparkline — there's no trend data
// to draw and we don't fabricate one).

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
  const compliant = regions.filter((r) => r.sla_status === "compliant").length;
  const breach = regions.filter((r) => r.sla_status === "breach").length;
  const totalWorkspaces = regions.reduce((a, r) => a + r.workspace_count, 0);
  const totalDevices = regions.reduce((a, r) => a + r.device_count, 0);
  const withData = regions.reduce((a, r) => a + r.devices_with_data, 0);
  const ranked = rankRegionsByAttention(regions);

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
            <div className="card" style={{ marginBottom: 16 }}>
              <p className="empty" style={{ padding: 0 }}>
                No regions defined yet. An organization admin can create regions and assign workspaces to them in
                Settings — until then every workspace counts as Unassigned.
              </p>
            </div>
          ) : null}
          <div className="grid g4">
            <KpiCard
              label="Regions"
              value={n0(namedRegions.length)}
              subLine={`${n0(totalWorkspaces)} workspace${totalWorkspaces === 1 ? "" : "s"} in scope`}
              color="var(--accent)"
            />
            <KpiCard
              label="Compliant"
              value={n0(compliant)}
              ofValue={n0(regions.length)}
              subLine={target !== null ? `at or above ${target}% uptime` : "at or above the uptime target"}
              percentage={regions.length ? (compliant / regions.length) * 100 : null}
              color="var(--ok)"
            />
            <KpiCard
              label="In breach"
              value={n0(breach)}
              ofValue={n0(regions.length)}
              subLine={breach ? "below the uptime target" : "no region below target"}
              color={breach ? "var(--bad)" : "var(--ok)"}
            />
            <KpiCard
              label="Screens"
              value={n0(totalDevices)}
              subLine={withData < totalDevices ? `${n0(withData)} reporting uptime data` : "all reporting uptime data"}
              percentage={totalDevices ? (withData / totalDevices) * 100 : null}
              color="var(--accent)"
            />
          </div>

          <div className="grid g2 mt16 csplit">
            <div className="card panel">
              <div className="panel-head">
                <div>
                  <h2>Uptime by region</h2>
                  <p className="panel-note">
                    Average over the {periodLabel(period)}
                    {target !== null ? `; tick marks the ${target}% target` : ""}.
                  </p>
                </div>
              </div>
              <div className="cdel">
                {ranked.map((r) => {
                  const s = STATUS[r.sla_status] || STATUS.unknown;
                  return (
                    <div className="cdel-row" key={r.region_id || "__unassigned__"}>
                      <div className="cdel-name">
                        <span style={r.region_id === null ? { color: "var(--ink3)" } : undefined}>{r.region_name}</span>
                        <small>{s.label}</small>
                      </div>
                      <ProgressBar percentage={r.avg_uptime_pct} target={target} color={s.color} />
                    </div>
                  );
                })}
              </div>
            </div>
            <ShareBars
              title="Screens by region"
              note="Share of all screens you can see."
              unit="screen"
              rows={[...regions]
                .sort((x, y) => y.device_count - x.device_count)
                .map((r) => ({
                  key: r.region_id || "__unassigned__",
                  label: r.region_name,
                  count: r.device_count,
                  color: r.region_id === null ? "var(--ink3)" : "var(--accent)",
                }))}
              total={totalDevices}
            />
          </div>

          <div className="sec">
          <h2>All regions</h2>
          <div className="card pad0">
          <table style={{ minWidth: 640 }}>
            <thead>
              <tr>
                <th>Region</th>
                <th className="r">Workspaces</th>
                <th className="r">Screens</th>
                <th>Avg uptime vs target</th>
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
                    <td style={{ minWidth: 180 }}>
                      <ProgressBar percentage={r.avg_uptime_pct} target={target} color={s.color} />
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      <i className="dot" style={{ background: s.color, marginRight: 6 }} />
                      <span style={{ color: s.color, fontWeight: 500 }}>{s.label}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
          </div>
        </>
      )}
    </>
  );
}
