import { useCallback, useEffect } from "react";
import { Link } from "react-router-dom";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, ReferenceLine } from "recharts";
import { useApi } from "../hooks/useApi";
import { useSession } from "../hooks/useSession";
import { usePeriod } from "../hooks/usePeriod";
import { useClock } from "../hooks/useClock";
import { apiFetch, UnauthenticatedError } from "../lib/api";
import { n0, cCol, periodWindow, periodLabel, isoDateOnly, formatDuration } from "../lib/format";
import { isAtRisk, isWeakSignal } from "../lib/risk";
import { PRIORITY_COLOR, RESPONSE_STATUS, causeHint, rankOpenTickets } from "../lib/tickets";
import { REGION_STATUS, rankRegionsByAttention } from "../lib/regions";
import { deliveryColor } from "../lib/campaigns";
import StatTile from "../components/StatTile";
import ComplianceGauge from "../components/ComplianceGauge";
import AttentionCard from "../components/AttentionCard";

export default function OverviewView() {
  const { me, setDeviceCount, setIssueCount } = useSession();
  const { period } = usePeriod();
  const asof = useClock();
  const isAdmin = !!me?.is_platform_admin;
  const wsId = me?.current_workspace_id || null;
  const orgId = me?.current_organization?.id || null;

  const fetcher = useCallback(
    async ({ signal }) => {
      const { start } = periodWindow(period);
      // 24h view still gets a 7-day trend line — one point isn't a trend.
      const trendDays = period === 1 ? 7 : period;
      // Ref 51: SLA overview + trend. Any workspace member can read them, so
      // they're fetched for everyone — but a 403 (or any non-auth failure) must
      // NOT blank the whole page, so each degrades to null and its SLA section
      // shows a note / is hidden.
      const softFail = (e) => {
        if (e instanceof UnauthenticatedError || e.name === "AbortError") throw e;
        return null;
      };
      const [overview, devices, sla, slaTrend, tickets, regions, campaigns] = await Promise.all([
        apiFetch(`/api/dashboard/overview?start=${encodeURIComponent(start.toISOString())}`, { signal }),
        apiFetch("/api/dashboard/devices", { signal }),
        apiFetch(`/api/dashboard/reports/sla-overview?start=${encodeURIComponent(isoDateOnly(start))}`, { signal }).catch(softFail),
        apiFetch(`/api/dashboard/reports/sla-trend?days=${trendDays}`, { signal }).catch(softFail),
        // Priority-actions teaser — same endpoint Operations uses. Soft-fails to
        // null so a 403/500 hides the teaser rather than blanking the page.
        wsId
          ? apiFetch(`/api/workspaces/${encodeURIComponent(wsId)}/tickets`, { signal }).catch(softFail)
          : Promise.resolve(null),
        // Regions teaser — same rollup the Regions page uses. Soft-fails to null
        // (also null when there's no org context) so the section just hides.
        orgId
          ? apiFetch(
              `/api/organizations/${encodeURIComponent(orgId)}/regions/sla-overview?start=${encodeURIComponent(isoDateOnly(start))}`,
              { signal },
            ).catch(softFail)
          : Promise.resolve(null),
        // Campaigns teaser — same endpoint the Campaigns page uses. Soft-fails
        // to null so the section just hides on a 403/500 or no workspace.
        wsId
          ? apiFetch(`/api/workspaces/${encodeURIComponent(wsId)}/campaigns`, { signal }).catch(softFail)
          : Promise.resolve(null),
      ]);
      let issues = null;
      if (isAdmin) {
        try {
          issues = await apiFetch(`/api/dashboard/issues?start=${encodeURIComponent(start.toISOString())}`, {
            signal,
          });
        } catch (e) {
          if (e instanceof UnauthenticatedError || e.name === "AbortError") throw e;
          issues = [];
        }
      }
      return { overview, devices, issues, sla, slaTrend, tickets, regions, campaigns };
    },
    [period, isAdmin, wsId, orgId],
  );

  const { data, error } = useApi(fetcher, { pollMs: 60000, deps: [period, isAdmin, wsId, orgId] });

  useEffect(() => {
    if (!data) return;
    setDeviceCount(data.devices.length);
    if (data.issues !== null) setIssueCount(data.issues.length);
  }, [data, setDeviceCount, setIssueCount]);

  if (error) {
    return (
      <div className="card">
        <h2>Something went wrong</h2>
        <p style={{ margin: "6px 0 0", fontSize: 12.5, color: "var(--ink2)" }}>{error.message}</p>
      </div>
    );
  }
  if (!data) return <p className="sub">Loading…</p>;

  const { overview, devices, issues, sla, tickets, regions, campaigns } = data;
  const total = overview.total_devices,
    online = overview.online,
    offline = overview.offline;
  const completion = overview.completion_pct;
  const attention = devices.filter((d) => isAtRisk(d) || isWeakSignal(d));

  // --- Overview Stage B: "Priority actions" teaser — top 3 of the same ranked
  // open-ticket queue the Operations page shows. tickets === null (fetch soft-
  // failed or no workspace) hides the section entirely.
  const openQueue = tickets == null ? null : rankOpenTickets(tickets);
  const topActions = openQueue ? openQueue.slice(0, 3) : [];

  // --- Overview Stage C: "Regions" teaser — the per-region SLA rollup the
  // Regions page shows, condensed to name / status / avg uptime, problems
  // first. Regions are an opt-in org feature: the section shows ONLY once at
  // least one named region exists. A null rollup (no org / soft-fail) or an
  // org that has defined no regions => hide entirely, no "set one up" nag
  // (unlike Stage B's "All clear", "no regions" is a config state, not a live
  // status worth a permanent placeholder).
  const regionTarget = regions?.target?.uptime_target_pct ?? null;
  const regionRows =
    regions && Array.isArray(regions.regions) && regions.regions.some((r) => r.region_id !== null)
      ? rankRegionsByAttention(regions.regions)
      : null;

  // --- Overview Stage D: "Campaigns" teaser — the live campaigns the Campaigns
  // page tracks, condensed to name / delivery % / plays. Empty-state blends the
  // Stage B & C reasoning: the section shows only if this workspace uses
  // campaigns at all (>=1 of any status — no campaigns => usage gap, hide, cf.
  // Stage C); but if some exist and none are live, keep the section with a
  // "nothing running" note, because for a workspace that runs campaigns
  // "nothing scheduled right now" is a real status worth confirming (cf. Stage
  // B's "All clear"). null (soft-fail / no workspace) => hide.
  const allCampaigns = Array.isArray(campaigns) ? campaigns : null;
  const liveCampaigns = allCampaigns ? allCampaigns.filter((c) => c.status === "live") : [];
  const showCampaigns = allCampaigns != null && allCampaigns.length > 0;

  // --- Ref 51: SLA compliance (merged into this page, not a separate view) ---
  const slaTarget = sla?.target?.uptime_target_pct ?? null;
  const slaThresholdH = sla?.target?.escalation_threshold_hours ?? null;
  const slaDevices = sla?.devices ?? [];
  // Fleet MTTR = total completed-outage time / total completed outages (so a
  // device with more outages weighs proportionally, not one-device-one-vote).
  const mttrDevices = slaDevices.filter((d) => d.completed_outages > 0);
  const mttrOutages = mttrDevices.reduce((a, d) => a + d.completed_outages, 0);
  const fleetMttr = mttrOutages
    ? Math.round(mttrDevices.reduce((a, d) => a + d.mttr_seconds * d.completed_outages, 0) / mttrOutages)
    : null;
  const liveBreaches = slaDevices
    .filter((d) => d.live_breach)
    .sort((a, b) => b.ongoing_outage_seconds - a.ongoing_outage_seconds);
  // Fleet uptime = plain mean of per-device availability_pct. Devices with no
  // usage data in the period (availability_pct === null) are excluded, not
  // counted as 0 — filter `!= null` BEFORE Number(), since Number(null) is 0.
  const uptimeVals = slaDevices
    .filter((d) => d.availability_pct != null)
    .map((d) => Number(d.availability_pct))
    .filter((v) => Number.isFinite(v));
  const fleetUptime = uptimeVals.length ? uptimeVals.reduce((a, v) => a + v, 0) / uptimeVals.length : null;

  // Fleet uptime trend: one point per day with data. Y axis zooms to the data
  // (+ the target line) so real day-to-day movement is visible rather than a
  // flat line pinned near 100 — top stays at 100 (uptime's real ceiling).
  const trend = (data.slaTrend ?? [])
    .map((p) => ({ day: p.day, pct: Number(p.avg_uptime_pct) }))
    .filter((p) => Number.isFinite(p.pct));
  const trendFloor = trend.length
    ? Math.max(0, Math.floor(Math.min(...trend.map((p) => p.pct), slaTarget ?? 100) / 5) * 5 - 5)
    : 0;

  return (
    <>
      <div className="pt">
        <h1>Overview</h1>
        <span className="stamp">as of {asof}</span>
      </div>
      <p className="sub">
        Live figures for the {periodLabel(period)}, from {n0(total)} device{total === 1 ? "" : "s"} in this workspace.
      </p>

      <div className="card pad0 hero rise">
        <div className="heroL">
          <p className="k" style={{ fontSize: 11.5, color: "var(--ink2)", margin: "0 0 6px" }}>
            Play completion rate
          </p>
          <span className="big num">{completion !== null ? completion.toFixed(1) + "%" : "—"}</span>
          <div className="meter">
            <i style={{ width: `${completion !== null ? completion : 0}%`, background: completion !== null ? cCol(completion) : "var(--line)" }}></i>
          </div>
          <p className="s mono" style={{ marginTop: 9, color: "var(--ink3)" }}>
            {n0(overview.completed_plays)} of {n0(overview.total_plays)} plays completed
          </p>
          <div className="grid g2 mt16">
            <StatTile label="Total plays" value={n0(overview.total_plays)} card={false} />
            <StatTile
              label="Devices online"
              value={
                <>
                  {n0(online)} <small>of {n0(total)}</small>
                </>
              }
              card={false}
            />
          </div>
        </div>
        <div className="heroR">
          <div className="ch">
            <h2>Device status</h2>
            <span className="hint">online vs offline, right now</span>
          </div>
          <div className="own">
            {total ? (
              <>
                <i style={{ width: `${(online / total) * 100}%`, background: "var(--on)" }} title={`Online — ${online}`}></i>
                <i style={{ width: `${(offline / total) * 100}%`, background: "var(--off)" }} title={`Offline — ${offline}`}></i>
              </>
            ) : null}
          </div>
          <div className="grid g2 mt16" style={{ gap: 8 }}>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                <span className="dot" style={{ background: "var(--on)" }}></span>
                <span style={{ fontSize: 12, color: "var(--ink2)" }}>Online</span>
              </div>
              <p className="v num" style={{ fontSize: 16, marginLeft: 15 }}>
                {n0(online)}
              </p>
            </div>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                <span className="dot" style={{ background: "var(--off)" }}></span>
                <span style={{ fontSize: 12, color: "var(--ink2)" }}>Offline</span>
              </div>
              <p className="v num" style={{ fontSize: 16, marginLeft: 15 }}>
                {n0(offline)}
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="grid g4 mt16">
        <StatTile label="Total devices" value={n0(total)} card />
        <StatTile label="Online now" value={n0(online)} sub={total ? `${((online / total) * 100).toFixed(1)}% of the fleet` : null} card />
        <StatTile label="Needs attention" value={n0(attention.length)} sub="low storage, low RAM or weak Wi-Fi" card />
        {issues !== null ? (
          <StatTile
            label="Open issues"
            value={n0(issues.length)}
            sub={`${n0(issues.reduce((a, i) => a + i.affected_devices, 0))} devices affected`}
            card
          />
        ) : (
          <StatTile label="Open issues" value="—" sub="platform admin only" card />
        )}
      </div>

      {overview.org ? (
        <div className="grid g2 mt16">
          <StatTile label="Workspaces in org" value={n0(overview.org.workspace_count)} card />
          <StatTile label="Devices in org" value={n0(overview.org.device_count)} card />
        </div>
      ) : null}

      <div className="sec">
        <h2>SLA compliance</h2>
        {sla ? (
          <>
            <p className="sub" style={{ margin: "0 0 12px" }}>
              The SLA target is platform-wide for now
              {slaTarget !== null ? ` — ${slaTarget}% uptime` : ""}
              {slaThresholdH !== null ? `, escalating a breach after ${slaThresholdH}h continuously offline` : ""}.
            </p>

            <div className="grid g4">
              <ComplianceGauge label="Fleet uptime vs target" percentage={fleetUptime} target={slaTarget} />
              <StatTile
                label="Mean time to recovery"
                value={fleetMttr !== null ? formatDuration(fleetMttr) : "—"}
                sub={mttrOutages ? `across ${n0(mttrOutages)} completed outage${mttrOutages === 1 ? "" : "s"}` : "no completed outages in range"}
                card
              />
              <StatTile
                label="Live breaches"
                value={
                  <span style={{ color: liveBreaches.length ? "var(--bad)" : "var(--ok)" }}>{n0(liveBreaches.length)}</span>
                }
                sub={liveBreaches.length ? `past the ${slaThresholdH ?? "escalation"}h threshold` : "none right now"}
                card
              />
              <StatTile
                label="Fleet uptime"
                value={
                  fleetUptime !== null ? (
                    <span style={{ color: slaTarget !== null && fleetUptime >= slaTarget ? "var(--ok)" : "var(--bad)" }}>
                      {fleetUptime.toFixed(1)}%
                    </span>
                  ) : (
                    "—"
                  )
                }
                sub={
                  fleetUptime !== null
                    ? `avg across ${n0(uptimeVals.length)} device${uptimeVals.length === 1 ? "" : "s"} with data`
                    : "no data yet"
                }
                card
              />
            </div>

            {trend.length >= 2 ? (
              <div className="card mt16">
                <div className="ch">
                  <h2>Fleet uptime trend</h2>
                  <span className="hint">daily average vs the {slaTarget ?? "—"}% target</span>
                </div>
                <div style={{ width: "100%", height: 190 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={trend} margin={{ top: 8, right: 14, bottom: 0, left: 4 }}>
                      <XAxis
                        dataKey="day"
                        tick={{ fontSize: 10, fill: "var(--ink3)" }}
                        tickFormatter={(d) => d.slice(5)}
                        tickMargin={6}
                        interval="preserveStartEnd"
                        minTickGap={24}
                      />
                      <YAxis
                        domain={[trendFloor, 100]}
                        tick={{ fontSize: 10, fill: "var(--ink3)" }}
                        tickMargin={4}
                        width={44}
                        allowDecimals={false}
                        unit="%"
                      />
                      <Tooltip
                        formatter={(v) => [`${v}%`, "Uptime"]}
                        contentStyle={{ fontSize: 11, borderRadius: 8, border: "1px solid var(--line)" }}
                      />
                      {slaTarget != null ? (
                        <ReferenceLine
                          y={slaTarget}
                          stroke="var(--ink2)"
                          strokeDasharray="4 3"
                          label={{ value: `${slaTarget}% target`, position: "insideTopRight", fontSize: 9, fill: "var(--ink3)" }}
                        />
                      ) : null}
                      <Line
                        type="monotone"
                        dataKey="pct"
                        stroke="var(--accent)"
                        strokeWidth={2.25}
                        dot={false}
                        isAnimationActive={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
            ) : null}
          </>
        ) : (
          <div className="card">
            <p className="empty" style={{ padding: 0 }}>
              SLA data isn’t available for this view.
            </p>
          </div>
        )}
      </div>

      {openQueue != null ? (
        <div className="sec">
          <div className="ch">
            <h2>Priority actions</h2>
            {openQueue.length ? <span className="hint">{n0(openQueue.length)} open · top 3</span> : null}
          </div>
          {topActions.length ? (
            <div className="card">
              <div className="paq">
                {topActions.map((t) => {
                  const rs = RESPONSE_STATUS[t.response_status];
                  const cause = causeHint(t);
                  return (
                    <div className="paq-row" key={t.id}>
                      <div style={{ minWidth: 0 }}>
                        <span className="paq-title">{t.title}</span>
                        {cause ? <span className="paq-cause">Likely cause: {cause}</span> : null}
                      </div>
                      <div className="paq-meta">
                        <span style={{ color: PRIORITY_COLOR[t.priority], textTransform: "capitalize" }}>{t.priority}</span>
                        {rs ? <span style={{ color: rs.color }}>{rs.label}</span> : null}
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="mt16">
                <Link className="btn" to="/operations">
                  View all in Operations
                </Link>
              </div>
            </div>
          ) : (
            <div className="card">
              <p className="empty" style={{ padding: 0 }}>
                All clear — no open operational tickets right now.{" "}
                <Link to="/operations" style={{ color: "var(--accent)" }}>
                  Operations
                </Link>
              </p>
            </div>
          )}
        </div>
      ) : null}

      {regionRows ? (
        <div className="sec">
          <div className="ch">
            <h2>Regions</h2>
            <span className="hint">
              SLA by region{regionTarget !== null ? ` · target ${regionTarget}%` : ""}
            </span>
          </div>
          <div className="card">
            <div className="paq">
              {regionRows.map((r) => {
                const s = REGION_STATUS[r.sla_status] || REGION_STATUS.unknown;
                return (
                  <div className="paq-row" key={r.region_id || "__unassigned__"}>
                    <div style={{ minWidth: 0 }}>
                      <span
                        className="paq-title"
                        style={r.region_id === null ? { color: "var(--ink3)" } : undefined}
                      >
                        {r.region_name}
                      </span>
                    </div>
                    <div className="paq-meta">
                      {/* status carries the colour signal; the uptime number
                          stays neutral so a "Breach" region whose absolute
                          uptime is still >90 doesn't read red-then-green. */}
                      <span style={{ color: s.color }}>{s.label}</span>
                      <span style={{ color: r.avg_uptime_pct !== null ? "var(--ink2)" : "var(--ink3)" }}>
                        {r.avg_uptime_pct !== null ? `${r.avg_uptime_pct}%` : "—"}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="mt16">
              <Link className="btn" to="/regions">
                View all in Regions
              </Link>
            </div>
          </div>
        </div>
      ) : null}

      {showCampaigns ? (
        <div className="sec">
          <div className="ch">
            <h2>Campaigns</h2>
            {liveCampaigns.length ? <span className="hint">{n0(liveCampaigns.length)} live</span> : null}
          </div>
          {liveCampaigns.length ? (
            <div className="card">
              <div className="paq">
                {liveCampaigns.map((c) => (
                  <div className="paq-row" key={c.id}>
                    <div style={{ minWidth: 0 }}>
                      <span className="paq-title">{c.name}</span>
                      {c.playlist_name ? <span className="paq-cause">{c.playlist_name}</span> : null}
                    </div>
                    <div className="paq-meta">
                      <span style={{ color: deliveryColor(c.delivery_pct) }}>
                        {c.delivery_pct == null ? "—" : `${c.delivery_pct}%`}
                      </span>
                      <span style={{ color: "var(--ink3)" }}>
                        {c.actual_plays == null
                          ? "n/a"
                          : `${n0(c.actual_plays)} / ${c.expected_plays == null ? "—" : n0(c.expected_plays)}`}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt16">
                <Link className="btn" to="/campaigns">
                  View all in Campaigns
                </Link>
              </div>
            </div>
          ) : (
            <div className="card">
              <p className="empty" style={{ padding: 0 }}>
                No campaigns running right now.{" "}
                <Link to="/campaigns" style={{ color: "var(--accent)" }}>
                  Campaigns
                </Link>
              </p>
            </div>
          )}
        </div>
      ) : null}

      {sla && liveBreaches.length ? (
        <div className="sec">
          <h2>Live SLA breaches</h2>
          <div className="grid" style={{ gap: 8 }}>
            {liveBreaches.map((d) => (
              <div className="exc rise" style={{ borderLeftColor: "var(--bad)" }} key={d.device_id}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
                  <div style={{ minWidth: 0 }}>
                    <h3>{d.device_name}</h3>
                    <p>
                      Offline for {formatDuration(d.ongoing_outage_seconds)} — past the{" "}
                      {slaThresholdH ?? "escalation"}h escalation threshold.
                    </p>
                  </div>
                  <span className="plain p-bad">live breach</span>
                </div>
                <div className="meta">
                  <span>uptime {d.availability_pct !== null ? `${d.availability_pct}%` : "—"} this period</span>
                  {d.completed_outages ? <span>{n0(d.completed_outages)} earlier outage(s)</span> : null}
                </div>
                <div className="ctl mt16">
                  <Link className="btn" to={`/device/${encodeURIComponent(d.device_id)}`}>
                    Open device
                  </Link>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="sec">
        <h2>Needs attention</h2>
        {attention.length ? (
          <>
            <div className="grid" style={{ gap: 8 }}>
              {attention.slice(0, 10).map((d) => (
                <AttentionCard key={d.id} device={d} />
              ))}
            </div>
            {attention.length > 10 ? (
              <p className="s mono mt16" style={{ color: "var(--ink3)" }}>
                Showing 10 of {attention.length}.{" "}
                <Link to="/devices?risk=1" style={{ color: "var(--accent)" }}>
                  View all in Devices
                </Link>
              </p>
            ) : null}
          </>
        ) : (
          <div className="card">
            <p className="empty" style={{ padding: 0 }}>
              Nothing needs attention right now.
            </p>
          </div>
        )}
      </div>
    </>
  );
}
