// Ref 50 — proof-of-play timeline for one content item. Given `content` =
// { id, name }, fetches GET /api/dashboard/content/:id/plays and renders the
// individual play events in the same bounded-height, scrollable `.log`/`.log-scroll`
// pattern the Device Detail audit trail uses, for visual consistency.
//
// The dot + pill are colour-coded green/red on `completed`, matching the
// green/red completion convention already used on the Content page (cPill).

import { useCallback } from "react";
import { useApi } from "../hooks/useApi";
import { apiFetch } from "../lib/api";
import { formatDuration } from "../lib/format";

// Real play durations are frequently only a second or two, where formatDuration
// (minute-resolution) collapses to "0m". Show raw seconds below a minute.
function playLength(sec) {
  if (sec === null || sec === undefined) return "—";
  if (sec < 60) return `${sec}s`;
  return formatDuration(sec);
}

export default function PlayTimeline({ content, onClose }) {
  const fetcher = useCallback(
    ({ signal }) => apiFetch(`/api/dashboard/content/${encodeURIComponent(content.id)}/plays`, { signal }),
    [content.id],
  );
  const { data, error, loading } = useApi(fetcher, { pollMs: 60000, deps: [content.id] });

  const plays = data?.plays || [];

  return (
    <div className="sec">
      <div className="card">
        <div className="ch">
          <h2>Play timeline — {content.name}</h2>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span className="hint">
              {error
                ? "unavailable"
                : loading && !data
                  ? "loading…"
                  : `${plays.length} event(s)${data && plays.length === data.limit ? ` · latest ${data.limit}` : ""}`}
            </span>
            <button className="btn" onClick={onClose}>
              Close
            </button>
          </div>
        </div>

        {error ? (
          <p className="empty" style={{ padding: 0 }}>
            Couldn’t load the play timeline for this content.
          </p>
        ) : loading && !data ? (
          <p className="empty" style={{ padding: 0 }}>
            Loading…
          </p>
        ) : plays.length === 0 ? (
          <p className="empty" style={{ padding: 0 }}>
            No plays yet for this content.
          </p>
        ) : (
          <>
            <div className="leg" style={{ marginBottom: 10 }}>
              <span>
                <i style={{ background: "var(--ok)", borderRadius: "50%" }}></i>Completed
              </span>
              <span>
                <i style={{ background: "var(--bad)", borderRadius: "50%" }}></i>Partial (cut short)
              </span>
            </div>
            <div className="log log-scroll">
              {plays.map((p) => (
                <div key={p.id}>
                  <time>
                    <span
                      className="dot"
                      style={{ background: p.completed ? "var(--ok)" : "var(--bad)" }}
                      title={p.completed ? "Completed" : "Partial"}
                    ></span>
                    {new Date(p.started_at * 1000).toLocaleString()}
                  </time>
                  <p>
                    <strong>{p.device_name}</strong> · played {playLength(p.duration_sec)}
                    <span
                      className={`plain ${p.completed ? "p-ok" : "p-bad"}`}
                      style={{ marginLeft: 8 }}
                    >
                      {p.completed ? "Completed" : "Partial"}
                    </span>
                  </p>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
