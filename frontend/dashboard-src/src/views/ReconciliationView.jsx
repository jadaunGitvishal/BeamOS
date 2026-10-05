import { useCallback, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useApi } from "../hooks/useApi";
import { useSession } from "../hooks/useSession";
import { useClock } from "../hooks/useClock";
import { useToast } from "../hooks/useToast";
import { apiFetch, UnauthenticatedError } from "../lib/api";
import { n0, timeAgo } from "../lib/format";
import {
  reconDate,
  GHOST_HINT,
  staleHint,
  staleBuckets,
  ghostAgeBuckets,
  parseReconType,
  filterRecon,
} from "../lib/reconciliation";
import KpiCard from "../components/KpiCard";
import ShareBars from "../components/ShareBars";
import CategoryBarChart from "../components/CategoryBarChart";

// Ref 49 Stage B — the full Reconciliation view. Reads
// GET /api/dashboard/reports/reconciliation, which runs lib/reconciliation.js
// LIVE against the current workspace on every request (polled 60s + on mount),
// so it never waits for the scheduled email. Ghost = registered but never
// reported; stale = reported before but silent for `stale_after_days`+ days.
//
// The payload is a live snapshot with no history, so the charts are bucketed
// breakdowns of the current lists (helpers in lib/reconciliation.js), not
// trends. KPIs and charts always read the FULL payload; the All/Ghost/Stale
// filter (?type=) and search (?q=) only narrow the tables.
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

const FILTERS = [
  { key: "", label: "All" },
  { key: "ghost", label: "Ghost" },
  { key: "stale", label: "Stale" },
];

// A bar-chart card, or the same card with an empty message when there's
// nothing to bucket — never an empty set of axes.
function BucketChart({ title, hint, buckets, color, empty }) {
  const total = buckets.reduce((a, b) => a + b.value, 0);
  if (!total) {
    return (
      <div className="card">
        <div className="ch">
          <h2>{title}</h2>
        </div>
        <p className="empty" style={{ padding: 0 }}>
          {empty}
        </p>
      </div>
    );
  }
  return <CategoryBarChart title={title} hint={hint} data={buckets.map((b) => ({ ...b, color }))} />;
}

// Only shown when some rows couldn't be bucketed, so the totals still reconcile.
function unknownHint(unknown, what) {
  return unknown ? `${n0(unknown)} with no ${what}` : null;
}

export default function ReconciliationView() {
  const { me } = useSession();
  const asof = useClock();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const wsId = me?.current_workspace_id || null;
  const wsName = me?.current_workspace?.name || "";
  const isAdmin = !!me?.is_platform_admin;

  const typeFilter = parseReconType(searchParams.get("type"));
  const urlSearch = searchParams.get("q") || "";
  const [inputValue, setInputValue] = useState(urlSearch);
  useEffect(() => setInputValue(urlSearch), [urlSearch]);

  // Debounced ?q= update, same 260ms as the Screens page.
  useEffect(() => {
    if (inputValue === urlSearch) return;
    const t = setTimeout(() => {
      const next = new URLSearchParams(searchParams);
      if (inputValue) next.set("q", inputValue);
      else next.delete("q");
      setSearchParams(next, { replace: true });
    }, 260);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputValue]);

  const setType = (next) => {
    const p = new URLSearchParams(searchParams);
    if (next) p.set("type", next);
    else p.delete("type");
    setSearchParams(p, { replace: true });
  };

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
  if (!data) {
    return (
      <>
        {header}
        <p className="sub">Loading…</p>
      </>
    );
  }

  const { ghosts, stale, counts, stale_after_days: staleDays } = data;
  const freq = data.frequency_days;
  const deviceCount = Number(data.device_count) || 0;
  const reporting = Math.max(0, deviceCount - counts.total);
  const share = (n) => (deviceCount ? (n / deviceCount) * 100 : null);
  const reportingPct = share(reporting);
  const allClear = counts.total === 0;

  const staleChart = staleBuckets(stale, staleDays);
  const ghostChart = ghostAgeBuckets(ghosts, data.generated_at);
  const shown = filterRecon({ ghosts, stale }, { type: typeFilter, q: urlSearch });

  const lastSent = data.last_report_date;
  const nextValue = data.overdue ? "Due now" : data.next_report_date || "Next sweep";
  const everyN = `every ${n0(freq)} day${freq === 1 ? "" : "s"}`;

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

  const fleetShare = (
    <ShareBars
      title="Fleet reconciliation"
      note={`Share of ${n0(deviceCount)} registered device${deviceCount === 1 ? "" : "s"} (blocked excluded).`}
      unit="device"
      total={deviceCount}
      rows={[
        { key: "reporting", label: "Reporting", count: reporting, color: "var(--ok)" },
        { key: "stale", label: "Stale", count: counts.stale, color: "var(--warn)" },
        { key: "ghost", label: "Ghost", count: counts.ghost, color: "var(--bad)" },
      ]}
    />
  );

  const openDevice = (id) => navigate(`/device/${encodeURIComponent(id)}`);

  return (
    <>
      {header}
      <p className="sub">
        Devices configured in {wsName ? <b>{wsName}</b> : "this workspace"} that aren’t actually reporting — checked
        live, right now. <b>Ghost</b> devices have never once reported; <b>stale</b> devices reported before but have
        been silent for {staleDays}+ days.
      </p>

      <div className="grid g4">
        <KpiCard
          label="Accounted for"
          value={n0(reporting)}
          ofValue={n0(deviceCount)}
          subLine={
            deviceCount
              ? `${Math.round(reportingPct)}% · reported within ${staleDays} days`
              : "no devices registered yet"
          }
          percentage={reportingPct}
          color={allClear ? "var(--ok)" : "var(--warn)"}
        />
        <KpiCard
          label="Ghost devices"
          value={n0(counts.ghost)}
          ofValue={deviceCount ? n0(deviceCount) : null}
          subLine="registered, never reported"
          percentage={counts.ghost ? share(counts.ghost) : null}
          color={counts.ghost ? "var(--bad)" : "var(--ok)"}
        />
        <KpiCard
          label="Stale devices"
          value={n0(counts.stale)}
          ofValue={deviceCount ? n0(deviceCount) : null}
          subLine={`silent ${staleDays}+ days`}
          percentage={counts.stale ? share(counts.stale) : null}
          color={counts.stale ? "var(--warn)" : "var(--ok)"}
        />
        <KpiCard
          label="Next report"
          value={nextValue}
          subLine={lastSent ? `${everyN} · last sent ${lastSent}` : `${everyN} · not sent yet`}
          color={data.overdue ? "var(--warn)" : "var(--accent)"}
        />
      </div>

      {deviceCount > 0 ? (
        allClear ? (
          <div className="mt16">
            {fleetShare}
          </div>
        ) : (
          <div className="grid g3 mt16 csplit">
            {fleetShare}
            <BucketChart
              title="Stale devices by days silent"
              hint={unknownHint(staleChart.unknown, "heartbeat")}
              buckets={staleChart.buckets}
              color="var(--warn)"
              empty={`No stale devices — every reporting device has checked in within ${staleDays} days.`}
            />
            <BucketChart
              title="Ghost devices by time since registration"
              hint={unknownHint(ghostChart.unknown, "registration date")}
              buckets={ghostChart.buckets}
              color="var(--bad)"
              empty="No ghost devices — every registered device has reported at least once."
            />
          </div>
        )
      ) : null}

      {allClear ? (
        <div className="card mt16">
          <p className="empty" style={{ padding: 0 }}>
            {data.device_count === 0
              ? "No devices registered in this workspace yet — nothing to reconcile."
              : "All clear — every device is accounted for and has reported recently."}
          </p>
        </div>
      ) : (
        <>
          <div className="ctl mt16">
            <div className="seg" role="group" aria-label="Filter by discrepancy">
              {FILTERS.map((f) => (
                <button key={f.key || "all"} className={typeFilter === f.key ? "on" : ""} onClick={() => setType(f.key)}>
                  {f.label}
                </button>
              ))}
            </div>
            <input
              className="srch"
              placeholder="Find a device"
              aria-label="Find a device"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
            />
          </div>

          {typeFilter !== "stale" ? (
            <div className="sec">
              <div className="ch">
                <h2>Ghost devices</h2>
                {ghosts.length ? <span className="hint">{n0(ghosts.length)} never reported</span> : null}
              </div>
              <p className="s" style={{ margin: "0 0 8px", color: "var(--ink3)" }}>{GHOST_HINT}</p>
              {!ghosts.length ? (
                <div className="card">
                  <p className="empty" style={{ padding: 0 }}>No ghost devices — every registered device has reported at least once.</p>
                </div>
              ) : !shown.ghosts.length ? (
                <div className="card">
                  <p className="empty" style={{ padding: 0 }}>No devices match.</p>
                </div>
              ) : (
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
                      {shown.ghosts.map((d) => (
                        <tr key={d.device_id} className="click" onClick={() => openDevice(d.device_id)}>
                          <td style={{ fontWeight: 500 }}>
                            {d.name || d.device_id}{" "}
                            <span className="tag p-bad" style={{ marginLeft: 6 }}>ghost</span>
                          </td>
                          <td className="mono">{reconDate(d.registered_at)}</td>
                          <td className="mono" style={{ color: "var(--ink3)" }}>
                            {d.last_heartbeat ? reconDate(d.last_heartbeat) : "never"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ) : null}

          {typeFilter !== "ghost" ? (
            <div className="sec">
              <div className="ch">
                <h2>Stale devices</h2>
                {stale.length ? <span className="hint">{n0(stale.length)} silent {staleDays}+ days</span> : null}
              </div>
              <p className="s" style={{ margin: "0 0 8px", color: "var(--ink3)" }}>{staleHint(staleDays)}</p>
              {!stale.length ? (
                <div className="card">
                  <p className="empty" style={{ padding: 0 }}>No stale devices — every reporting device has checked in within {staleDays} days.</p>
                </div>
              ) : !shown.stale.length ? (
                <div className="card">
                  <p className="empty" style={{ padding: 0 }}>No devices match.</p>
                </div>
              ) : (
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
                      {shown.stale.map((d) => (
                        <tr key={d.device_id} className="click" onClick={() => openDevice(d.device_id)}>
                          <td style={{ fontWeight: 500 }}>
                            {d.name || d.device_id}{" "}
                            <span className="tag p-warn" style={{ marginLeft: 6 }}>stale</span>
                          </td>
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
              )}
            </div>
          ) : null}
        </>
      )}

      {/* Report schedule — read-only for everyone, editable for a platform admin */}
      <div className="card panel mt16">
        <div className="panel-head">
          <div>
            <p className="eyebrow">Schedule</p>
            <h2>Scheduled report</h2>
            <p className="panel-note">Emailed to each workspace’s admins.</p>
          </div>
        </div>
        <p className="s" style={{ margin: 0, color: "var(--ink2)" }}>
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
    </>
  );
}
