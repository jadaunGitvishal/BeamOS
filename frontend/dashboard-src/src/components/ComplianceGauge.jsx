// Reusable circular progress gauge: a big % in the centre of a ring whose
// coloured arc fills toward `target`, with the arc + value coloured by whether
// the value meets that target (green) or not (amber when within 5 pts, else
// red). Built for the SLA "fleet uptime vs target" number but takes plain
// percentage / target / label props so it can be reused elsewhere.
//
//   <ComplianceGauge label="Fleet uptime" percentage={94.2} target={99} />
//
// `caption` overrides the auto "X pts to recover" / "Meets the N% target" line.

const R = 34; // ring radius within the 80x80 viewBox
const CIRC = 2 * Math.PI * R;

export default function ComplianceGauge({ percentage, target, label, caption, size = 84 }) {
  const has = percentage != null && Number.isFinite(Number(percentage));
  const pct = has ? Number(percentage) : 0;
  const tgt = target != null && Number.isFinite(Number(target)) ? Number(target) : null;

  const meets = tgt != null && pct >= tgt;
  const gap = tgt != null ? tgt - pct : null;
  // Arc fills as a fraction of the target (capped at full); with no target it
  // falls back to a fraction of 100.
  const frac = Math.max(0, Math.min(1, tgt != null && tgt > 0 ? pct / tgt : pct / 100));

  const color = !has
    ? "var(--ink3)"
    : meets
      ? "var(--ok)"
      : gap != null && gap <= 5
        ? "var(--warn)"
        : "var(--bad)";

  const autoCaption = !has
    ? "no data yet"
    : tgt == null
      ? null
      : meets
        ? `Meets the ${tgt}% target`
        : `${gap.toFixed(1)} pts to recover`;
  const cap = caption ?? autoCaption;

  return (
    <div className="card stat gauge">
      <div className="gauge-ring" style={{ width: size, height: size }}>
        <svg
          viewBox="0 0 80 80"
          width={size}
          height={size}
          role="img"
          aria-label={`${label}: ${has ? pct.toFixed(1) + "%" : "no data"}${tgt != null ? `, target ${tgt}%` : ""}`}
        >
          <circle cx="40" cy="40" r={R} fill="none" stroke="var(--line-soft)" strokeWidth="8" />
          <circle
            cx="40"
            cy="40"
            r={R}
            fill="none"
            stroke={color}
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray={CIRC}
            strokeDashoffset={CIRC * (1 - frac)}
            transform="rotate(-90 40 40)"
          />
        </svg>
        <span className="gauge-val num" style={{ color: has ? color : "var(--ink3)" }}>
          {has ? pct.toFixed(1) : "—"}
          <em>%</em>
        </span>
      </div>
      <div className="gauge-body">
        <p className="k">{label}</p>
        {cap ? <p className="s">{cap}</p> : null}
      </div>
    </div>
  );
}
