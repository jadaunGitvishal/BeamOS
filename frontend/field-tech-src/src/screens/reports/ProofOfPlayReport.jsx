import { useEffect, useState } from "react";
import { apiGet, ApiError } from "../../lib/api.js";

// Ref 75 Stage B: GET /api/reports/summary, the SAME aggregation both the
// desktop Reports page AND the Ref 46 emailed proof-of-play digest use
// (lib/proof-of-play.js) - workspace-scoped off the current JWT, default
// last-30-days window. Response shape: { period, overall: { total_plays,
// total_hours, unique_content, unique_devices }, by_content: [{ content_name,
// plays, total_seconds, completed_plays }], ... }. Only overall + top content
// are shown here - by_device/by_hour/by_day are desktop-table material, not a
// phone-width read.
const TOP_CONTENT_LIMIT = 8;

export default function ProofOfPlayReport({ onSessionExpired }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiGet("/api/reports/summary");
        if (!cancelled) setData(res);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) return onSessionExpired();
        setError((err instanceof ApiError && err.message) || "Could not load proof-of-play.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [onSessionExpired]);

  if (error) return <p className="error" role="alert">{error}</p>;
  if (data === null) return <p className="muted">Loading…</p>;

  const { overall, by_content } = data;
  const topContent = (by_content || []).slice(0, TOP_CONTENT_LIMIT);

  return (
    <>
      <p className="report-period">Last 30 days</p>
      <div className="stat-grid">
        <div className="stat-tile">
          <div className="stat-tile__value">{overall.total_plays}</div>
          <div className="stat-tile__label">Total plays</div>
        </div>
        <div className="stat-tile">
          <div className="stat-tile__value">{overall.total_hours}h</div>
          <div className="stat-tile__label">Total hours</div>
        </div>
        <div className="stat-tile">
          <div className="stat-tile__value">{overall.unique_content}</div>
          <div className="stat-tile__label">Unique content</div>
        </div>
        <div className="stat-tile">
          <div className="stat-tile__value">{overall.unique_devices}</div>
          <div className="stat-tile__label">Devices played on</div>
        </div>
      </div>
      <p className="field-label">Top content</p>
      {topContent.length === 0 ? (
        <p className="muted">No plays recorded in this window.</p>
      ) : (
        <ul className="list">
          {topContent.map((c, i) => (
            <li key={`${c.content_id ?? "unknown"}-${i}`}>
              <div className="row row--static">
                <span className="row__value">
                  <span className="row__title">{c.content_name || "Unknown"}</span>
                  <span className="row__meta">{c.plays} play{c.plays === 1 ? "" : "s"}</span>
                </span>
                <span className="row__meta">{(c.total_seconds / 3600).toFixed(1)}h total</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
