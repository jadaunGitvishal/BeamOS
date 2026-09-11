// Ref 45 Stage B (final piece) — RAM/CPU/battery-temperature trend charts for
// Device Detail. `rows` is the ASC-ordered array from
// GET /api/dashboard/devices/:id/telemetry-history: [{ reported_at, ram_free_mb,
// ram_total_mb, cpu_usage, battery_temperature_c }].
//
// Three SEPARATE small line charts, not one combined chart — RAM (MB), CPU (%),
// and temperature (°C) have very different scales/units, so one shared y-axis
// would either flatten two of the three lines or need a confusing dual-axis.
// Same charting approach as OverviewView's "Fleet uptime trend" (recharts
// LineChart in a fixed-height ResponsiveContainer, category-style x-axis with a
// tickFormatter) — no new library or pattern introduced.
//
// Each chart gates independently, not just the section as a whole: RAM/CPU have
// been captured since early telemetry work, but battery_temperature_c is brand
// new (Ref 45 Stage A) - a device that hasn't reported since that shipped has
// real RAM/CPU history and zero temperature history at the same time. A single
// blanket "not enough data" gate would either hide RAM/CPU charts that DO have
// data, or silently render a broken/flat temperature line.

import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip } from "recharts";
import { fmtTime } from "../lib/format";

const MIN_POINTS = 2;

function MiniChart({ title, unit, points, valueKey, decimals, color }) {
  const data = points.filter((p) => p[valueKey] !== null && p[valueKey] !== undefined);
  return (
    <div className="card">
      <div className="ch">
        <h2>{title}</h2>
        <span className="hint">{unit}</span>
      </div>
      {data.length < MIN_POINTS ? (
        <p className="empty" style={{ padding: 0 }}>
          Not enough {title.toLowerCase()} history yet — check back once this device has reported a few more readings.
        </p>
      ) : (
        <div style={{ width: "100%", height: 160 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 8, right: 10, bottom: 0, left: 4 }}>
              <XAxis
                dataKey="reported_at"
                tickFormatter={fmtTime}
                tick={{ fontSize: 10, fill: "var(--ink3)" }}
                tickMargin={6}
                interval="preserveStartEnd"
                minTickGap={24}
              />
              <YAxis
                tick={{ fontSize: 10, fill: "var(--ink3)" }}
                tickMargin={4}
                width={40}
                allowDecimals={decimals}
              />
              <Tooltip
                labelFormatter={fmtTime}
                formatter={(v) => [decimals ? Number(v).toFixed(1) : n0Local(v), title]}
                contentStyle={{ fontSize: 11, borderRadius: 8, border: "1px solid var(--line)" }}
              />
              <Line type="monotone" dataKey={valueKey} stroke={color} strokeWidth={2} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

// Local, tiny (avoids importing n0's en-IN locale grouping into a chart tooltip
// where it'd read oddly for MB values) - just rounds.
function n0Local(v) {
  return Math.round(v).toLocaleString();
}

export default function TelemetryHistory({ rows }) {
  if (rows === null) {
    return (
      <p className="empty" style={{ padding: 0 }}>
        Telemetry history isn’t available for this device.
      </p>
    );
  }
  if (!rows.length) {
    return (
      <p className="empty" style={{ padding: 0 }}>
        No telemetry history yet — this device hasn’t reported in, or was just paired.
      </p>
    );
  }

  return (
    <div className="grid g3">
      <MiniChart title="RAM free" unit="MB" points={rows} valueKey="ram_free_mb" decimals={false} color="var(--accent)" />
      <MiniChart title="CPU usage" unit="%" points={rows} valueKey="cpu_usage" decimals={true} color="var(--accent)" />
      <MiniChart title="Battery temperature" unit="°C" points={rows} valueKey="battery_temperature_c" decimals={true} color="var(--accent)" />
    </div>
  );
}
