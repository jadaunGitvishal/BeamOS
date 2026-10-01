// Tiny inline trend line — no axes, no labels — sized to sit inside a table
// cell next to the number it summarises. Coloured by direction: last value
// above the first is green, below is red, flat is grey. Pass `upIsGood={false}`
// for metrics where a rise is bad (e.g. outage minutes).
//
//   <Sparkline values={[97.1, 98.4, 96.0, 99.2]} />
//
// Fewer than two finite values renders nothing (a single point is not a trend).

export default function Sparkline({ values, width = 60, height = 20, upIsGood = true, label }) {
  const pts = (values || []).map(Number).filter(Number.isFinite);
  if (pts.length < 2) return null;

  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const span = max - min || 1;
  const pad = 2; // keep the 1.5px stroke from clipping at the edges
  const x = (i) => pad + (i * (width - pad * 2)) / (pts.length - 1);
  const y = (v) => (max === min ? height / 2 : pad + ((max - v) * (height - pad * 2)) / span);
  const d = pts.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");

  const delta = pts[pts.length - 1] - pts[0];
  const color =
    delta === 0 ? "var(--ink3)" : delta > 0 === upIsGood ? "var(--ok)" : "var(--bad)";

  return (
    <svg
      className="spark"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`${label ? label + " " : ""}trend ${delta > 0 ? "up" : delta < 0 ? "down" : "flat"}`}
    >
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(pts.length - 1)} cy={y(pts[pts.length - 1])} r="1.75" fill={color} />
    </svg>
  );
}
