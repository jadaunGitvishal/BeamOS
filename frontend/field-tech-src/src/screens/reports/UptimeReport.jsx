import { useEffect, useState } from "react";
import { apiGet, ApiError } from "../../lib/api.js";

// Ref 75 Stage B: GET /api/dashboard/reports/uptime, the SAME endpoint and
// heartbeat-based estimate the desktop dashboard's Devices page reads -
// workspace-scoped off the current JWT (set by ReportFlow's switch-workspace
// call), no query params needed for the default last-30-days window.
// Response shape: [{ device_id, device_name, heartbeat_count, first_seen,
// last_seen, estimated_uptime_pct }].
function tagClass(pct) {
  if (pct == null) return "tag--warn";
  if (pct >= 95) return "tag--ok";
  if (pct >= 80) return "tag--warn";
  return "tag--off";
}

export default function UptimeReport({ onSessionExpired }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await apiGet("/api/dashboard/reports/uptime");
        if (!cancelled) setRows(Array.isArray(data) ? data : []);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) return onSessionExpired();
        setError((err instanceof ApiError && err.message) || "Could not load uptime.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [onSessionExpired]);

  if (error) return <p className="error" role="alert">{error}</p>;
  if (rows === null) return <p className="muted">Loading…</p>;

  return (
    <>
      <p className="report-period">Last 30 days, heartbeat-based estimate</p>
      {rows.length === 0 ? (
        <p className="muted">No telemetry in this window yet.</p>
      ) : (
        <ul className="list">
          {rows.map((d) => (
            <li key={d.device_id}>
              <div className="row row--static">
                <span className="row__value">
                  <span className="row__title">{d.device_name || "Unnamed device"}</span>
                  <span className={`tag ${tagClass(d.estimated_uptime_pct)}`}>
                    {d.estimated_uptime_pct == null ? "n/a" : `${d.estimated_uptime_pct}%`}
                  </span>
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
