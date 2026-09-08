import { useState } from "react";
import { apiGet, apiPost, setToken, newUuid, NetworkError, ApiError } from "../lib/api.js";

// Stage B2a: pick a workspace -> switch into it -> pick a device -> start a
// visit. The visit form itself is B2b; this ends on a "visit started"
// confirmation. Steps ("workspaces" | "devices" | "visitType" | "started") are
// component state, not routes (see main.jsx).
const VISIT_TYPES = ["Routine check", "Repair", "Installation"];

export default function VisitFlow({ me, onLogout, onSessionExpired }) {
  const workspaces = (me?.accessible_workspaces || [])
    .slice()
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""));

  const [step, setStep] = useState("workspaces");
  const [activeWs, setActiveWs] = useState(null);
  const [devices, setDevices] = useState([]);
  const [activeDevice, setActiveDevice] = useState(null);
  const [visitType, setVisitType] = useState(VISIT_TYPES[0]);
  const [visitUuid, setVisitUuid] = useState(null);
  const [visit, setVisit] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function handleErr(err, fallback) {
    if (err instanceof ApiError && err.status === 401) return onSessionExpired();
    if (err instanceof NetworkError) return setError("Network error — check your connection and try again.");
    setError((err instanceof ApiError && err.message) || fallback);
  }

  async function pickWorkspace(ws) {
    if (busy) return;
    setError("");
    setBusy(true);
    try {
      const res = await apiPost("/api/auth/switch-workspace", { workspace_id: ws.id });
      if (res.token) setToken(res.token); // subsequent calls use the new active-workspace JWT
      const list = await apiGet("/api/devices");
      // GET /api/devices can return duplicate rows per device (latest-telemetry
      // join fan-out); dedupe by id so the picker shows each screen once.
      const seen = new Set();
      const uniq = [];
      for (const d of Array.isArray(list) ? list : []) {
        if (!seen.has(d.id)) { seen.add(d.id); uniq.push(d); }
      }
      uniq.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
      setActiveWs(ws);
      setDevices(uniq);
      setActiveDevice(null);
      setStep("devices");
    } catch (err) {
      handleErr(err, "Could not open that workspace.");
    } finally {
      setBusy(false);
    }
  }

  function pickDevice(d) {
    setActiveDevice(d);
    setVisitType(VISIT_TYPES[0]);
    setVisitUuid(newUuid()); // one id per attempt; reused if "Start visit" is retried
    setError("");
    setStep("visitType");
  }

  async function startVisit() {
    if (busy) return;
    setError("");
    setBusy(true);
    try {
      const res = await apiPost(`/api/workspaces/${activeWs.id}/field-visits`, {
        device_id: activeDevice.id,
        visit_type: visitType,
        client_visit_uuid: visitUuid,
      });
      setVisit(res);
      setStep("started");
    } catch (err) {
      handleErr(err, "Could not start the visit.");
    } finally {
      setBusy(false);
    }
  }

  function restart() {
    setActiveWs(null);
    setDevices([]);
    setActiveDevice(null);
    setVisit(null);
    setError("");
    setStep("workspaces");
  }

  return (
    <main className="screen">
      <div className="card">
        <h1 className="brand">BeamOS Field Tech</h1>

        {step === "workspaces" && (
          <>
            <p className="step-title">Select a workspace</p>
            {workspaces.length === 0 ? (
              <p className="muted">No workspaces are assigned to you yet. Ask your admin.</p>
            ) : (
              <ul className="list">
                {workspaces.map((w) => (
                  <li key={w.id}>
                    <button className="row" type="button" disabled={busy} onClick={() => pickWorkspace(w)}>
                      <span className="row__title">{w.name}</span>
                      <span className="row__meta">
                        {w.organization_name ? `${w.organization_name} · ` : ""}
                        {w.device_count ?? 0} device{(w.device_count ?? 0) === 1 ? "" : "s"}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {error && <p className="error" role="alert">{error}</p>}
            {busy && <p className="muted">Opening…</p>}
            <button className="button button--secondary" type="button" onClick={onLogout}>Log out</button>
          </>
        )}

        {step === "devices" && (
          <>
            <button className="back" type="button" onClick={() => setStep("workspaces")}>‹ Workspaces</button>
            <p className="step-title">{activeWs?.name}</p>
            <p className="step-sub">Pick the device you're at</p>
            {devices.length === 0 ? (
              <p className="muted">No devices in this workspace yet.</p>
            ) : (
              <ul className="list">
                {devices.map((d) => (
                  <li key={d.id}>
                    <button className="row" type="button" onClick={() => pickDevice(d)}>
                      <span className="row__title">{d.name || "Unnamed device"}</span>
                      <span className={`tag tag--${d.status === "online" ? "ok" : "off"}`}>{d.status || "unknown"}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {error && <p className="error" role="alert">{error}</p>}
          </>
        )}

        {step === "visitType" && (
          <>
            <button className="back" type="button" onClick={() => setStep("devices")}>‹ Devices</button>
            <p className="step-title">Start a visit</p>
            <dl className="kv">
              <dt>Workspace</dt><dd>{activeWs?.name}</dd>
              <dt>Device</dt><dd>{activeDevice?.name || "Unnamed device"}</dd>
            </dl>
            <p className="field-label">Visit type</p>
            <div className="choice-group">
              {VISIT_TYPES.map((t) => (
                <button
                  key={t}
                  type="button"
                  className={`choice ${visitType === t ? "choice--on" : ""}`}
                  aria-pressed={visitType === t}
                  onClick={() => setVisitType(t)}
                >
                  {t}
                </button>
              ))}
            </div>
            {error && <p className="error" role="alert">{error}</p>}
            <button className="button" type="button" disabled={busy} onClick={startVisit}>
              {busy ? "Starting…" : "Start visit"}
            </button>
          </>
        )}

        {step === "started" && visit && (
          <>
            <p className="step-title">Visit started</p>
            <p className="lead">
              ID <strong>{visit.id}</strong>
            </p>
            <dl className="kv">
              <dt>Device</dt><dd>{visit.device_name || activeDevice?.name || visit.device_id}</dd>
              <dt>Type</dt><dd>{visit.visit_type}</dd>
              <dt>Status</dt><dd>{visit.status}</dd>
              <dt>Telemetry</dt>
              <dd>{visit.technical_metrics ? "snapshot captured" : "none on file"}</dd>
            </dl>
            <p className="muted">The inspection form comes next. For now the visit is open and recorded.</p>
            <button className="button" type="button" onClick={restart}>Start another visit</button>
            <button className="button button--secondary" type="button" onClick={onLogout}>Log out</button>
          </>
        )}
      </div>
    </main>
  );
}
