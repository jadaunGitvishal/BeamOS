// Ref 44 — SIM/network data-usage trend charts for Device Detail. `rows` is
// the ASC-ordered array from GET /api/dashboard/devices/:id/network-usage-history:
// [{ date, bytes_received, bytes_sent, sim_provider }]. `isDeviceOwner` is
// devices.is_device_owner, reported alongside the rest of the hardware block.
//
// Two SEPARATE small line charts (received, sent), not one chart with two
// lines — every existing trend chart in this app (Overview's "Fleet uptime
// trend", Ref 45's TelemetryHistory) is a single metric per chart; a
// two-series chart would be a new pattern this codebase hasn't used anywhere,
// so this keeps to the same one-line-per-chart shape instead. Received/sent
// DO share a unit (bytes), unlike Ref 45's RAM/CPU/temperature, so they sit
// in a 2-column grid rather than 3.
//
// Empty state is 3-way, not 1-way — deliberately, per the "can this be
// default enabled?" question this Ref exists to answer honestly:
//   - rows === null            -> fetch failed; generic "not available"
//   - !isDeviceOwner (no rows) -> the real ceiling: this device can't do
//                                 this AT ALL without Device Owner, and
//                                 that's explained, not hidden
//   - isDeviceOwner (no rows)  -> genuinely eligible, just hasn't reported
//                                 yet (freshly provisioned / first daily
//                                 check hasn't fired)
// A device that reported real data in the past keeps showing its chart even
// if is_device_owner later reads false (e.g. DO cleared) - real history
// earned earlier is never hidden by a later status change.

import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip } from "recharts";
import { fmtDate, fmtBytes } from "../lib/format";

const MIN_POINTS = 2;

function MiniChart({ title, points, valueKey, color }) {
  const data = points
    .filter((p) => p[valueKey] !== null && p[valueKey] !== undefined)
    .map((p) => ({ ...p, _mb: Number(p[valueKey]) / (1024 * 1024) }));
  return (
    <div className="card">
      <div className="ch">
        <h2>{title}</h2>
        <span className="hint">MB / day</span>
      </div>
      {data.length < MIN_POINTS ? (
        <p className="empty" style={{ padding: 0 }}>
          Not enough {title.toLowerCase()} history yet — check back after a few more daily reports.
        </p>
      ) : (
        <div style={{ width: "100%", height: 160 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 8, right: 10, bottom: 0, left: 4 }}>
              <XAxis
                dataKey="date"
                tickFormatter={fmtDate}
                tick={{ fontSize: 10, fill: "var(--ink3)" }}
                tickMargin={6}
                interval="preserveStartEnd"
                minTickGap={24}
              />
              <YAxis tick={{ fontSize: 10, fill: "var(--ink3)" }} tickMargin={4} width={44} />
              <Tooltip
                labelFormatter={fmtDate}
                formatter={(_v, _n, entry) => [fmtBytes(entry.payload[valueKey]), title]}
                contentStyle={{ fontSize: 11, borderRadius: 8, border: "1px solid var(--line)" }}
              />
              <Line type="monotone" dataKey="_mb" stroke={color} strokeWidth={2} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

export default function NetworkUsageHistory({ rows, isDeviceOwner }) {
  if (rows === null) {
    return (
      <p className="empty" style={{ padding: 0 }}>
        Network-usage history isn’t available for this device.
      </p>
    );
  }
  if (!rows.length) {
    return isDeviceOwner ? (
      <p className="empty" style={{ padding: 0 }}>
        No network-usage data yet — check back after this device’s next daily report.
      </p>
    ) : (
      // The real ceiling, not a defensive placeholder: Android has no supported way
      // for a non-Device-Owner app to read whole-device network usage (confirmed
      // against NetworkStatsManager's own docs) - there is nothing to wait for here.
      <p className="empty" style={{ padding: 0 }}>
        SIM/network data-usage monitoring requires this device to be provisioned as
        Device Owner — it isn’t supported on a non-Device-Owner install, by Android’s
        own design, not a current limitation.
      </p>
    );
  }

  return (
    <div className="grid g2">
      <MiniChart title="Data received" points={rows} valueKey="bytes_received" color="var(--accent)" />
      <MiniChart title="Data sent" points={rows} valueKey="bytes_sent" color="var(--accent)" />
    </div>
  );
}
