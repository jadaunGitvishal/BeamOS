// Small bar-chart card for comparing a handful of named categories. Same
// recharts styling as the Overview "Fleet uptime trend" / TelemetryHistory
// line charts (10px ink3 ticks, 11px tooltip, var(--line) borders).
//
//   <CategoryBarChart title="SLA attention" hint="open tickets"
//     data={[{ label: "Breached", value: 3, color: "var(--bad)" }, ...]} />
//
// `color` per item is optional (defaults to the accent). `layout="horizontal"`
// draws bars left-to-right with labels down the side — better for long names.
// `unit` is appended to values ("%"); `domain` overrides the value axis.

import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Cell, LabelList } from "recharts";

export default function CategoryBarChart({
  data,
  title,
  hint,
  unit = "",
  layout = "vertical",
  height = 170,
  domain,
  className = "",
}) {
  const rows = (data || []).map((d) => ({ ...d, value: d.value == null ? null : Number(d.value) }));
  const horizontal = layout === "horizontal";
  const fmt = (v) => (v == null ? "—" : `${v}${unit}`);
  const valueAxis = {
    type: "number",
    domain: domain || [0, "auto"],
    tick: { fontSize: 10, fill: "var(--ink3)" },
    tickMargin: 4,
    allowDecimals: false,
    unit,
    axisLine: false,
    tickLine: false,
  };
  const catAxis = {
    type: "category",
    dataKey: "label",
    tick: { fontSize: 10, fill: "var(--ink3)" },
    tickMargin: 6,
    interval: 0,
    axisLine: { stroke: "var(--line)" },
    tickLine: false,
  };

  return (
    <div className={`card ${className}`.trim()}>
      {title || hint ? (
        <div className="ch">
          {title ? <h2>{title}</h2> : null}
          {hint ? <span className="hint">{hint}</span> : null}
        </div>
      ) : null}
      <div style={{ width: "100%", height }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={rows}
            layout={horizontal ? "vertical" : "horizontal"}
            margin={{ top: 14, right: horizontal ? 36 : 8, bottom: 0, left: 4 }}
            barCategoryGap="28%"
          >
            <CartesianGrid
              stroke="var(--line-soft)"
              vertical={horizontal}
              horizontal={!horizontal}
            />
            {horizontal ? (
              <>
                <XAxis {...valueAxis} />
                <YAxis {...catAxis} width={96} />
              </>
            ) : (
              <>
                <XAxis {...catAxis} />
                <YAxis {...valueAxis} width={40} />
              </>
            )}
            <Tooltip
              cursor={{ fill: "var(--line-soft)" }}
              formatter={(v) => [fmt(v), title || "Value"]}
              contentStyle={{ fontSize: 11, borderRadius: 8, border: "1px solid var(--line)" }}
            />
            <Bar
              dataKey="value"
              radius={horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]}
              maxBarSize={44}
              isAnimationActive={false}
            >
              {rows.map((d) => (
                <Cell key={d.label} fill={d.color || "var(--accent)"} />
              ))}
              <LabelList
                dataKey="value"
                position={horizontal ? "right" : "top"}
                formatter={fmt}
                style={{ fontSize: 10, fill: "var(--ink2)" }}
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
