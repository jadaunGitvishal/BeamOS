import { useCallback, useEffect } from "react";
import { useParams } from "react-router-dom";
import { useApi } from "../hooks/useApi";
import { usePeriod } from "../hooks/usePeriod";
import { useBreadcrumb } from "../hooks/useBreadcrumb";
import { apiFetch } from "../lib/api";
import { n0, periodWindow, periodLabel, isoDateOnly } from "../lib/format";
import { isWeakSignal } from "../lib/risk";
import { buildStatusStrip } from "../lib/transmissionStrip";
import StatTile from "../components/StatTile";
import StatusTag from "../components/StatusTag";
import TransmissionStrip from "../components/TransmissionStrip";
import { DetailScreenshot } from "../components/DeviceScreenshot";

export default function DeviceDetailView() {
  const { id } = useParams();
  const { period } = usePeriod();
  const { setDeviceCrumbName } = useBreadcrumb();

  useEffect(() => {
    setDeviceCrumbName(null); // reset to the "Device" placeholder on every id/nav change
  }, [id, setDeviceCrumbName]);

  const fetcher = useCallback(
    async ({ signal }) => {
      const { start, end } = periodWindow(period);
      const startISO = start.toISOString(),
        endISO = end.toISOString();
      const [devices, history, uptimeRows, availRows] = await Promise.all([
        apiFetch("/api/dashboard/devices", { signal }),
        apiFetch(`/api/dashboard/devices/${encodeURIComponent(id)}/status-history?start=${encodeURIComponent(startISO)}&end=${encodeURIComponent(endISO)}`, {
          signal,
        }),
        apiFetch(`/api/dashboard/reports/uptime?device_id=${encodeURIComponent(id)}&start=${encodeURIComponent(startISO)}&end=${encodeURIComponent(isoDateOnly(end))}`, {
          signal,
        }),
        apiFetch(`/api/dashboard/reports/availability?start=${isoDateOnly(start)}&end=${isoDateOnly(end)}`, { signal }),
      ]);
      return { devices, history, uptimeRows, availRows, start, end };
    },
    [period, id],
  );

  const { data, error } = useApi(fetcher, { pollMs: 15000, deps: [period, id] });

  const device = data?.devices.find((x) => x.id === id);

  useEffect(() => {
    if (device) setDeviceCrumbName(device.name);
  }, [device, setDeviceCrumbName]);

  if (error) {
    return (
      <div className="card">
        <h2>Something went wrong</h2>
        <p style={{ margin: "6px 0 0", fontSize: 12.5, color: "var(--ink2)" }}>{error.message}</p>
      </div>
    );
  }
  if (!data) return <p className="sub">Loading…</p>;
  if (!device) return <h1>Device not found</h1>;

  const d = device;
  const { history, uptimeRows, availRows, start, end } = data;
  const uptimeRow = uptimeRows[0];
  const availRow = availRows.find((a) => a.device_id === id);
  const segs = buildStatusStrip(history, start.getTime(), end.getTime());

  return (
    <>
      <div className="pt">
        <div>
          <h1>{d.name}</h1>
          <p className="sub" style={{ margin: "2px 0 0" }}>
            Device ID <span className="mono">{d.id}</span>
          </p>
        </div>
        <StatusTag status={d.status} />
      </div>

      {d.screenshot_path ? (
        <div className="card mt22">
          <div className="ch">
            <h2>Latest screenshot</h2>
            <span className="hint">{d.screenshot_at ? "captured " + new Date(d.screenshot_at * 1000).toLocaleString() : ""}</span>
          </div>
          <DetailScreenshot deviceId={d.id} />
        </div>
      ) : null}

      <div className="grid g4 mt16">
        <StatTile
          label="Battery"
          value={d.battery_level !== null && d.battery_level !== undefined ? d.battery_level + "%" + (d.battery_charging ? " ⚡" : "") : "—"}
          card
        />
        <StatTile
          label="Storage free"
          value={d.storage_free_mb !== null && d.storage_free_mb !== undefined ? n0(d.storage_free_mb) + " MB" : "—"}
          sub={d.storage_total_mb ? "of " + n0(d.storage_total_mb) + " MB" : null}
          card
        />
        <StatTile
          label="RAM free"
          value={d.ram_free_mb !== null && d.ram_free_mb !== undefined ? n0(d.ram_free_mb) + " MB" : "—"}
          sub={d.ram_total_mb ? "of " + n0(d.ram_total_mb) + " MB" : null}
          card
        />
        <StatTile
          label="Wi-Fi signal"
          value={d.wifi_rssi !== null && d.wifi_rssi !== undefined ? d.wifi_rssi + " dBm" : "—"}
          sub={isWeakSignal(d) ? "weak" : d.wifi_ssid || null}
          card
        />
      </div>

      <div className="card mt16">
        <div className="ch">
          <h2>Status history — {periodLabel(period)}</h2>
          <div className="leg">
            <span>
              <i style={{ background: "var(--on)" }}></i>Online
            </span>
            <span>
              <i style={{ background: "var(--off)" }}></i>Offline
            </span>
            <span>
              <i style={{ background: "var(--line-soft)" }}></i>No data
            </span>
          </div>
        </div>
        <TransmissionStrip segments={segs} />
        <div className="axis">
          <span>{start.toLocaleString()}</span>
          <span>now</span>
        </div>
      </div>

      <div className="grid g2 mt16">
        <div className="card">
          <div className="ch">
            <h2>Reliability</h2>
            <span className="hint">two independent estimates</span>
          </div>
          <StatTile
            label="Heartbeat uptime"
            value={uptimeRow ? uptimeRow.estimated_uptime_pct + "%" : "no data"}
            sub={uptimeRow ? `${n0(uptimeRow.heartbeat_count)} heartbeats` : null}
          />
          <div className="mt16">
            <StatTile
              label="Daily-rollup availability"
              value={availRow ? availRow.avg_availability_pct + "%" : "no data"}
              sub={availRow ? `${availRow.days_counted} day(s) counted` : null}
            />
          </div>
        </div>
        <div className="card">
          <div className="ch">
            <h2>Recent status changes</h2>
            <span className="hint">{history.length} in window</span>
          </div>
          <div className="log">
            {history.length ? (
              history
                .slice(-20)
                .reverse()
                .map((h, i) => (
                  <div key={i}>
                    <time>{new Date(h.timestamp * 1000).toLocaleString()}</time>
                    <p>Went {h.status}.</p>
                  </div>
                ))
            ) : (
              <p className="empty" style={{ padding: 0 }}>
                No status changes recorded in this window.
              </p>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
