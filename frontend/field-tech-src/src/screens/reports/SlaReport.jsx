import { useEffect, useState } from "react";
import { apiGet, ApiError } from "../../lib/api.js";

// Ref 75 Stage B: GET /api/dashboard/reports/sla-overview, the SAME endpoint
// the desktop SLA Dashboard reads (Ref 51) - workspace-scoped off the current
// JWT, default last-30-days window. Response shape:
//   { target: { uptime_target_pct, escalation_threshold_hours },
//     period: { start, end },
//     devices: [{ device_id, device_name, availability_pct, sla_status,
//                 mttr_seconds, completed_outages, live_breach }],
//     summary: { devices_total, devices_compliant, devices_breach,
//                devices_unknown, live_breaches } }
function statusTag(status) {
  if (status === "compliant") return "tag--ok";
  if (status === "breach") return "tag--off";
  return "tag--warn";
}

function fmtMttr(seconds) {
  if (seconds == null) return null;
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins}m`;
  return `${Math.round(mins / 60)}h`;
}

export default function SlaReport({ onSessionExpired }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiGet("/api/dashboard/reports/sla-overview");
        if (!cancelled) setData(res);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) return onSessionExpired();
        setError((err instanceof ApiError && err.message) || "Could not load SLA status.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [onSessionExpired]);

  if (error) return <p className="error" role="alert">{error}</p>;
  if (data === null) return <p className="muted">Loading…</p>;

  const { target, summary, devices } = data;

  return (
    <>
      <p className="report-period">
        {target.uptime_target_pct}% target · last 30 days
        {summary.live_breaches > 0 ? ` · ${summary.live_breaches} live breach${summary.live_breaches === 1 ? "" : "es"}` : ""}
      </p>
      <div className="stat-grid">
        <div className="stat-tile">
          <div className="stat-tile__value">{summary.devices_compliant}</div>
          <div className="stat-tile__label">Compliant</div>
        </div>
        <div className="stat-tile">
          <div className="stat-tile__value">{summary.devices_breach}</div>
          <div className="stat-tile__label">Breach</div>
        </div>
        <div className="stat-tile">
          <div className="stat-tile__value">{summary.devices_unknown}</div>
          <div className="stat-tile__label">Unknown</div>
        </div>
        <div className="stat-tile">
          <div className="stat-tile__value">{summary.devices_total}</div>
          <div className="stat-tile__label">Total devices</div>
        </div>
      </div>
      {devices.length === 0 ? (
        <p className="muted">No devices in this workspace.</p>
      ) : (
        <ul className="list">
          {devices.map((d) => {
            const mttr = fmtMttr(d.mttr_seconds);
            return (
              <li key={d.device_id}>
                <div className="row row--static">
                  <span className="row__value">
                    <span className="row__title">{d.device_name || "Unnamed device"}</span>
                    <span className={`tag ${statusTag(d.sla_status)}`}>
                      {d.availability_pct == null ? d.sla_status : `${d.availability_pct}%`}
                    </span>
                  </span>
                  {(mttr || d.live_breach) && (
                    <span className="row__meta">
                      {d.live_breach ? "Currently offline past threshold" : `MTTR ${mttr}`}
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
