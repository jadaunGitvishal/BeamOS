// Ref 38 — the server-computed status_category ('active'/'inactive'/'offline')
// rendered as one of the established theme pills:
//   active   -> p-ok   (green)   online AND not blocked
//   inactive -> p-warn (amber)   blocked, regardless of connectivity
//   offline  -> p-bad  (red)     not blocked but not connected
const MAP = {
  active: { cls: "p-ok", label: "Active" },
  inactive: { cls: "p-warn", label: "Inactive" },
  offline: { cls: "p-bad", label: "Offline" },
};

export default function StatusCategoryTag({ category }) {
  const m = MAP[category];
  if (!m) return null;
  return <span className={"tag " + m.cls}>{m.label}</span>;
}
