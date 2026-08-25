export default function TransmissionStrip({ segments, className = "" }) {
  return (
    <div className={`tx ${className}`}>
      {segments.map((s, i) => (
        <i key={i} style={{ width: `${s.w}%`, background: s.color }} title={s.label}></i>
      ))}
    </div>
  );
}
