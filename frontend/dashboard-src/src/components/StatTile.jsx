export default function StatTile({ label, value, sub, card }) {
  return (
    <div className={card ? "card stat" : "stat"}>
      <p className="k">{label}</p>
      <p className="v num">{value}</p>
      {sub ? <p className="s">{sub}</p> : null}
    </div>
  );
}
