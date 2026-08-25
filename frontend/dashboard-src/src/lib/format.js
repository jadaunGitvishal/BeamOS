export const n0 = (v) => Math.round(v).toLocaleString("en-IN");

export const cCol = (v) => (v >= 90 ? "var(--ok)" : v >= 75 ? "var(--warn)" : "var(--bad)");

export const cPill = (v) => (v >= 90 ? "p-ok" : v >= 75 ? "p-warn" : "p-bad");

export function formatDuration(totalSeconds) {
  const sec = Number(totalSeconds) || 0;
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

export function timeAgo(epochSeconds) {
  if (epochSeconds === null || epochSeconds === undefined) return "—";
  const diff = Date.now() / 1000 - epochSeconds;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function periodWindow(period) {
  const end = new Date();
  const start = new Date(Date.now() - period * 86400000);
  return { start, end };
}

export function isoDateOnly(d) {
  return d.toISOString().slice(0, 10);
}

export function periodLabel(period) {
  return period === 1 ? "last 24 hours" : `last ${period} days`;
}
