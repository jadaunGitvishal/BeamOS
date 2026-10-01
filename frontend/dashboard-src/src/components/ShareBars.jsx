import ProgressBar from "./ProgressBar";
import { n0 } from "../lib/format";

// A card of labelled share-of-total bars (count / total), reusing the
// Campaigns/Content .cdel row layout. rows: [{ key, label, count, color }].
export default function ShareBars({ title, note, rows, total, foot }) {
  return (
    <div className="card panel">
      <div className="panel-head">
        <div>
          <h2>{title}</h2>
          {note ? <p className="panel-note">{note}</p> : null}
        </div>
      </div>
      <div className="cdel">
        {rows.map((r) => (
          <div className="cdel-row" key={r.key}>
            <div className="cdel-name">
              <span>{r.label}</span>
              <small>
                {n0(r.count)} ticket{r.count === 1 ? "" : "s"}
              </small>
            </div>
            <ProgressBar percentage={total ? Math.round((r.count / total) * 1000) / 10 : null} color={r.color} />
          </div>
        ))}
      </div>
      {foot ? (
        <p className="panel-note" style={{ margin: "12px 0 0" }}>
          {foot}
        </p>
      ) : null}
    </div>
  );
}
