import { useCallback, useEffect } from "react";
import { useParams } from "react-router-dom";
import { useApi } from "../hooks/useApi";
import { usePeriod } from "../hooks/usePeriod";
import { useBreadcrumb } from "../hooks/useBreadcrumb";
import { apiFetch, UnauthenticatedError } from "../lib/api";
import { n0, periodWindow, periodLabel, isoDateOnly, fmtCoords, osmUrl, timeAgo } from "../lib/format";
import { isWeakSignal } from "../lib/risk";
import { buildStatusStrip } from "../lib/transmissionStrip";
import StatTile from "../components/StatTile";
import StatusTag from "../components/StatusTag";
import TransmissionStrip from "../components/TransmissionStrip";
import { DetailScreenshot } from "../components/DeviceScreenshot";
import AuditTrail from "../components/AuditTrail";
import StatusHeatmap from "../components/StatusHeatmap";
import FieldVisits from "../components/FieldVisits";

// Ref 31: render one captured hardware field. The device deliberately sends an
// honest marker string ("unavailable (requires Device Owner)", "no SIM hardware",
// …) rather than a blank, so we only dim those and the never-captured (null) case
// — a real value shows normally.
function hwCell(value) {
  if (value === null || value === undefined || value === "") {
    return <dd className="hw-na">Not captured yet</dd>;
  }
  const s = String(value);
  const isMarker = /^(unavailable|no SIM|NO_TELEPHONY|UNKNOWN$)/i.test(s);
  return <dd className={isMarker ? "hw-na" : undefined}>{s}</dd>;
}

function HardwareCard({ d }) {
  const anyCaptured =
    d.hardware_captured_at ||
    [d.manufacturer, d.model, d.mac_address, d.serial_number, d.sim_provider, d.sim_network_status].some(
      (v) => v !== null && v !== undefined && v !== "",
    );
  return (
    <div className="card mt16">
      <div className="ch">
        <h2>Hardware</h2>
        <span className="hint">
          {d.hardware_captured_at
            ? "captured " + timeAgo(d.hardware_captured_at)
            : anyCaptured
              ? "reported by the device"
              : "not reported — device predates this, or hasn’t re-registered"}
        </span>
      </div>
      <dl className="hw-kv">
        <dt>Make</dt>
        {hwCell(d.manufacturer)}
        <dt>Model</dt>
        {hwCell(d.model)}
        <dt>Display size</dt>
        {d.display_size_inches ? <dd>{d.display_size_inches}″ diagonal</dd> : <dd className="hw-na">Unavailable</dd>}
        <dt>Resolution</dt>
        {d.screen_width && d.screen_height ? (
          <dd>
            {d.screen_width}×{d.screen_height}
            {d.render_width && d.render_height && (d.render_width !== d.screen_width || d.render_height !== d.screen_height)
              ? ` (rendering ${d.render_width}×${d.render_height})`
              : ""}
          </dd>
        ) : (
          <dd className="hw-na">Not captured yet</dd>
        )}
        <dt>MAC address</dt>
        {hwCell(d.mac_address)}
        <dt>Serial number</dt>
        {hwCell(d.serial_number)}
        <dt>SIM status</dt>
        {hwCell(d.sim_network_status)}
        <dt>SIM provider</dt>
        {hwCell(d.sim_provider)}
        <dt>SIM ICCID</dt>
        {hwCell(d.sim_iccid)}
      </dl>
    </div>
  );
}

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
      // Phase 2 Stage C: the audit trail + heatmap must degrade to null on a 403
      // (or any non-auth failure) so the rest of the detail page still renders.
      const softFail = (e) => {
        if (e instanceof UnauthenticatedError || e.name === "AbortError") throw e;
        return null;
      };
      // devices first — the field-visit list route is keyed by the device's
      // workspace_id, which only the /api/dashboard/devices row carries.
      const devices = await apiFetch("/api/dashboard/devices", { signal });
      const wsId = devices.find((x) => x.id === id)?.workspace_id;
      const [history, uptimeRows, availRows, trail, heatmap, visits] = await Promise.all([
        apiFetch(`/api/dashboard/devices/${encodeURIComponent(id)}/status-history?start=${encodeURIComponent(startISO)}&end=${encodeURIComponent(endISO)}`, {
          signal,
        }),
        apiFetch(`/api/dashboard/reports/uptime?device_id=${encodeURIComponent(id)}&start=${encodeURIComponent(startISO)}&end=${encodeURIComponent(isoDateOnly(end))}`, {
          signal,
        }),
        apiFetch(`/api/dashboard/reports/availability?start=${isoDateOnly(start)}&end=${isoDateOnly(end)}`, { signal }),
        apiFetch(`/api/dashboard/devices/${encodeURIComponent(id)}/audit-trail?limit=60`, { signal }).catch(softFail),
        apiFetch(`/api/dashboard/devices/${encodeURIComponent(id)}/status-heatmap?days=7`, { signal }).catch(softFail),
        // Ref 43 Stage C: field-visit history. Any workspace member can read
        // (Stage A GET routes are canAccessWorkspace-scoped); soft-fail so an
        // unexpected error never blanks the rest of the page.
        wsId
          ? apiFetch(`/api/workspaces/${encodeURIComponent(wsId)}/field-visits?device_id=${encodeURIComponent(id)}`, { signal }).catch(softFail)
          : Promise.resolve(null),
      ]);
      return { devices, history, uptimeRows, availRows, trail, heatmap, visits, wsId, start, end };
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
  const { history, uptimeRows, availRows, trail, heatmap, visits, wsId, start, end } = data;
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
          label="CPU usage"
          value={d.cpu_usage !== null && d.cpu_usage !== undefined ? Number(d.cpu_usage).toFixed(1) + "%" : "—"}
          card
        />
        {/* Ref 45 Stage A: labeled specifically as battery temperature, not "CPU
            temperature" or a generic "internal temperature" - Android exposes no
            generic SoC thermal sensor via public API, so battery temp (the one real
            signal the player can read) is what this honestly is. */}
        <StatTile
          label="Battery temperature"
          value={
            d.battery_temperature_c !== null && d.battery_temperature_c !== undefined
              ? Number(d.battery_temperature_c).toFixed(1) + "°C"
              : "—"
          }
          card
        />
        <StatTile
          label="Wi-Fi signal"
          value={d.wifi_rssi !== null && d.wifi_rssi !== undefined ? d.wifi_rssi + " dBm" : "—"}
          sub={isWeakSignal(d) ? "weak" : d.wifi_ssid || null}
          card
        />
        <StatTile
          label="Location"
          value={
            fmtCoords(d.latitude, d.longitude) ? (
              <a href={osmUrl(d.latitude, d.longitude)} target="_blank" rel="noopener noreferrer">
                {fmtCoords(d.latitude, d.longitude)}
              </a>
            ) : (
              "—"
            )
          }
          card
        />
        {/* App / Android version are peers (app updates vs OS move
            independently), so two tiles rather than one combined — matching the
            one-metric-per-tile pattern of the tiles above. */}
        <StatTile label="App version" value={d.app_version || "—"} card />
        <StatTile label="Android version" value={d.android_version || "—"} card />
      </div>

      <HardwareCard d={d} />

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

      <div className="card mt16">
        <div className="ch">
          <h2>Online / offline heatmap — last 7 days</h2>
          <span className="hint">hour-by-hour, from the status log</span>
        </div>
        <StatusHeatmap heatmap={heatmap} />
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
            <h2>Audit trail</h2>
            <span className="hint">{trail ? `${trail.length} recent` : "unavailable"}</span>
          </div>
          <AuditTrail trail={trail} />
        </div>
      </div>

      <div className="card mt16">
        <div className="ch">
          <h2>Field visits</h2>
          <span className="hint">{visits ? `${visits.length} recorded` : "unavailable"}</span>
        </div>
        <FieldVisits visits={visits} workspaceId={wsId || d.workspace_id} />
      </div>
    </>
  );
}
