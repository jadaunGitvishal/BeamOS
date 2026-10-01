import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import Breadcrumb from "./Breadcrumb";
import PeriodSelector from "./PeriodSelector";
import WorkspaceSwitcher from "./WorkspaceSwitcher";
import { usePeriod } from "../hooks/usePeriod";
import { periodWindow, isoDateOnly } from "../lib/format";

// Authenticated download of the Overview report for the selected period -
// same fetch -> blob -> synthetic-<a>-click pattern as DevicesView's export
// (a bare link can't carry the Bearer token). `start` is date-only because
// the server's SLA rollup appends a UTC time to it.
async function downloadOverview(format, period) {
  const token = localStorage.getItem("token");
  const start = isoDateOnly(periodWindow(period).start);
  const resp = await fetch(
    `/api/dashboard/overview/export?format=${format}&start=${encodeURIComponent(start)}`,
    { headers: token ? { Authorization: `Bearer ${token}` } : {} },
  );
  if (!resp.ok) return;
  const blob = await resp.blob();
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `overview-${new Date().toISOString().slice(0, 10)}.${format}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.URL.revokeObjectURL(url);
}

// The user's email + Sign out now live in the sidebar footer (Rail.jsx),
// matching the demo — the Topbar keeps the breadcrumb, the workspace switcher
// and the period control (the one shared instance, on every page), plus
// an "Export report" menu on the Overview route only (it exports Overview's
// numbers, so it isn't a global control).
export default function Topbar() {
  const location = useLocation();
  const { period } = usePeriod();
  const onOverview = location.pathname === "/" || location.pathname === "/overview";

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

  return (
    <header className="top">
      <Breadcrumb />
      <div className="topsp"></div>
      <div className="ctl">
        <WorkspaceSwitcher />
        <PeriodSelector />
        {onOverview ? (
          <div className="export-menu-wrap" ref={exportRef}>
            <button className="btn" onClick={() => setExportOpen((v) => !v)} aria-haspopup="true" aria-expanded={exportOpen}>
              Export report ↗
            </button>
            {exportOpen && (
              <div className="export-menu" role="menu">
                {["csv", "xlsx", "pdf"].map((format) => (
                  <button
                    key={format}
                    role="menuitem"
                    onClick={() => {
                      setExportOpen(false);
                      downloadOverview(format, period);
                    }}
                  >
                    {format.toUpperCase()}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : null}
      </div>
    </header>
  );
}
