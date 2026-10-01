import { useCallback, useEffect, useRef, useState } from "react";
import { useApi } from "../hooks/useApi";
import { usePeriod } from "../hooks/usePeriod";
import { apiFetch } from "../lib/api";
import { n0, cCol, formatDuration, periodWindow, periodLabel } from "../lib/format";
import { summarizeContent, contentLabel } from "../lib/content";
import KpiCard from "../components/KpiCard";
import ProgressBar from "../components/ProgressBar";
import PlayTimeline from "../components/PlayTimeline";
import { CompletionBars, PlaysByContent } from "../components/ContentCharts";

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

  // 60s to match OverviewView (which surfaces the same play_logs totals) and the
  // rest of the dashboard's live views — the previous 300000ms (5 min) left this
  // page showing plainly stale numbers next to a fresh Overview. PlayTimeline
  // polls at the same cadence, so the whole page stays coherent.
  const { data: content, error } = useApi(fetcher, { pollMs: 60000, deps: [period] });

  // Ref 50: the content row whose proof-of-play timeline is open. Cleared on a
  // period change since the row list itself is re-derived for the new window.
  const [selected, setSelected] = useState(null);
  useEffect(() => {
    setSelected(null);
  }, [period]);

  if (error) {
    return (
      <div className="card">
        <h2>Something went wrong</h2>
        <p style={{ margin: "6px 0 0", fontSize: 12.5, color: "var(--ink2)" }}>{error.message}</p>
      </div>
    );
  }
  if (!content) return <p className="sub">Loading…</p>;

  const sum = summarizeContent(content);
  const totalPlays = sum.plays;

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

      {content.length ? (
        <>
          <div className="grid g4">
            <KpiCard
              label="Total plays"
              value={n0(sum.plays)}
              subLine={`across ${n0(sum.items)} content item${sum.items === 1 ? "" : "s"}`}
              color="var(--accent)"
            />
            <KpiCard
              label="Completed plays"
              value={n0(sum.completed)}
              ofValue={n0(sum.plays)}
              subLine={`${n0(sum.incomplete)} stopped early`}
              percentage={sum.plays ? (sum.completed / sum.plays) * 100 : null}
              color="var(--on)"
            />
            <KpiCard
              label="Overall completion"
              value={sum.pct !== null ? `${sum.pct}%` : "—"}
              subLine="completed plays ÷ all plays"
              percentage={sum.pct}
              color={sum.color}
            />
            <KpiCard
              label="Weak content"
              value={n0(sum.weak)}
              ofValue={n0(sum.items)}
              subLine={sum.weak ? `under 75% completion · ${n0(sum.weakPlays)} plays` : "nothing under 75% completion"}
              percentage={sum.items ? (sum.weak / sum.items) * 100 : null}
              color={sum.weak ? "var(--bad)" : "var(--ok)"}
            />
          </div>
          <div className="grid g2 mt16 csplit">
            <CompletionBars content={content} />
            <PlaysByContent content={content} />
          </div>
        </>
      ) : null}

      <div className="sec">
        <h2>All content</h2>
        <div className="card pad0">
          {content.length ? (
            <table style={{ minWidth: 720 }}>
              <thead>
                <tr>
                  <th>Content</th>
                  <th className="r">Plays</th>
                  <th className="r">Completed</th>
                  <th style={{ minWidth: 170 }}>Completion</th>
                  <th className="r">Watch time</th>
                </tr>
              </thead>
              <tbody>
                {content.map((c, i) => {
                  const clickable = !!c.content_id;
                  const isSel = clickable && selected?.id === c.content_id;
                  return (
                  <tr
                    key={c.content_id || i}
                    className={clickable ? "click" : undefined}
                    style={isSel ? { background: "var(--line-soft)" } : undefined}
                    onClick={
                      clickable
                        ? () =>
                            setSelected((cur) =>
                              cur?.id === c.content_id
                                ? null
                                : { id: c.content_id, name: c.content_name || c.content_id },
                            )
                        : undefined
                    }
                  >
                    <td className="trunc" style={{ fontWeight: 500 }}>
                      {contentLabel(c)}
                    </td>
                    <td className="r num">
                      {n0(c.plays)}
                      {totalPlays ? (
                        <div style={{ color: "var(--ink3)", fontSize: 11, fontWeight: 400 }}>
                          {((c.plays / totalPlays) * 100).toFixed(1)}% of plays
                        </div>
                      ) : null}
                    </td>
                    <td className="r num">{n0(c.completed_plays || 0)}</td>
                    <td>
                      <ProgressBar
                        percentage={c.completion_pct}
                        color={c.completion_pct !== null ? cCol(c.completion_pct) : undefined}
                      />
                    </td>
                    <td className="r mono">{formatDuration(c.total_seconds)}</td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <p className="empty">No plays in this period.</p>
          )}
        </div>
      </div>

      {selected && <PlayTimeline content={selected} onClose={() => setSelected(null)} />}
    </>
  );
}
