// Content delivery page charts, drawn from the per-content rows GET
// /api/dashboard/content already returns (plays, completed_plays,
// completion_pct).

import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";
import ProgressBar from "./ProgressBar";
import { n0, cCol } from "../lib/format";
import { contentLabel } from "../lib/content";

// Lowest completion first (ties: more plays first), so the content that most
// often stops early is at the top.
export function CompletionBars({ content, limit = 8 }) {
  const rows = (content || [])
    .filter((c) => c.completion_pct !== null)
    .sort((a, b) => a.completion_pct - b.completion_pct || b.plays - a.plays)
    .slice(0, limit);
  return (
    <div className="card panel">
      <div className="panel-head">
        <div>
          <h2>Lowest completion</h2>
          <p className="panel-note">Content that most often stops before the end, worst first.</p>
        </div>
      </div>
      {rows.length ? (
        <div className="cdel">
          {rows.map((c, i) => {
            const label = contentLabel(c);
            return (
              <div className="cdel-row" key={c.content_id || i}>
                <div className="cdel-name">
                  <span title={label}>{label}</span>
                  <small>
                    {n0(c.plays)} play{c.plays === 1 ? "" : "s"}
                  </small>
                </div>
                <ProgressBar percentage={c.completion_pct} target={90} color={cCol(c.completion_pct)} />
              </div>
            );
          })}
        </div>
      ) : (
        <p className="empty">No completion data in this period.</p>
      )}
      <p className="panel-note" style={{ margin: "12px 0 0" }}>
        Tick marks 90%. Green is 90%+, amber 75–90%, red under 75%.
      </p>
    </div>
  );
}

// Top items by plays, each bar split into completed / not completed.
export function PlaysByContent({ content, limit = 8 }) {
  const rows = [...(content || [])]
    .sort((a, b) => b.plays - a.plays)
    .slice(0, limit)
    .map((c) => {
      const full = contentLabel(c);
      const completed = c.completed_plays || 0;
      return {
        name: full.length > 22 ? `${full.slice(0, 21)}…` : full,
        full,
        completed,
        incomplete: c.plays - completed,
        pct: c.completion_pct,
      };
    });
  if (!rows.length) return null;

  return (
    <div className="card panel">
      <div className="panel-head">
        <div>
          <h2>Most played content</h2>
          <p className="panel-note">Plays per item, split into completed and not completed.</p>
        </div>
      </div>
      <div style={{ width: "100%", height: Math.max(180, rows.length * 54 + 30) }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} layout="vertical" barCategoryGap="30%" margin={{ top: 4, right: 12, bottom: 0, left: 4 }}>
            <CartesianGrid horizontal={false} stroke="var(--line-soft)" />
            <XAxis
              type="number"
              tick={{ fontSize: 10, fill: "var(--ink3)" }}
              axisLine={false}
              tickLine={false}
              allowDecimals={false}
              tickFormatter={(v) => n0(v)}
            />
            <YAxis
              type="category"
              dataKey="name"
              width={160}
              // Plain single-line <text>: Recharts' default tick wraps a label it
              // estimates is wider than the axis, splitting names over two lines.
              tick={({ x, y, payload }) => (
                <text x={x} y={y} dy={4} textAnchor="end" fontSize={11} fill="var(--ink2)">
                  {payload.value}
                </text>
              )}
              interval={0}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              cursor={{ fill: "var(--line-soft)" }}
              labelFormatter={(_, payload) => {
                const r = payload && payload[0] ? payload[0].payload : null;
                return r ? `${r.full}${r.pct !== null ? ` · ${r.pct}% completion` : ""}` : "";
              }}
              formatter={(v, key) => [n0(v), key === "completed" ? "Completed" : "Not completed"]}
              contentStyle={{ fontSize: 11, borderRadius: 8, border: "1px solid var(--line)" }}
            />
            <Bar dataKey="completed" stackId="p" fill="var(--on)" isAnimationActive={false} />
            <Bar dataKey="incomplete" stackId="p" fill="var(--off)" radius={[0, 3, 3, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="ch-legend">
        <span>
          <i style={{ background: "var(--on)" }} /> Completed
        </span>
        <span>
          <i style={{ background: "var(--off)" }} /> Not completed
        </span>
      </div>
    </div>
  );
}
