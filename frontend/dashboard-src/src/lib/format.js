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

// Overview header "Reporting period": a periodWindow() range as day-first
// dates, collapsing the shared month/year - "18–24 Aug 2026",
// "25 Aug – 24 Sep 2026", "28 Dec 2025 – 3 Jan 2026".
// Fixed three-letter months: toLocaleDateString("en-GB") renders September
// as "Sept" in current ICU builds.
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function fmtPeriodRange(start, end) {
  const dm = (x) => `${x.getDate()} ${MON[x.getMonth()]}`;
  const endStr = `${dm(end)} ${end.getFullYear()}`;
  if (start.getFullYear() !== end.getFullYear()) return `${dm(start)} ${start.getFullYear()} – ${endStr}`;
  if (start.getMonth() !== end.getMonth()) return `${dm(start)} – ${endStr}`;
  return `${start.getDate()}–${endStr}`;
}

export function periodLabel(period) {
  return period === 1 ? "last 24 hours" : `last ${period} days`;
}

// Ref 32: GPS coords off telemetry. Null/absent (no permission or no fix) is the
// common case -> caller shows "—". Mirrors the main app's renderCoords().
export function fmtCoords(lat, lng) {
  if (lat === null || lat === undefined || lng === null || lng === undefined) return null;
  return `${Number(lat).toFixed(6)}, ${Number(lng).toFixed(6)}`;
}

export function osmUrl(lat, lng) {
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=15/${lat}/${lng}`;
}

// Ref 45 Stage B: short local-time label for telemetry-history chart X axis
// ticks (e.g. "14:32"). Absolute time, not timeAgo()'s relative "5m ago" -
// a trend chart's axis needs a fixed reference, not one that reflows as the
// page sits open.
export function fmtTime(epochSeconds) {
  if (epochSeconds === null || epochSeconds === undefined) return "";
  return new Date(epochSeconds * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// Ref 44: short label for the network-usage chart's X axis (e.g. "Sep 11").
// `date` is the 'YYYY-MM-DD' string device_network_usage stores - parsed as
// UTC noon (not midnight) so the label can't drift a day off in a timezone
// west of UTC, same reasoning periodWindow's callers already rely on.
export function fmtDate(date) {
  if (!date) return "";
  return new Date(`${date}T12:00:00Z`).toLocaleDateString([], { month: "short", day: "numeric" });
}

// Ref 44: bytes -> a short "N.N MB"/"N.N GB" label for the network-usage
// chart's tooltip/axis - bytes_received/bytes_sent arrive as raw bytes.
export function fmtBytes(bytes) {
  if (bytes === null || bytes === undefined) return "—";
  const mb = Number(bytes) / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(1)} MB`;
}
