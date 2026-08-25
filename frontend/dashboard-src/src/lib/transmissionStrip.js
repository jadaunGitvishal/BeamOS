export function buildStatusStrip(history, startMs, endMs) {
  const totalMs = endMs - startMs;
  if (!history.length) return [{ w: 100, color: "var(--line-soft)", label: "No status changes in this window" }];
  const segs = [];
  const firstMs = history[0].timestamp * 1000;
  if (firstMs > startMs) {
    segs.push({ w: ((firstMs - startMs) / totalMs) * 100, color: "var(--line-soft)", label: "No data" });
  }
  for (let i = 0; i < history.length; i++) {
    const cur = history[i];
    const curMs = Math.max(cur.timestamp * 1000, startMs);
    const nextMs = i + 1 < history.length ? history[i + 1].timestamp * 1000 : endMs;
    const w = Math.max(0, ((nextMs - curMs) / totalMs) * 100);
    segs.push({
      w,
      color: cur.status === "online" ? "var(--on)" : "var(--off)",
      label: `${cur.status} — ${new Date(cur.timestamp * 1000).toLocaleString()}`,
    });
  }
  return segs;
}
