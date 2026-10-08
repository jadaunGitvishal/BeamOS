import { useCallback, useEffect } from "react";
import { Link } from "react-router-dom";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, ReferenceLine } from "recharts";
import { useApi } from "../hooks/useApi";
import { useSession } from "../hooks/useSession";
import { usePeriod } from "../hooks/usePeriod";
import { useClock } from "../hooks/useClock";
import { apiFetch, UnauthenticatedError } from "../lib/api";
import { n0, cCol, periodWindow, isoDateOnly, formatDuration, fmtPeriodRange, targetStatus, TARGET_STATUS } from "../lib/format";
import { PRIORITY_COLOR, RESPONSE_STATUS, CATEGORY_LABEL, CATEGORY_COLOR, OWNER_LABELS, causeHint, rankOpenTickets } from "../lib/tickets";
import { REGION_STATUS, rankRegionsByAttention } from "../lib/regions";
import StatTile from "../components/StatTile";
import ComplianceGauge from "../components/ComplianceGauge";
import KpiCard from "../components/KpiCard";
import ProgressBar from "../components/ProgressBar";
import ScreenRuntime from "../components/ScreenRuntime";

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
      const [overview, devices, sla, slaTrend, tickets, regions] = await Promise.all([
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
      return { overview, devices, issues, sla, slaTrend, tickets, regions };
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

  const { overview, issues, sla, tickets, regions } = data;
  const total = overview.total_devices,
    online = overview.online,
    offline = overview.offline;
  const completion = overview.completion_pct;

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
  // Last 7 days vs the 7 before, from the same daily trend series. Only shown
  // when both windows have at least 4 days of data (in practice the 30d view;
  // 7d/24h fetch 7 days, so there's no previous week to compare against).
  const weekDelta = (() => {
    if (!trend.length) return null;
    const dayNum = (d) => Math.round(Date.parse(`${d}T00:00:00Z`) / 86400000);
    const last = Math.max(...trend.map((p) => dayNum(p.day)));
    const recent = trend.filter((p) => last - dayNum(p.day) < 7).map((p) => p.pct);
    const prev = trend.filter((p) => last - dayNum(p.day) >= 7 && last - dayNum(p.day) < 14).map((p) => p.pct);
    if (recent.length < 4 || prev.length < 4) return null;
    const mean = (a) => a.reduce((x, v) => x + v, 0) / a.length;
    return Math.round((mean(recent) - mean(prev)) * 10) / 10;
  })();
  const fleetStatus = targetStatus(fleetUptime, slaTarget);

  const trendFloor = trend.length
    ? Math.max(0, Math.floor(Math.min(...trend.map((p) => p.pct), slaTarget ?? 100) / 5) * 5 - 5)
    : 0;

  // "Network health": no single health score exists server-side, so this is a
  // plain composite of the page's two headline percentages, weighted equally:
  //   health = (fleet uptime % + play completion %) / 2
  // Uptime says "were the screens on", completion says "did what we scheduled
  // actually play" - together they're delivery + availability, the two things
  // the header promises. If only one is available it stands alone; neither ->
  // no data. Its target is 90, the same "good" line cCol already uses for
  // completion on this page (amber within 5 pts, red below 85).
  const HEALTH_TARGET = 90;
  const healthParts = [fleetUptime, completion].filter((v) => v !== null && Number.isFinite(Number(v))).map(Number);
  const health = healthParts.length
    ? Math.round((healthParts.reduce((a, v) => a + v, 0) / healthParts.length) * 10) / 10
    : null;
  // Ring colour and status word follow the shared target rule on the score
  // itself; "critical exceptions" (the open error groups the Issues page
  // lists - platform admins only, null otherwise) are reported as a separate
  // line, not folded into the colour.
  const exceptions = issues !== null ? issues.length : 0;
  const healthSt = targetStatus(health, HEALTH_TARGET);
  const healthStatus = health === null ? "No data yet" : TARGET_STATUS[healthSt].label;
  const healthDetail = exceptions > 0 ? `${n0(exceptions)} critical exception${exceptions === 1 ? "" : "s"}` : null;

  // Header meta line: the selected periodWindow() as dates, the org counts
  // (org/platform admins only), and "Live data · X% online" = online / total
  // from the overview response (the server's live connection status).
  const { start: periodStart, end: periodEnd } = periodWindow(period);

  // KPI row - every figure is from data this page already loaded:
  //   on air: overview online / total
  //   below target: SLA devices with data whose availability is under the
  //     SLA target (uptimeVals = those with data); sla null -> "—"
  //   open issues: issue groups + their summed affected_devices (a device
  //     in two groups counts twice, so no % bar against the fleet)
  //   incomplete plays: total_plays - completed_plays for the period
  const belowTarget = slaTarget !== null ? uptimeVals.filter((v) => v < slaTarget).length : null;
  const affectedScreens = issues !== null ? issues.reduce((a, i) => a + i.affected_devices, 0) : null;
  const incompletePlays = overview.total_plays - overview.completed_plays;
  const onlinePct = total ? Math.round((online / total) * 100) : null;

  return (
    <>
      {/* Header: title block left, Network health gauge right (as in the demo). */}
      <div className="pt ovhead">
        <div className="ovhead-text">
          <p className="eyebrow">Organisation overview</p>
          <h1>Network performance</h1>
          <p className="sub">One view of delivery, availability and the work that will recover performance.</p>
          <div className="ovhead-meta">
            <span>
              <small>Reporting period</small>
              {fmtPeriodRange(periodStart, periodEnd)}
            </span>
            {overview.org ? (
              <span>
                <small>Organisation</small>
                {n0(overview.org.workspace_count)} workspace{overview.org.workspace_count === 1 ? "" : "s"} ·{" "}
                {n0(overview.org.device_count)} screen{overview.org.device_count === 1 ? "" : "s"}
              </span>
            ) : null}
            <span className="ovhead-live" title="Share of screens connected right now (online ÷ total)">
              <small>Live data</small>
              <span className="livedot" aria-hidden="true"></span>
              {onlinePct !== null ? `${onlinePct}% online` : "no screens yet"} · as of {asof}
            </span>
          </div>
        </div>
        <ComplianceGauge
          variant="plain"
          size={64}
          label="Network health"
          percentage={health}
          target={HEALTH_TARGET}
          status={healthStatus}
          detail={healthDetail}
        />
      </div>

      <div className="grid g4">
        <KpiCard
          label="Screens on air now"
          value={n0(online)}
          ofValue={n0(total)}
          subLine={total ? `${((online / total) * 100).toFixed(1)}% of fleet` : "no screens yet"}
          percentage={total ? (online / total) * 100 : null}
          color="var(--on)"
          linkTo="/devices"
        />
        <KpiCard
          label="Screens below target"
          value={belowTarget !== null ? n0(belowTarget) : "—"}
          subLine={
            belowTarget !== null
              ? `of ${n0(uptimeVals.length)} reporting data · under ${slaTarget}%`
              : "SLA data unavailable"
          }
          percentage={belowTarget !== null && uptimeVals.length ? (belowTarget / uptimeVals.length) * 100 : null}
          color="var(--bad)"
          linkTo="/regions"
        />
        <KpiCard
          label="Open issues"
          value={issues !== null ? n0(issues.length) : "—"}
          subLine={
            issues !== null
              ? `${n0(affectedScreens)} screen${affectedScreens === 1 ? "" : "s"} affected`
              : "platform admin only"
          }
          color="var(--warn)"
          linkTo={issues !== null ? "/issues" : null}
        />
        <KpiCard
          label="Incomplete plays"
          value={n0(incompletePlays)}
          ofValue={n0(overview.total_plays)}
          subLine="incomplete this period"
          percentage={overview.total_plays ? (incompletePlays / overview.total_plays) * 100 : null}
          color="var(--accent)"
          linkTo="/content"
        />
      </div>

      <div className="card pad0 hero rise mt16">
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
        </div>
        <div className="heroR">
          <div className="ch">
            <h2>Screen status</h2>
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

      {/* PMI Ref 71: screen runtime over complete UTC days (own fetch). */}
      <ScreenRuntime />

      {/* SLA (left) + outages and Priority actions (right). Columns stretch to
          equal height; stacks on narrow screens. */}
      <div className={`sec${sla || openQueue != null ? " grid g2 ovsplit" : ""}`}>
        <div className="card panel">
          <div className="panel-head">
            <div>
              <p className="eyebrow">Fleet health · SLA</p>
              <h2>Fleet uptime compliance</h2>
            </div>
            {fleetStatus ? (
              <span className={`tag ${TARGET_STATUS[fleetStatus].pill}`}>{TARGET_STATUS[fleetStatus].label}</span>
            ) : null}
          </div>
          {sla ? (
            <>
              <p className="panel-note">
                Platform-wide target{slaTarget !== null ? ` ${slaTarget}% uptime` : ""}
                {slaThresholdH !== null ? `, escalating after ${slaThresholdH}h continuously offline` : ""}
                {fleetUptime !== null ? ` · avg across ${n0(uptimeVals.length)} screen${uptimeVals.length === 1 ? "" : "s"} with data` : ""}.
              </p>
              <div className="panel-gauge">
                <ComplianceGauge label="Fleet uptime vs target" percentage={fleetUptime} target={slaTarget} />
                {weekDelta !== null ? (
                  <p className="panel-delta">
                    <span style={{ color: weekDelta > 0 ? "var(--ok)" : weekDelta < 0 ? "var(--bad)" : "var(--ink3)" }} aria-hidden="true">
                      {weekDelta > 0 ? "↗" : weekDelta < 0 ? "↘" : "→"}
                    </span>{" "}
                    {weekDelta === 0 ? "No change" : `${weekDelta > 0 ? "+" : "−"}${Math.abs(weekDelta).toFixed(1)} pts`} vs previous 7 days
                  </p>
                ) : null}
              </div>
              {trend.length >= 2 ? (
                <div className="panel-chart">
                  <div className="ch">
                    <h3>Fleet uptime trend</h3>
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
            <p className="empty" style={{ padding: 0 }}>
              SLA data isn’t available for this view.
            </p>
          )}
        </div>

        <div className="ovright">
          {sla ? (
            <div className="card panel">
              <div className="panel-head">
                <div>
                  <p className="eyebrow">Outages</p>
                  <h2>Recovery and live breaches</h2>
                </div>
              </div>
              <div className="grid g2">
                <StatTile
                  label="Mean time to recovery"
                  value={fleetMttr !== null ? formatDuration(fleetMttr) : "—"}
                  sub={mttrOutages ? `across ${n0(mttrOutages)} completed outage${mttrOutages === 1 ? "" : "s"}` : "no completed outages in range"}
                />
                <StatTile
                  label="Live breaches"
                  value={
                    <span style={{ color: liveBreaches.length ? "var(--bad)" : "var(--ok)" }}>{n0(liveBreaches.length)}</span>
                  }
                  sub={liveBreaches.length ? `past the ${slaThresholdH ?? "escalation"}h threshold` : "none right now"}
                />
              </div>
            </div>
          ) : null}

          {openQueue != null ? (
            <div className="card panel ovright-grow">
              <div className="panel-head">
                <div>
                  <p className="eyebrow">Exceptions</p>
                  <h2>Priority actions</h2>
                </div>
                <Link className="panel-link" to="/operations">
                  View all {n0(openQueue.length)} →
                </Link>
              </div>
              {topActions.length ? (
                <div className="paq paq-ranked">
                  {topActions.map((t, i) => {
                    const rs = RESPONSE_STATUS[t.response_status];
                    const cause = causeHint(t);
                    return (
                      <div className="paq-row" key={t.id} style={{ borderLeftColor: PRIORITY_COLOR[t.priority] || "var(--line)" }}>
                        <span className="paq-num">{String(i + 1).padStart(2, "0")}</span>
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <span className="paq-owner">{OWNER_LABELS[t.owner_category] || t.owner_category}</span>
                          <span className="paq-title">{t.title}</span>
                          {cause ? <span className="paq-cause">Likely cause: {cause}</span> : null}
                        </div>
                        <div className="paq-meta">
                          <span style={{ color: PRIORITY_COLOR[t.priority], textTransform: "capitalize" }}>{t.priority}</span>
                          {t.ticket_category && t.ticket_category !== "reactive" ? (
                            <span style={{ color: CATEGORY_COLOR[t.ticket_category] || "var(--ink3)" }}>
                              {CATEGORY_LABEL[t.ticket_category] || t.ticket_category}
                            </span>
                          ) : null}
                          {rs ? <span style={{ color: rs.color }}>{rs.label}</span> : null}
                          <Link className="paq-open" to="/operations">
                            Open in Operations →
                          </Link>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="empty" style={{ padding: 0 }}>
                  All clear — no open operational tickets right now.
                </p>
              )}
            </div>
          ) : null}
        </div>
      </div>

      {regionRows ? (
        <div className="sec">
          <div className="card pad0 panel">
            <div className="panel-head panel-head-pad">
              <div>
                <p className="eyebrow">Comparative performance</p>
                <h2>Regional health</h2>
                {regionTarget !== null ? <p className="panel-note">Uptime vs the {regionTarget}% target</p> : null}
              </div>
              <Link className="panel-link" to="/regions">
                Open region view →
              </Link>
            </div>
            {/* Real /regions/sla-overview fields only - no per-region trend or
                period-over-period change exists, so neither is shown. */}
            <table className="regtab">
              <thead>
                <tr>
                  <th>Region</th>
                  <th>Compliance</th>
                  <th className="r">Screens</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {regionRows.map((r) => {
                  // Same target rule as the gauge and pill; no data -> grey "No data".
                  const st = targetStatus(r.avg_uptime_pct, regionTarget);
                  const s = st ? TARGET_STATUS[st] : REGION_STATUS.unknown;
                  return (
                    <tr key={r.region_id || "__unassigned__"}>
                      <td className="regtab-name" style={{ boxShadow: `inset 3px 0 0 ${s.color}` }}>
                        <span style={r.region_id === null ? { color: "var(--ink3)" } : undefined}>{r.region_name}</span>
                        <small>
                          {n0(r.workspace_count)} workspace{r.workspace_count === 1 ? "" : "s"}
                        </small>
                      </td>
                      <td className="regtab-bar">
                        <ProgressBar percentage={r.avg_uptime_pct} target={regionTarget} />
                      </td>
                      <td className="r regtab-screens">
                        <span className="num">
                          {n0(r.devices_with_data)} <small>of {n0(r.device_count)}</small>
                        </span>
                        <small>with data</small>
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
                    Open screen
                  </Link>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}
