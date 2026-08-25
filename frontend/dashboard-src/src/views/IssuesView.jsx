import { useCallback, useEffect } from "react";
import { useApi } from "../hooks/useApi";
import { usePeriod } from "../hooks/usePeriod";
import { useSession } from "../hooks/useSession";
import { apiFetch } from "../lib/api";
import { n0, periodWindow, periodLabel } from "../lib/format";

export default function IssuesView() {
  const { me, setIssueCount } = useSession();
  const { period } = usePeriod();
  const isAdmin = !!me?.is_platform_admin;

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

  if (!isAdmin) {
    return (
      <>
        <div className="pt">
          <h1>Open issues</h1>
        </div>
        <div className="card">
          <h2>Platform admin required</h2>
          <p style={{ margin: "6px 0 0", fontSize: 12.5, color: "var(--ink2)" }}>This view is restricted to platform administrators.</p>
        </div>
      </>
    );
  }

  if (error) {
    return (
      <div className="card">
        <h2>Something went wrong</h2>
        <p style={{ margin: "6px 0 0", fontSize: 12.5, color: "var(--ink2)" }}>{error.message}</p>
      </div>
    );
  }
  if (!issues) return <p className="sub">Loading…</p>;

  return (
    <>
      <div className="pt">
        <h1>Open issues</h1>
        <span className="stamp">
          {issues.length} error group(s) · {issues.reduce((a, i) => a + i.affected_devices, 0)} devices affected · {periodLabel(period)}
        </span>
      </div>
      <p className="sub">Player errors reported in this period, grouped by their error fingerprint.</p>
      <div className="grid" style={{ gap: 8 }}>
        {issues.length ? (
          issues.map((i, idx) => (
            <div className="exc rise" style={{ borderLeftColor: "var(--accent)" }} key={idx}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
                <div style={{ minWidth: 0 }}>
                  <h3 className="mono trunc" title={i.error_fingerprint || ""}>
                    {i.error_fingerprint || "—"}
                  </h3>
                </div>
                <span className="plain p-bad">
                  {n0(i.affected_devices)} device{i.affected_devices === 1 ? "" : "s"}
                </span>
              </div>
              <div className="meta">
                <span>
                  {n0(i.occurrence_count)} occurrence{i.occurrence_count === 1 ? "" : "s"}
                </span>
                <span>last seen {i.last_seen ? new Date(i.last_seen * 1000).toLocaleString() : "—"}</span>
              </div>
            </div>
          ))
        ) : (
          <div className="card">
            <p className="empty" style={{ padding: 0 }}>
              No grouped issues in this period.
            </p>
          </div>
        )}
      </div>
    </>
  );
}
