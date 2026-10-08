import { useCallback } from "react";
import { Link } from "react-router-dom";
import { useApi } from "../hooks/useApi";
import { usePeriod } from "../hooks/usePeriod";
import { apiFetch } from "../lib/api";
import { n0 } from "../lib/format";
import KpiCard from "./KpiCard";

// PMI Ref 71: the Overview "Screen runtime" row - average runtime, zero-runtime
// screens and up to 10 of them by name - from GET /api/dashboard/runtime, which
// takes every figure from the same lib/runtime-summary.js the Ref 66 regional
// reports use. Whole complete UTC days only (never today), so the range shown
// here can differ from the header's rolling "Reporting period".
// No uptime % is shown here (the response's avg_uptime_pct is for parity checks):
// the SLA "Fleet uptime" gauge is the page's only uptime figure.
// Fetched on its own (not in OverviewView's Promise.all) so a failure here only
// hides this row; polled like the rest of the page.
export default function ScreenRuntime() {
  const { period } = usePeriod();
  const fetcher = useCallback(
    ({ signal }) => apiFetch(`/api/dashboard/runtime?period=${encodeURIComponent(period)}`, { signal }),
    [period],
  );
  const { data, error } = useApi(fetcher, { pollMs: 60000, deps: [period] });

  if (error) return null;
  if (!data) return null;

  const p = data.period;
  const range = p.first_day === p.last_day ? p.first_day : `${p.first_day} to ${p.last_day}`;
  const hours = data.avg_runtime_hours;
  const eligible = data.zero_runtime_eligible;
  const zeroPct = data.zero_runtime_pct;
  const more = data.zero_runtime_count - data.zero_runtime_screens.length;

  return (
    <div className="sec">
      <div className="ch">
        <h2>Screen runtime</h2>
        <span className="hint">
          {p.label} · {range}
        </span>
      </div>
      <div className="grid g3">
        <KpiCard
          label="Average runtime"
          value={hours !== null ? `${hours.toFixed(1)} h` : "n/a"}
          subLine={
            hours !== null
              ? `per screen per day · ${n0(data.screens)} screen${data.screens === 1 ? "" : "s"}`
              : "no screens with data in this period"
          }
          color="var(--accent)"
        />
        <KpiCard
          label="Zero-runtime screens"
          value={eligible ? n0(data.zero_runtime_count) : "n/a"}
          ofValue={eligible ? n0(eligible) : null}
          subLine={
            eligible
              ? `${zeroPct}% of screens registered before the period`
              : "no eligible screens in this period"
          }
          percentage={eligible ? zeroPct : null}
          color="var(--bad)"
        />
        {/* minWidth 0: a long screen name must not widen the stacked (1fr) column */}
        <div className="card panel" style={{ minWidth: 0 }}>
          <div className="panel-head">
            <div>
              <p className="eyebrow">Zero runtime</p>
              <h2 style={{ fontSize: 14 }}>Screens with no runtime</h2>
            </div>
          </div>
          {data.zero_runtime_screens.length ? (
            <ol style={{ listStyle: "none", margin: 0, padding: 0, fontSize: 12.5 }}>
              {data.zero_runtime_screens.map((s) => (
                <li
                  key={s.id}
                  style={{ padding: "4px 0", borderTop: "1px solid var(--line-soft)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                >
                  <Link className="panel-link" to={`/device/${encodeURIComponent(s.id)}`} title={s.name}>
                    {s.name || s.id}
                  </Link>
                </li>
              ))}
              {more > 0 ? (
                <li style={{ padding: "4px 0", borderTop: "1px solid var(--line-soft)", color: "var(--ink3)" }}>
                  and {n0(more)} more
                </li>
              ) : null}
            </ol>
          ) : (
            <p className="empty" style={{ padding: 0 }}>
              {eligible ? "None. Every eligible screen ran in this period." : "n/a"}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
