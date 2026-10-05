import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useApi } from "../hooks/useApi";
import { useSession } from "../hooks/useSession";
import { useClock } from "../hooks/useClock";
import { useToast } from "../hooks/useToast";
import { apiFetch, UnauthenticatedError } from "../lib/api";
import { n0 } from "../lib/format";
import {
  pendingDate,
  expiryLabel,
  PENDING_HINT,
  ABANDONED_HINT,
  isExpiringSoon,
  expiryBuckets,
  expiredAgeBuckets,
  parsePendingType,
  filterPending,
} from "../lib/pending-installations";
import KpiCard from "../components/KpiCard";
import ShareBars from "../components/ShareBars";
import CategoryBarChart from "../components/CategoryBarChart";

// Ref 48 Stage B — the full Pending Installations view. Reads
// GET /api/dashboard/reports/pending-installations, which runs
// lib/pending-installations.js LIVE against the current workspace on every
// request (polled 60s + on mount), so it never waits for the scheduled email.
// pending = a registration code cut > grace_days ago with no device activated,
// still inside its 30-day window; abandoned = that window lapsed unclaimed.
//
// The payload is a live snapshot with no history, so the charts are bucketed
// breakdowns of the current lists (helpers in lib/pending-installations.js),
// not trends. KPIs and charts always read the FULL payload; the
// All/Pending/Abandoned filter (?type=) and search (?q=) only narrow the tables.
// code_count counts every code in the workspace (any status), so the remainder
// after pending + abandoned is "activated, within grace or other" — never just
// "activated".
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

const FILTERS = [
  { key: "", label: "All" },
  { key: "pending", label: "Pending" },
  { key: "abandoned", label: "Abandoned" },
];

// A bar-chart card, or the same card with an empty message when there's
// nothing to bucket — never an empty set of axes.
function BucketChart({ title, hint, buckets, empty }) {
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
  return <CategoryBarChart title={title} hint={hint} data={buckets} />;
}

// Only shown when some rows couldn't be bucketed, so the totals still reconcile.
function unknownHint(unknown, what) {
  return unknown ? `${n0(unknown)} with no ${what}` : null;
}

// Code + status tags; wraps inside the cell rather than widening the table.
function CodeCell({ code, children }) {
  return (
    <td>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px 6px" }}>
        <span className="mono">{code}</span>
        {children}
      </div>
    </td>
  );
}

export default function PendingInstallationsView() {
  const { me } = useSession();
  const asof = useClock();
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const wsId = me?.current_workspace_id || null;
  const wsName = me?.current_workspace?.name || "";
  const isAdmin = !!me?.is_platform_admin;

  const typeFilter = parsePendingType(searchParams.get("type"));
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
  if (!data) {
    return (
      <>
        {header}
        <p className="sub">Loading…</p>
      </>
    );
  }

  const { pending, abandoned, counts, grace_days: grace } = data;
  const freq = data.frequency_days;
  const codeCount = Number(data.code_count) || 0;
  const other = Math.max(0, codeCount - counts.total);
  const expiring = pending.filter(isExpiringSoon).length;
  const allClear = counts.total === 0;

  const expiryChart = expiryBuckets(pending);
  const expiredChart = expiredAgeBuckets(abandoned, data.generated_at);
  const shown = filterPending({ pending, abandoned }, { type: typeFilter, q: urlSearch });

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
      toast(`Pending-installation report now emails every ${n} day${n === 1 ? "" : "s"}`);
      setFreqDraft("");
      setRefreshKey((k) => k + 1);
    } catch (err) {
      toast(err.message || "Could not update the frequency");
    } finally {
      setSavingFreq(false);
    }
  }

  const codeShare = (
    <ShareBars
      title="Registration codes"
      note={`Share of all ${n0(codeCount)} code${codeCount === 1 ? "" : "s"} generated in this workspace, any status.`}
      unit="code"
      total={codeCount}
      rows={[
        { key: "pending", label: "Pending", count: counts.pending, color: "var(--warn)" },
        { key: "abandoned", label: "Abandoned", count: counts.abandoned, color: "var(--bad)" },
        { key: "other", label: "Activated, within grace or other", count: other, color: "var(--ink3)" },
      ]}
      foot="“Other” covers activated codes, codes still inside the grace period and any other status."
    />
  );

  return (
    <>
      {header}
      <p className="sub">
        Registration codes generated for {wsName ? <b>{wsName}</b> : "this workspace"} ahead of an on-site install that
        no device has activated against — checked live, right now. <b>Pending</b> codes are still valid and worth
        chasing; <b>abandoned</b> codes expired unclaimed and need regenerating.
      </p>

      <div className="grid g4">
        <KpiCard
          label="Pending"
          value={n0(counts.pending)}
          subLine={`code cut over ${grace}d ago, not activated`}
          color={counts.pending ? "var(--warn)" : "var(--ok)"}
        />
        <KpiCard
          label="Expiring within 7 days"
          value={n0(expiring)}
          ofValue={counts.pending ? n0(counts.pending) : null}
          subLine={counts.pending ? "pending codes about to lapse" : "no pending codes"}
          percentage={counts.pending ? (expiring / counts.pending) * 100 : null}
          color={expiring ? "var(--bad)" : "var(--ok)"}
        />
        <KpiCard
          label="Abandoned"
          value={n0(counts.abandoned)}
          subLine="expired, never activated"
          color={counts.abandoned ? "var(--bad)" : "var(--ok)"}
        />
        <KpiCard
          label="Next report"
          value={nextValue}
          subLine={lastSent ? `${everyN} · last sent ${lastSent}` : `${everyN} · not sent yet`}
          color={data.overdue ? "var(--warn)" : "var(--accent)"}
        />
      </div>

      {codeCount > 0 ? (
        allClear ? (
          <div className="mt16">{codeShare}</div>
        ) : (
          <div className="grid g3 mt16 csplit">
            {codeShare}
            <BucketChart
              title="Pending codes by days until expiry"
              hint={unknownHint(expiryChart.unknown, "expiry")}
              buckets={expiryChart.buckets.map((b, i) => ({
                ...b,
                color: ["var(--bad)", "var(--warn)", "var(--ink3)"][i],
              }))}
              empty="No pending codes."
            />
            <BucketChart
              title="Abandoned codes by time since expiry"
              hint={unknownHint(expiredChart.unknown, "expiry date")}
              buckets={expiredChart.buckets.map((b) => ({ ...b, color: "var(--bad)" }))}
              empty="No abandoned codes."
            />
          </div>
        )
      ) : null}

      {allClear ? (
        <div className="card mt16">
          <p className="empty" style={{ padding: 0 }}>
            {data.code_count === 0
              ? "This workspace hasn’t generated any registration codes — devices here are paired directly. Nothing to follow up."
              : "All clear — every registration code this workspace generated has been activated or handled."}
          </p>
        </div>
      ) : (
        <>
          <div className="ctl mt16">
            <div className="seg" role="group" aria-label="Filter by code status">
              {FILTERS.map((f) => (
                <button key={f.key || "all"} className={typeFilter === f.key ? "on" : ""} onClick={() => setType(f.key)}>
                  {f.label}
                </button>
              ))}
            </div>
            <input
              className="srch"
              placeholder="Find a code or device"
              aria-label="Find a code or device"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
            />
          </div>

          {typeFilter !== "abandoned" ? (
            <div className="sec">
              <div className="ch">
                <h2>Pending</h2>
                {pending.length ? <span className="hint">{n0(pending.length)} awaiting activation</span> : null}
              </div>
              <p className="s" style={{ margin: "0 0 8px", color: "var(--ink3)" }}>{PENDING_HINT(grace)}</p>
              {!pending.length ? (
                <div className="card">
                  <p className="empty" style={{ padding: 0 }}>No pending codes — every recent code has been activated.</p>
                </div>
              ) : !shown.pending.length ? (
                <div className="card">
                  <p className="empty" style={{ padding: 0 }}>No codes match.</p>
                </div>
              ) : (
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
                      {shown.pending.map((c) => (
                        <tr key={c.code_id}>
                          <CodeCell code={c.code}>
                            <span className="tag p-warn">pending</span>
                            {isExpiringSoon(c) ? (
                              <span className="tag p-bad">expires in {n0(c.days_until_expiry)}d</span>
                            ) : null}
                          </CodeCell>
                          <td>{c.planned_device_name || <span style={{ color: "var(--ink3)" }}>(unnamed)</span>}</td>
                          <td className="r mono">{c.days_pending == null ? "—" : n0(c.days_pending)}</td>
                          <td className="mono">{pendingDate(c.expires_at)}</td>
                          <td className="r mono">{expiryLabel(c.days_until_expiry)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ) : null}

          {typeFilter !== "pending" ? (
            <div className="sec">
              <div className="ch">
                <h2>Abandoned</h2>
                {abandoned.length ? <span className="hint">{n0(abandoned.length)} expired unclaimed</span> : null}
              </div>
              <p className="s" style={{ margin: "0 0 8px", color: "var(--ink3)" }}>{ABANDONED_HINT}</p>
              {!abandoned.length ? (
                <div className="card">
                  <p className="empty" style={{ padding: 0 }}>No abandoned codes — nothing has expired unclaimed.</p>
                </div>
              ) : !shown.abandoned.length ? (
                <div className="card">
                  <p className="empty" style={{ padding: 0 }}>No codes match.</p>
                </div>
              ) : (
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
                      {shown.abandoned.map((c) => (
                        <tr key={c.code_id}>
                          <CodeCell code={c.code}>
                            <span className="tag p-bad">abandoned</span>
                          </CodeCell>
                          <td>{c.planned_device_name || <span style={{ color: "var(--ink3)" }}>(unnamed)</span>}</td>
                          <td className="mono">{pendingDate(c.created_at)}</td>
                          <td className="mono" style={{ color: "var(--ink3)" }}>{pendingDate(c.expires_at)}</td>
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
            <p className="panel-note">Emailed to each workspace’s admins and the code’s creator.</p>
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
