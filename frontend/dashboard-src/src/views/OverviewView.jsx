import { useCallback, useEffect } from "react";
import { Link } from "react-router-dom";
import { useApi } from "../hooks/useApi";
import { useSession } from "../hooks/useSession";
import { usePeriod } from "../hooks/usePeriod";
import { useClock } from "../hooks/useClock";
import { apiFetch, UnauthenticatedError } from "../lib/api";
import { n0, cCol, periodWindow, periodLabel } from "../lib/format";
import { isAtRisk, isWeakSignal } from "../lib/risk";
import StatTile from "../components/StatTile";
import AttentionCard from "../components/AttentionCard";

export default function OverviewView() {
  const { me, setDeviceCount, setIssueCount } = useSession();
  const { period } = usePeriod();
  const asof = useClock();
  const isAdmin = !!me?.is_platform_admin;

  const fetcher = useCallback(
    async ({ signal }) => {
      const { start } = periodWindow(period);
      const [overview, devices] = await Promise.all([
        apiFetch(`/api/dashboard/overview?start=${encodeURIComponent(start.toISOString())}`, { signal }),
        apiFetch("/api/dashboard/devices", { signal }),
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
      return { overview, devices, issues };
    },
    [period, isAdmin],
  );

  const { data, error } = useApi(fetcher, { pollMs: 60000, deps: [period, isAdmin] });

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

  const { overview, devices, issues } = data;
  const total = overview.total_devices,
    online = overview.online,
    offline = overview.offline;
  const completion = overview.completion_pct;
  const attention = devices.filter((d) => isAtRisk(d) || isWeakSignal(d));

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
