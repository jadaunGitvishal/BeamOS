export default function StatusTag({ status }) {
  return (
    <span className="tag" style={{ color: status === "online" ? "var(--on)" : "var(--off)" }}>
      {status}
    </span>
  );
}
