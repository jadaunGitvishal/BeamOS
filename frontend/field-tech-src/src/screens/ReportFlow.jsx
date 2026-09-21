import { useState } from "react";
import { apiPost, setToken, NetworkError, ApiError } from "../lib/api.js";

// Ref 75 Stage A: the management report-viewing flow, parallel to VisitFlow.jsx
// (same workspace-picker step and switch-workspace call - deliberately NOT
// extracted into a shared component, since everything AFTER picking a
// workspace diverges completely between the two flows). Read-only: unlike
// VisitFlow there is no write path here at all, matching workspace_viewer's
// actual permission level.
//
// Stage A ships only the workspace picker + a placeholder body so Stage 1 of
// Ref 75 can be verified end-to-end (login -> correct routing -> workspace
// selection) before Stage B fills in the three real report views (Uptime,
// SLA status, Proof-of-play).
export default function ReportFlow({ me, onLogout, onSessionExpired }) {
  const workspaces = (me?.accessible_workspaces || [])
    .slice()
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""));

  const [step, setStep] = useState("workspaces"); // "workspaces" | "reports"
  const [activeWs, setActiveWs] = useState(null);
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
      // Same call VisitFlow.jsx's pickWorkspace makes: mints a fresh JWT with
      // this workspace baked in as current_workspace_id, so every workspace-
      // scoped report endpoint below resolves tenancy off the token alone.
      const res = await apiPost("/api/auth/switch-workspace", { workspace_id: ws.id });
      if (res.token) setToken(res.token);
      setActiveWs(ws);
      setStep("reports");
    } catch (err) {
      handleErr(err, "Could not open that workspace.");
    } finally {
      setBusy(false);
    }
  }

  function restart() {
    setActiveWs(null);
    setError("");
    setStep("workspaces");
  }

  return (
    <main className="screen">
      <div className="card">
        <h1 className="brand">CXO1<span>.ai</span> · Reports</h1>

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

        {step === "reports" && activeWs && (
          <>
            <button className="back" type="button" onClick={restart}>‹ Workspaces</button>
            <p className="step-title">{activeWs.name}</p>
            <p className="muted">Report views (Uptime, SLA status, Proof-of-play) are coming in Stage 2.</p>
            <button className="button button--secondary" type="button" onClick={onLogout}>Log out</button>
          </>
        )}
      </div>
    </main>
  );
}
