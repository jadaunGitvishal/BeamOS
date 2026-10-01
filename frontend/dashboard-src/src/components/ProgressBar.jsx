// Horizontal percentage bar with the same colour rule as ComplianceGauge.jsx:
// green when it meets `target`, amber within 5 pts, red otherwise, grey with no
// data. With no target the bar is the neutral accent (or pass `color` to use a
// page's own rule, e.g. Campaigns' deliveryColor). The fill is a fraction of
// 100 (capped), with a tick marking the target when one is given.
//
//   <ProgressBar percentage={94.2} target={99} label="Uptime" />

export default function ProgressBar({ percentage, target, label, color, showValue = true }) {
  const has = percentage != null && Number.isFinite(Number(percentage));
  const pct = has ? Number(percentage) : 0;
  const tgt = target != null && Number.isFinite(Number(target)) ? Number(target) : null;

  const auto = !has
    ? "var(--ink3)"
    : tgt == null
      ? "var(--accent)"
      : pct >= tgt
        ? "var(--ok)"
        : tgt - pct <= 5
          ? "var(--warn)"
          : "var(--bad)";
  const fill = has ? (color ?? auto) : "var(--ink3)";
  const width = Math.max(0, Math.min(100, pct));

  return (
    <div
      className="pbar"
      role="img"
      aria-label={`${label ? label + ": " : ""}${has ? pct + "%" : "no data"}${tgt != null ? `, target ${tgt}%` : ""}`}
    >
      {label ? <span className="pbar-k">{label}</span> : null}
      <span className="pbar-track">
        {has ? <span className="pbar-fill" style={{ width: `${width}%`, background: fill }} /> : null}
        {tgt != null ? <span className="pbar-tgt" style={{ left: `${Math.min(100, tgt)}%` }} /> : null}
      </span>
      {showValue ? (
        <span className="pbar-v num" style={{ color: has ? fill : "var(--ink3)" }}>
          {has ? `${pct}%` : "—"}
        </span>
      ) : null}
    </div>
  );
}
