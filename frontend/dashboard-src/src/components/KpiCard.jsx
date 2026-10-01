import { Link } from "react-router-dom";
import ProgressBar from "./ProgressBar";

// Overview KPI card: coloured top border, big number with an optional inline
// "of N", a muted sub-line, an optional thin ProgressBar, and a top-right
// link to the page that explains the number. Plain props like StatTile;
// `color` is a CSS colour/token used for the border and the bar.
//
//   <KpiCard label="Screens on air now" value={9} ofValue={12}
//     subLine="75% of fleet" percentage={75} color="var(--on)" linkTo="/devices" />
//
// `percentage` is optional - leave it out when no honest share exists, and the
// bar is omitted rather than drawn from a made-up denominator.

export default function KpiCard({ label, value, ofValue, subLine, percentage, color = "var(--line)", linkTo }) {
  return (
    <div className="card stat kpi" style={{ borderTopColor: color }}>
      <div className="kpi-head">
        <p className="k">{label}</p>
        {linkTo ? (
          <Link className="kpi-link" to={linkTo} aria-label={`Open ${label}`} title={`Open ${label}`}>
            ↗
          </Link>
        ) : null}
      </div>
      <p className="v num">
        {value}
        {ofValue != null ? <small> of {ofValue}</small> : null}
      </p>
      {subLine ? <p className="s">{subLine}</p> : null}
      {percentage != null ? (
        <div className="kpi-bar">
          <ProgressBar percentage={percentage} color={color} showValue={false} />
        </div>
      ) : null}
    </div>
  );
}
