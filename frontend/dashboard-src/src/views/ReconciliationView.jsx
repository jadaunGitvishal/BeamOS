import { useCallback, useState } from "react";
import { useApi } from "../hooks/useApi";
import { useSession } from "../hooks/useSession";
import { useClock } from "../hooks/useClock";
import { useToast } from "../hooks/useToast";
import { apiFetch, UnauthenticatedError } from "../lib/api";
import { n0, timeAgo } from "../lib/format";
import { reconDate, GHOST_HINT, staleHint } from "../lib/reconciliation";
import StatTile from "../components/StatTile";

// Ref 49 Stage B — the full Reconciliation view. Reads
// GET /api/dashboard/reports/reconciliation, which runs lib/reconciliation.js
// LIVE against the current workspace on every request (polled 60s + on mount),
// so it never waits for the scheduled email. Ghost = registered but never
// reported; stale = reported before but silent for `stale_after_days`+ days.
//
// A platform admin can change how often the scheduled report emails
// (reconciliation_frequency_days) inline here — the only place it's surfaced in
// the dashboard — via PUT /api/admin/reconciliation-frequency.

async function saveFrequency(days) {
  const resp = await fetch("/api/admin/reconciliation-frequency", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${localStorage.getItem("token")}`,
    },
    body: JSON.stringify({ frequency_days: days }),
  });
  if (resp.status === 401) throw new UnauthenticatedError();
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(json.error || `PUT -> ${resp.status}`);
  return json;
}

export default function ReconciliationView() {
  const { me } = useSession();
  const asof = useClock();
  const { toast } = useToast();
  const wsId = me?.current_workspace_id || null;
  const wsName = me?.current_workspace?.name || "";
  const isAdmin = !!me?.is_platform_admin;

  const [refreshKey, setRefreshKey] = useState(0);
  const [freqDraft, setFreqDraft] = useState("");
  const [savingFreq, setSavingFreq] = useState(false);

  const fetcher = useCallback(
    ({ signal }) => apiFetch("/api/dashboard/reports/reconciliation", { signal }),
    [],
  );
  const { data, error } = useApi(fetcher, { pollMs: 60000, deps: [wsId, refreshKey] });

  const header = (
    <div className="pt">
      <h1>Reconciliation</h1>
      <span className="stamp">as of {asof}</span>
    </div>
  );

  if (error) {
    return (
      <>
        {header}
        <div className="card">
          <h2>Something went wrong</h2>
          <p style={{ margin: "6px 0 0", fontSize: 12.5, color: "var(--ink2)" }}>{error.message}</p>
        </div>
      </>
    );
  }
  if (!data) return <p className="sub">Loading…</p>;

  const { ghosts, stale, counts, stale_after_days: staleDays } = data;
  const freq = data.frequency_days;

  async function onSaveFreq(e) {
    e.preventDefault();
    const n = Math.floor(Number(freqDraft));
    if (!Number.isFinite(n) || n < 1 || n > 365) {
      toast("Enter a whole number of days between 1 and 365");
      return;
    }
    setSavingFreq(true);
    try {
      await saveFrequency(n);
      toast(`Reconciliation report now emails every ${n} day${n === 1 ? "" : "s"}`);
      setFreqDraft("");
      setRefreshKey((k) => k + 1);
    } catch (err) {
      toast(err.message || "Could not update the frequency");
    } finally {
      setSavingFreq(false);
    }
  }

  return (
    <>
      {header}
      <p className="sub">
        Devices configured in {wsName ? <b>{wsName}</b> : "this workspace"} that aren’t actually reporting — checked
        live, right now. <b>Ghost</b> devices have never once reported; <b>stale</b> devices reported before but have
        been silent for {staleDays}+ days.
      </p>

      {/* Report schedule — read-only for everyone, editable for a platform admin */}
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="ch">
          <h2>Scheduled report</h2>
          <span className="hint">emailed to each workspace’s admins</span>
        </div>
        <p className="s" style={{ margin: "4px 0 0", color: "var(--ink2)" }}>
          Runs every <b>{n0(freq)}</b> day{freq === 1 ? "" : "s"}.{" "}
          {data.last_report_date ? (
            <>
              Last sent {data.last_report_date}
              {data.next_report_date ? (
                <> · next {data.overdue ? "due now" : `on ${data.next_report_date}`}</>
              ) : null}
              .
            </>
          ) : (
            <>Not sent yet — the first report goes out on the next sweep.</>
          )}
        </p>
        {isAdmin ? (
          <form onSubmit={onSaveFreq} className="mt16" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <label style={{ fontSize: 12.5, color: "var(--ink2)" }}>
              Change frequency:{" "}
              <input
                type="number"
                min="1"
                max="365"
                step="1"
                placeholder={String(freq)}
                value={freqDraft}
                onChange={(e) => setFreqDraft(e.target.value)}
                style={{ width: 72, padding: "4px 6px", marginLeft: 4 }}
              />{" "}
              days
            </label>
            <button className="btn" type="submit" disabled={savingFreq || freqDraft === ""}>
              {savingFreq ? "Saving…" : "Save"}
            </button>
          </form>
        ) : null}
      </div>

      <div className="grid g2" style={{ marginBottom: 12 }}>
        <StatTile label="Ghost devices" value={n0(counts.ghost)} sub="registered, never reported" card />
        <StatTile label="Stale devices" value={n0(counts.stale)} sub={`no heartbeat in ${staleDays}+ days`} card />
      </div>

      {counts.total === 0 ? (
        <div className="card">
          <p className="empty" style={{ padding: 0 }}>
            {data.device_count === 0
              ? "No devices registered in this workspace yet — nothing to reconcile."
              : "All clear — every device is accounted for and has reported recently."}
          </p>
        </div>
      ) : (
        <>
          <div className="sec">
            <div className="ch">
              <h2>Ghost devices</h2>
              {ghosts.length ? <span className="hint">{n0(ghosts.length)} never reported</span> : null}
            </div>
            <p className="s" style={{ margin: "0 0 8px", color: "var(--ink3)" }}>{GHOST_HINT}</p>
            {ghosts.length ? (
              <div className="card pad0">
                <table>
                  <thead>
                    <tr>
                      <th>Device</th>
                      <th>Registered</th>
                      <th>Last heartbeat</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ghosts.map((d) => (
                      <tr key={d.device_id}>
                        <td>{d.name || d.device_id}</td>
                        <td className="mono">{reconDate(d.registered_at)}</td>
                        <td className="mono" style={{ color: "var(--ink3)" }}>
                          {d.last_heartbeat ? reconDate(d.last_heartbeat) : "never"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="card">
                <p className="empty" style={{ padding: 0 }}>No ghost devices — every registered device has reported at least once.</p>
              </div>
            )}
          </div>

          <div className="sec">
            <div className="ch">
              <h2>Stale devices</h2>
              {stale.length ? <span className="hint">{n0(stale.length)} silent {staleDays}+ days</span> : null}
            </div>
            <p className="s" style={{ margin: "0 0 8px", color: "var(--ink3)" }}>{staleHint(staleDays)}</p>
            {stale.length ? (
              <div className="card pad0">
                <table>
                  <thead>
                    <tr>
                      <th>Device</th>
                      <th>Registered</th>
                      <th>Last heartbeat</th>
                      <th className="r">Days silent</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stale.map((d) => (
                      <tr key={d.device_id}>
                        <td>{d.name || d.device_id}</td>
                        <td className="mono">{reconDate(d.registered_at)}</td>
                        <td className="mono">
                          {reconDate(d.last_heartbeat)}
                          {d.last_heartbeat ? (
                            <small style={{ color: "var(--ink3)" }}> ({timeAgo(d.last_heartbeat)})</small>
                          ) : null}
                        </td>
                        <td className="r mono" style={{ color: "var(--warn)" }}>
                          {d.days_since_heartbeat == null ? "—" : n0(d.days_since_heartbeat)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="card">
                <p className="empty" style={{ padding: 0 }}>No stale devices — every reporting device has checked in within {staleDays} days.</p>
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}
