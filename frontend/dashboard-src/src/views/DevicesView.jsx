import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useApi } from "../hooks/useApi";
import { useSession } from "../hooks/useSession";
import { apiFetch } from "../lib/api";
import { isAtRisk, isWeakSignal } from "../lib/risk";
import DeviceTile from "../components/DeviceTile";
import DeviceTable from "../components/DeviceTable";

const fetchDevices = ({ signal }) => apiFetch("/api/dashboard/devices", { signal });

// Authenticated download, not a plain <a href> - export needs the Bearer
// token, which only fetch() can attach (a bare link can't set headers).
// Same fetch -> blob -> synthetic-<a>-click pattern as BeamOS's own
// frontend/js/views/reports.js export button.
async function downloadDevices(format) {
  const token = localStorage.getItem("token");
  const resp = await fetch(`/api/dashboard/devices/export?format=${format}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!resp.ok) return;
  const blob = await resp.blob();
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `devices-${new Date().toISOString().slice(0, 10)}.${format}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.URL.revokeObjectURL(url);
}

export default function DevicesView() {
  const { setDeviceCount } = useSession();
  const [searchParams, setSearchParams] = useSearchParams();

  const view = searchParams.get("view") === "table" ? "table" : "tiles";
  const urlSearch = searchParams.get("q") || "";
  const riskOnly = searchParams.get("risk") === "1";

  const [inputValue, setInputValue] = useState(urlSearch);
  useEffect(() => setInputValue(urlSearch), [urlSearch]);

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

  // Debounced URL update — matches the vanilla 260ms debounce before the
  // ?q= hash param changes (kept for bookmark/back-button parity). Unlike
  // the vanilla version, the input itself is a normal controlled React
  // input that never unmounts, so no manual focus/cursor restoration is
  // needed here.
  useEffect(() => {
    if (inputValue === urlSearch) return;
    const t = setTimeout(() => {
      const next = new URLSearchParams(searchParams);
      next.set("q", inputValue);
      setSearchParams(next, { replace: true });
    }, 260);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputValue]);

  const { data: devices } = useApi(fetchDevices, { pollMs: 15000 });

  useEffect(() => {
    if (devices) setDeviceCount(devices.length);
  }, [devices, setDeviceCount]);

  if (!devices) return <p className="sub">Loading…</p>;

  const search = urlSearch.toLowerCase();
  const list = devices.filter(
    (d) => (!search || d.name.toLowerCase().includes(search)) && (!riskOnly || isAtRisk(d) || isWeakSignal(d)),
  );

  const qparam = urlSearch ? `&q=${encodeURIComponent(urlSearch)}` : "";
  const rparam = riskOnly ? "&risk=1" : "";

  return (
    <>
      <div className="pt">
        <h1>Screens</h1>
        <span className="stamp">
          {list.length} of {devices.length} devices
        </span>
      </div>
      <p className="sub">What each device is reporting right now.</p>

      <div className="ctl mb10">
        <div className="seg" role="group" aria-label="View">
          <button
            className={view === "tiles" ? "on" : ""}
            onClick={() => setSearchParams(new URLSearchParams(`view=tiles${qparam}${rparam}`))}
          >
            Tiles
          </button>
          <button
            className={view === "table" ? "on" : ""}
            onClick={() => setSearchParams(new URLSearchParams(`view=table${qparam}${rparam}`))}
          >
            Table
          </button>
        </div>
        <input
          className="srch"
          placeholder="Find a device"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
        />
        <button
          className={`btn ${riskOnly ? "dark" : ""}`}
          onClick={() =>
            setSearchParams(new URLSearchParams(`view=${view}${qparam}${riskOnly ? "" : "&risk=1"}`))
          }
        >
          At risk or weak signal only
        </button>
        <div className="export-menu-wrap" ref={exportRef}>
          <button className="btn" onClick={() => setExportOpen((v) => !v)} aria-haspopup="true" aria-expanded={exportOpen}>
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
                    downloadDevices(format);
                  }}
                >
                  {format.toUpperCase()}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {!list.length ? (
        <div className="card">
          <p className="empty" style={{ padding: 0 }}>
            No devices match.
          </p>
        </div>
      ) : view === "tiles" ? (
        <div className="tiles">
          {list.map((d) => (
            <DeviceTile key={d.id} device={d} />
          ))}
        </div>
      ) : (
        <DeviceTable devices={list} />
      )}
    </>
  );
}
