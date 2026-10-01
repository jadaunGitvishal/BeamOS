// Campaigns page charts. Everything here is drawn from the fields the
// campaigns API already returns (dates, status, target_plays_per_day,
// actual_plays, expected_plays, delivery_pct) - no per-hour, reach or
// per-creative data exists, so none is shown.

import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";
import ProgressBar from "./ProgressBar";
import { n0 } from "../lib/format";
import {
  CAMPAIGN_STATUS,
  deliveryColor,
  dayNum,
  todayStr,
  fmtDay,
  campaignLength,
  timeElapsed,
} from "../lib/campaigns";

function PanelHead({ eyebrow, title, hint }) {
  return (
    <div className="panel-head">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h2>{title}</h2>
        {hint ? <p className="panel-note">{hint}</p> : null}
      </div>
    </div>
  );
}

// One bar per campaign that has a plan, worst pace first. The bar fill caps at
// 100% (ProgressBar), the number does not - over-delivery is real signal. Tick
// at 100% = on plan.
export function DeliveryBars({ campaigns }) {
  const rows = campaigns.filter((c) => c.delivery_pct != null).sort((a, b) => a.delivery_pct - b.delivery_pct);
  return (
    <div className="card panel">
      <PanelHead eyebrow="Delivery pace" title="Delivered vs plan" hint="plays so far ÷ daily target × days run" />
      {rows.length ? (
        <div className="cdel">
          {rows.map((c) => (
            <div className="cdel-row" key={c.id}>
              <div className="cdel-name">
                <span>{c.name}</span>
                <small>
                  {n0(c.actual_plays)} of {n0(c.expected_plays)} planned · {(CAMPAIGN_STATUS[c.status] || {}).label || c.status}
                </small>
              </div>
              <ProgressBar percentage={c.delivery_pct} target={100} color={deliveryColor(c.delivery_pct)} />
            </div>
          ))}
        </div>
      ) : (
        <p className="empty" style={{ padding: 0 }}>
          No campaign has a delivery plan yet. Edit a campaign that has a playlist and set “Target plays / day” to
          track whether it is playing as often as planned.
        </p>
      )}
    </div>
  );
}

// Every campaign's date range on one shared axis: the part of the run that has
// passed is filled, drafts (not started) are dashed, and a line marks today.
export function CampaignTimeline({ campaigns }) {
  const rows = [...campaigns].sort((a, b) => (a.start_date < b.start_date ? -1 : a.start_date > b.start_date ? 1 : 0));
  if (!rows.length) return null;
  const min = Math.min(...rows.map((c) => dayNum(c.start_date)));
  const max = Math.max(...rows.map((c) => dayNum(c.end_date) + 1)); // end day inclusive
  const span = Math.max(1, max - min);
  const now = dayNum();
  const todayPct = now >= min && now <= max ? ((now - min) / span) * 100 : null;
  const pct = (v) => `${((v - min) / span) * 100}%`;

  return (
    <div className="card panel">
      <PanelHead eyebrow="Schedule" title="Campaign timeline" hint={`${fmtDay(rows[0].start_date)} – ${fmtDay(new Date((max - 1) * 86400000).toISOString().slice(0, 10))}`} />
      <div className="ctl-chart">
        {rows.map((c) => {
          const s = CAMPAIGN_STATUS[c.status] || { label: c.status, color: "var(--ink3)" };
          const len = campaignLength(c);
          return (
            <div className="ctl-row" key={c.id}>
              <span className="ctl-name" title={c.name}>
                {c.name}
              </span>
              <div className="ctl-track">
                <div
                  className={`ctl-bar${c.status === "draft" ? " draft" : ""}`}
                  style={{ left: pct(dayNum(c.start_date)), width: `${(len / span) * 100}%`, borderColor: s.color }}
                  title={`${c.name}: ${fmtDay(c.start_date)} – ${fmtDay(c.end_date)} (${len} day${len === 1 ? "" : "s"}, ${s.label.toLowerCase()})`}
                >
                  <span className="ctl-fill" style={{ width: `${timeElapsed(c) * 100}%`, background: s.color }} />
                </div>
                {todayPct !== null ? <span className="ctl-today" style={{ left: `${todayPct}%` }} /> : null}
              </div>
            </div>
          );
        })}
        <div className="ctl-row ctl-axis">
          <span className="ctl-name" />
          <div className="ctl-track">
            {/* start date label, unless the Today label would sit on top of it */}
            {todayPct === null || todayPct > 22 ? <span style={{ left: 0 }}>{fmtDay(rows[0].start_date)}</span> : null}
            {todayPct !== null ? (
              <span className="ctl-today-label" style={{ left: `${todayPct}%` }}>
                Today · {fmtDay(todayStr())}
              </span>
            ) : null}
          </div>
        </div>
      </div>
      <div className="ch-legend">
        <span>
          <i style={{ background: CAMPAIGN_STATUS.live.color }} /> Live
        </span>
        <span>
          <i style={{ background: CAMPAIGN_STATUS.completed.color }} /> Completed
        </span>
        <span>
          <i className="dashed" style={{ borderColor: CAMPAIGN_STATUS.draft.color }} /> Draft (not started)
        </span>
        <span>
          <i className="line" /> Today
        </span>
      </div>
    </div>
  );
}

// Planned-to-date vs delivered plays, per campaign with a daily target that has
// started (planned > 0; a draft has nothing planned yet) - max 8, live first,
// then most recent. Hidden when no campaign has a plan.
export function PlaysChart({ campaigns }) {
  const rank = { live: 0, completed: 1, draft: 2 };
  const rows = campaigns
    .filter((c) => c.expected_plays > 0 && c.actual_plays != null)
    .sort((a, b) => (rank[a.status] ?? 3) - (rank[b.status] ?? 3) || (a.start_date < b.start_date ? 1 : -1))
    .slice(0, 8)
    .map((c) => ({ name: c.name, planned: c.expected_plays, delivered: c.actual_plays }));
  if (!rows.length) return null;

  return (
    <div className="card panel mt16">
      <PanelHead eyebrow="Volume" title="Planned vs delivered plays" hint="planned = daily target × days run so far" />
      <div style={{ width: "100%", height: 230 }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 4 }} barCategoryGap="24%" barGap={2}>
            <CartesianGrid stroke="var(--line-soft)" vertical={false} />
            <XAxis
              dataKey="name"
              tick={{ fontSize: 10, fill: "var(--ink3)" }}
              tickMargin={6}
              interval={0}
              tickFormatter={(v) => (v.length > 14 ? `${v.slice(0, 13)}…` : v)}
              axisLine={{ stroke: "var(--line)" }}
              tickLine={false}
            />
            <YAxis
              tick={{ fontSize: 10, fill: "var(--ink3)" }}
              tickMargin={4}
              width={44}
              allowDecimals={false}
              axisLine={false}
              tickLine={false}
              tickFormatter={(v) => n0(v)}
            />
            <Tooltip
              cursor={{ fill: "var(--line-soft)" }}
              formatter={(v, key) => [n0(v), key === "planned" ? "Planned to date" : "Delivered"]}
              contentStyle={{ fontSize: 11, borderRadius: 8, border: "1px solid var(--line)" }}
            />
            <Bar dataKey="planned" fill="var(--ink3)" radius={[4, 4, 0, 0]} maxBarSize={28} isAnimationActive={false} />
            <Bar dataKey="delivered" fill="var(--accent)" radius={[4, 4, 0, 0]} maxBarSize={28} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="ch-legend">
        <span>
          <i style={{ background: "var(--ink3)" }} /> Planned to date
        </span>
        <span>
          <i style={{ background: "var(--accent)" }} /> Delivered
        </span>
      </div>
    </div>
  );
}
