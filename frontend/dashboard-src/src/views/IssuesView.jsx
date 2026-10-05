import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useApi } from "../hooks/useApi";
import { usePeriod } from "../hooks/usePeriod";
import { useSession } from "../hooks/useSession";
import { apiFetch } from "../lib/api";
import { n0, periodWindow, periodLabel, timeAgo } from "../lib/format";
import {
  ISSUE_LIMIT,
  shortFingerprint,
  perDevice,
  isActive,
  lastSeenBuckets,
  topIssues,
  parseIssueStatus,
  parseIssueSort,
  filterIssues,
  sortIssues,
} from "../lib/issues";
import KpiCard from "../components/KpiCard";
import CategoryBarChart from "../components/CategoryBarChart";

// GET /api/dashboard/issues?start= — player errors grouped by error_fingerprint,
// platform-admin only, across ALL workspaces (player_debug_logs has no tenant
// column). Up to 50 groups, ordered by affected devices. There's no device
// list, message or time series, so the charts are breakdowns of the current
// groups, not trends — and affected_devices is never summed across groups (one
// device can appear in several groups).
//
// The response carries no server time, so "active in last 24h" and the
// last-seen buckets use the browser clock (as timeAgo already does). KPIs and
// charts read the full payload; ?status= / ?q= / ?sort= only shape the table.

const STATUSES = [
  { key: "", label: "All" },
  { key: "active", label: "Active 24h" },
];
const SORTS = [
  { key: "devices", label: "Devices" },
  { key: "occurrences", label: "Occurrences" },
  { key: "per_device", label: "Per device" },
  { key: "last_seen", label: "Last seen" },
];

export default function IssuesView() {
  const { me, setIssueCount } = useSession();
  const { period } = usePeriod();
  const isAdmin = !!me?.is_platform_admin;
  const [searchParams, setSearchParams] = useSearchParams();

  const status = parseIssueStatus(searchParams.get("status"));
  const sort = parseIssueSort(searchParams.get("sort"));
  const urlSearch = searchParams.get("q") || "";
  const [inputValue, setInputValue] = useState(urlSearch);
  useEffect(() => setInputValue(urlSearch), [urlSearch]);

  // Debounced ?q= update, same 260ms as the Screens page.
  useEffect(() => {
    if (inputValue === urlSearch) return;
    const t = setTimeout(() => {
      const next = new URLSearchParams(searchParams);
      if (inputValue) next.set("q", inputValue);
      else next.delete("q");
      setSearchParams(next, { replace: true });
    }, 260);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputValue]);

  // Drops the param for its default value so the URL stays clean.
  const setParam = (key, value, fallback) => {
    const p = new URLSearchParams(searchParams);
    if (value && value !== fallback) p.set(key, value);
    else p.delete(key);
    setSearchParams(p, { replace: true });
  };

  const fetcher = useCallback(
    async ({ signal }) => {
      const { start } = periodWindow(period);
      return apiFetch(`/api/dashboard/issues?start=${encodeURIComponent(start.toISOString())}`, { signal });
    },
    [period],
  );

  const { data: issues, error } = useApi(fetcher, { pollMs: 60000, deps: [period], enabled: isAdmin });

  useEffect(() => {
    if (issues) setIssueCount(issues.length);
  }, [issues, setIssueCount]);

  const header = (
    <>
      <div className="pt">
        <h1>Open issues</h1>
        <span className="stamp">{periodLabel(period)}</span>
      </div>
      <p className="sub">
        Player errors grouped by error fingerprint, across all workspaces, in the {periodLabel(period)}.
      </p>
    </>
  );

  if (!isAdmin) {
    return (
      <>
        {header}
        <div className="card">
          <h2>Platform admin required</h2>
          <p style={{ margin: "6px 0 0", fontSize: 12.5, color: "var(--ink2)" }}>This view is restricted to platform administrators.</p>
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
  if (!issues) {
    return (
      <>
        {header}
        <p className="sub">Loading…</p>
      </>
    );
  }

  if (!issues.length) {
    return (
      <>
        {header}
        <div className="card">
          <p className="empty" style={{ padding: 0 }}>
            No grouped issues in this period.
          </p>
        </div>
      </>
    );
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const groups = issues.length;
  const occurrences = issues.reduce((a, i) => a + (Number(i.occurrence_count) || 0), 0);
  const widest = sortIssues(issues, "devices")[0];
  const widestDevices = Number(widest.affected_devices) || 0;
  const active = issues.filter((i) => isActive(i, nowSec)).length;
  const top = topIssues(issues, 8);
  const seenChart = lastSeenBuckets(issues, nowSec);
  const rows = sortIssues(filterIssues(issues, { status, q: urlSearch, nowSec }), sort);

  return (
    <>
      {header}

      <div className="grid g4">
        <KpiCard
          label="Error groups"
          value={n0(groups)}
          subLine={
            groups >= ISSUE_LIMIT ? `top ${ISSUE_LIMIT} by affected devices; there may be more` : `in the ${periodLabel(period)}`
          }
          color="var(--accent)"
        />
        <KpiCard
          label="Occurrences"
          value={n0(occurrences)}
          subLine="reported errors, all groups"
          color="var(--accent)"
        />
        <KpiCard
          label="Most widespread"
          value={`${n0(widestDevices)} device${widestDevices === 1 ? "" : "s"}`}
          subLine={
            <span className="mono" title={widest.error_fingerprint || ""}>
              {shortFingerprint(widest.error_fingerprint)}
            </span>
          }
          color={widestDevices ? "var(--bad)" : "var(--ok)"}
        />
        <KpiCard
          label="Active in last 24h"
          value={n0(active)}
          ofValue={n0(groups)}
          subLine={active ? "groups seen in the last 24 hours" : "no group seen in the last 24 hours"}
          percentage={(active / groups) * 100}
          color={active ? "var(--warn)" : "var(--ok)"}
        />
      </div>

      <div className="grid g2 mt16 csplit">
        <CategoryBarChart
          title="Most widespread issues"
          hint="affected devices, top 8"
          layout="horizontal"
          height={Math.max(150, top.length * 30 + 30)}
          data={top.map((t) => ({ ...t, color: "var(--bad)" }))}
          tooltipLabel={(row) => row.full}
        />
        <CategoryBarChart
          title="Issues by last seen"
          hint={seenChart.unknown ? `${n0(seenChart.unknown)} with no last-seen time` : "error groups"}
          data={seenChart.buckets.map((b, i) => ({ ...b, color: i < 2 ? "var(--warn)" : "var(--ink3)" }))}
        />
      </div>

      <div className="ctl mt16">
        <div className="seg" role="group" aria-label="Filter by activity">
          {STATUSES.map((s) => (
            <button key={s.key || "all"} className={status === s.key ? "on" : ""} onClick={() => setParam("status", s.key, "")}>
              {s.label}
            </button>
          ))}
        </div>
        <input
          className="srch"
          placeholder="Find an error"
          aria-label="Find an error"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
        />
        <div className="seg" role="group" aria-label="Sort by">
          {SORTS.map((s) => (
            <button key={s.key} className={sort === s.key ? "on" : ""} onClick={() => setParam("sort", s.key, "devices")}>
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <div className="sec">
        {!rows.length ? (
          <div className="card">
            <p className="empty" style={{ padding: 0 }}>
              No issues match.
            </p>
          </div>
        ) : (
          <div className="card pad0">
            <table style={{ minWidth: 640 }}>
              <thead>
                <tr>
                  <th>Error fingerprint</th>
                  <th className="r">Devices</th>
                  <th className="r">Occurrences</th>
                  <th className="r">Per device</th>
                  <th>Last seen</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((i) => {
                  const pd = perDevice(i);
                  return (
                    <tr key={i.error_fingerprint || "—"}>
                      <td>
                        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px 6px" }}>
                          <span className="mono" title={i.error_fingerprint || ""}>
                            {shortFingerprint(i.error_fingerprint)}
                          </span>
                          {isActive(i, nowSec) ? <span className="tag p-warn">active</span> : null}
                        </div>
                      </td>
                      <td className="r mono">{n0(Number(i.affected_devices) || 0)}</td>
                      <td className="r mono">{n0(Number(i.occurrence_count) || 0)}</td>
                      <td className="r mono">{pd === null ? "—" : pd.toFixed(1)}</td>
                      <td
                        className="mono"
                        title={i.last_seen ? new Date(i.last_seen * 1000).toLocaleString() : ""}
                      >
                        {timeAgo(i.last_seen)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
