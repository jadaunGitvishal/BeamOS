import { useCallback, useState } from "react";
import { useApi } from "../hooks/useApi";
import { useSession } from "../hooks/useSession";
import { useClock } from "../hooks/useClock";
import { useToast } from "../hooks/useToast";
import { apiFetch, UnauthenticatedError } from "../lib/api";
import { n0 } from "../lib/format";
import { pendingDate, expiryLabel, PENDING_HINT, ABANDONED_HINT } from "../lib/pending-installations";
import StatTile from "../components/StatTile";

// Ref 48 Stage B — the full Pending Installations view. Reads
// GET /api/dashboard/reports/pending-installations, which runs
// lib/pending-installations.js LIVE against the current workspace on every
// request (polled 60s + on mount), so it never waits for the scheduled email.
// pending = a registration code cut > grace_days ago with no device activated,
// still inside its 30-day window; abandoned = that window lapsed unclaimed.
//
// A platform admin can change how often the scheduled report emails
// (pending_installation_report_frequency_days) inline here — the only place it's
// surfaced in the dashboard — via PUT /api/admin/pending-installation-frequency.

async function saveFrequency(days) {
  const resp = await fetch("/api/admin/pending-installation-frequency", {
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

export default function PendingInstallationsView() {
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
    ({ signal }) => apiFetch("/api/dashboard/reports/pending-installations", { signal }),
    [],
  );
  const { data, error } = useApi(fetcher, { pollMs: 60000, deps: [wsId, refreshKey] });

  const header = (
    <div className="pt">
      <h1>Pending Installations</h1>
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

  const { pending, abandoned, counts, grace_days: grace } = data;
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
      toast(`Pending-installation report now emails every ${n} day${n === 1 ? "" : "s"}`);
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
        Registration codes generated for {wsName ? <b>{wsName}</b> : "this workspace"} ahead of an on-site install that
        no device has activated against — checked live, right now. <b>Pending</b> codes are still valid and worth
        chasing; <b>abandoned</b> codes expired unclaimed and need regenerating.
      </p>

      {/* Report schedule — read-only for everyone, editable for a platform admin */}
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="ch">
          <h2>Scheduled report</h2>
          <span className="hint">emailed to each workspace’s admins and the code’s creator</span>
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
        <StatTile label="Pending" value={n0(counts.pending)} sub={`code cut > ${grace}d ago, not activated`} card />
        <StatTile label="Abandoned" value={n0(counts.abandoned)} sub="expired, never activated" card />
      </div>

      {counts.total === 0 ? (
        <div className="card">
          <p className="empty" style={{ padding: 0 }}>
            {data.code_count === 0
              ? "This workspace hasn’t generated any registration codes — devices here are paired directly. Nothing to follow up."
              : "All clear — every registration code this workspace generated has been activated or handled."}
          </p>
        </div>
      ) : (
        <>
          <div className="sec">
            <div className="ch">
              <h2>Pending</h2>
              {pending.length ? <span className="hint">{n0(pending.length)} awaiting activation</span> : null}
            </div>
            <p className="s" style={{ margin: "0 0 8px", color: "var(--ink3)" }}>{PENDING_HINT(grace)}</p>
            {pending.length ? (
              <div className="card pad0">
                <table>
                  <thead>
                    <tr>
                      <th>Code</th>
                      <th>Planned device</th>
                      <th className="r">Days pending</th>
                      <th>Expires</th>
                      <th className="r">Days until expiry</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pending.map((c) => (
                      <tr key={c.code_id}>
                        <td className="mono">{c.code}</td>
                        <td>{c.planned_device_name || <span style={{ color: "var(--ink3)" }}>(unnamed)</span>}</td>
                        <td className="r mono">{c.days_pending == null ? "—" : n0(c.days_pending)}</td>
                        <td className="mono">{pendingDate(c.expires_at)}</td>
                        <td
                          className="r mono"
                          style={{ color: c.days_until_expiry != null && c.days_until_expiry <= 7 ? "var(--warn)" : undefined }}
                        >
                          {expiryLabel(c.days_until_expiry)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="card">
                <p className="empty" style={{ padding: 0 }}>No pending codes — every recent code has been activated.</p>
              </div>
            )}
          </div>

          <div className="sec">
            <div className="ch">
              <h2>Abandoned</h2>
              {abandoned.length ? <span className="hint">{n0(abandoned.length)} expired unclaimed</span> : null}
            </div>
            <p className="s" style={{ margin: "0 0 8px", color: "var(--ink3)" }}>{ABANDONED_HINT}</p>
            {abandoned.length ? (
              <div className="card pad0">
                <table>
                  <thead>
                    <tr>
                      <th>Code</th>
                      <th>Planned device</th>
                      <th>Generated</th>
                      <th>Expired</th>
                    </tr>
                  </thead>
                  <tbody>
                    {abandoned.map((c) => (
                      <tr key={c.code_id}>
                        <td className="mono">{c.code}</td>
                        <td>{c.planned_device_name || <span style={{ color: "var(--ink3)" }}>(unnamed)</span>}</td>
                        <td className="mono">{pendingDate(c.created_at)}</td>
                        <td className="mono" style={{ color: "var(--ink3)" }}>{pendingDate(c.expires_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="card">
                <p className="empty" style={{ padding: 0 }}>No abandoned codes — nothing has expired unclaimed.</p>
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}
