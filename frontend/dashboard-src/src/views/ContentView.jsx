import { useCallback, useEffect, useRef, useState } from "react";
import { useApi } from "../hooks/useApi";
import { usePeriod } from "../hooks/usePeriod";
import { apiFetch } from "../lib/api";
import { n0, cPill, formatDuration, periodWindow, periodLabel } from "../lib/format";
import StatTile from "../components/StatTile";

// Authenticated download, not a plain <a href> - export needs the Bearer
// token, which only fetch() can attach. Same fetch -> blob -> synthetic-<a>-click
// pattern as DevicesView.jsx's downloadDevices.
async function downloadContent(format, startISO) {
  const token = localStorage.getItem("token");
  const resp = await fetch(
    `/api/dashboard/content/export?format=${format}&start=${encodeURIComponent(startISO)}`,
    { headers: token ? { Authorization: `Bearer ${token}` } : {} },
  );
  if (!resp.ok) return;
  const blob = await resp.blob();
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `content-${new Date().toISOString().slice(0, 10)}.${format}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.URL.revokeObjectURL(url);
}

export default function ContentView() {
  const { period } = usePeriod();

  const [exportOpen, setExportOpen] = useState(false);
  const exportRef = useRef(null);
  useEffect(() => {
    if (!exportOpen) return;
    const onClick = (e) => {
      if (exportRef.current && !exportRef.current.contains(e.target)) setExportOpen(false);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [exportOpen]);

  const fetcher = useCallback(
    async ({ signal }) => {
      const { start } = periodWindow(period);
      const { content } = await apiFetch(`/api/dashboard/content?start=${encodeURIComponent(start.toISOString())}`, {
        signal,
      });
      return content;
    },
    [period],
  );

  const { data: content, error } = useApi(fetcher, { pollMs: 300000, deps: [period] });

  if (error) {
    return (
      <div className="card">
        <h2>Something went wrong</h2>
        <p style={{ margin: "6px 0 0", fontSize: 12.5, color: "var(--ink2)" }}>{error.message}</p>
      </div>
    );
  }
  if (!content) return <p className="sub">Loading…</p>;

  const totalPlays = content.reduce((a, c) => a + c.plays, 0);
  const totalCompleted = content.reduce((a, c) => a + (c.completed_plays || 0), 0);
  const overallPct = totalPlays ? (totalCompleted / totalPlays) * 100 : null;

  return (
    <>
      <div className="pt">
        <h1>Content delivery</h1>
        <span className="stamp">
          {content.length} content item(s) · {periodLabel(period)}
        </span>
      </div>
      <p className="sub">Delivery measured against plays logged for each piece of content in this period.</p>

      <div className="ctl mb10" style={{ justifyContent: "flex-end" }}>
        <div className="export-menu-wrap" ref={exportRef}>
          <button
            className="btn"
            onClick={() => setExportOpen((v) => !v)}
            aria-haspopup="true"
            aria-expanded={exportOpen}
          >
            Export
          </button>
          {exportOpen && (
            <div className="export-menu" role="menu">
              {["csv", "xlsx", "pdf"].map((format) => (
                <button
                  key={format}
                  role="menuitem"
                  onClick={() => {
                    setExportOpen(false);
                    downloadContent(format, periodWindow(period).start.toISOString());
                  }}
                >
                  {format.toUpperCase()}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="grid g4">
        <StatTile label="Total plays" value={n0(totalPlays)} card />
        <StatTile label="Completed plays" value={n0(totalCompleted)} card />
        <StatTile label="Overall completion" value={overallPct !== null ? overallPct.toFixed(1) + "%" : "—"} card />
        <StatTile label="Content items" value={n0(content.length)} card />
      </div>

      <div className="sec">
        <h2>Content</h2>
        <div className="card pad0">
          {content.length ? (
            <table>
              <thead>
                <tr>
                  <th>Content</th>
                  <th className="r">Plays</th>
                  <th className="r">Completed</th>
                  <th className="r">Completion</th>
                  <th className="r">Watch time</th>
                </tr>
              </thead>
              <tbody>
                {content.map((c, i) => (
                  <tr key={c.content_id || i}>
                    <td className="trunc" style={{ fontWeight: 500 }}>
                      {c.content_name || c.content_id || "—"}
                    </td>
                    <td className="r num">{n0(c.plays)}</td>
                    <td className="r num">{n0(c.completed_plays || 0)}</td>
                    <td className="r">
                      {c.completion_pct !== null ? (
                        <span className={`plain ${cPill(c.completion_pct)}`}>{c.completion_pct.toFixed(1)}%</span>
                      ) : (
                        <span style={{ color: "var(--ink3)" }}>—</span>
                      )}
                    </td>
                    <td className="r mono">{formatDuration(c.total_seconds)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="empty">No plays in this period.</p>
          )}
        </div>
      </div>
    </>
  );
}
