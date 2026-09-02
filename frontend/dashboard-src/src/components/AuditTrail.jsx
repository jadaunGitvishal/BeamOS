// Phase 2 Stage C — plain-language device audit-trail feed.
// `trail` is [{ timestamp, type, message }] newest-first from
// GET /api/dashboard/devices/:id/audit-trail. `type` drives a small colored dot
// so the feed is scannable, not a wall of identical mono text.

const TYPE_STYLE = {
  status: { color: "var(--ink3)", label: "Status" },
  event: { color: "var(--accent)", label: "Device event" },
  telemetry: { color: "var(--warn)", label: "Signal / storage" },
};

export default function AuditTrail({ trail }) {
  if (trail == null) {
    return (
      <p className="empty" style={{ padding: 0 }}>
        Audit trail isn’t available for this device.
      </p>
    );
  }
  if (!trail.length) {
    return (
      <p className="empty" style={{ padding: 0 }}>
        Nothing recorded yet.
      </p>
    );
  }

  const seen = new Set(trail.map((e) => e.type));
  return (
    <>
      <div className="leg" style={{ marginBottom: 10 }}>
        {["status", "event", "telemetry"]
          .filter((t) => seen.has(t))
          .map((t) => (
            <span key={t}>
              <i style={{ background: TYPE_STYLE[t].color, borderRadius: "50%" }}></i>
              {TYPE_STYLE[t].label}
            </span>
          ))}
      </div>
      <div className="log">
        {trail.map((e, i) => {
          const s = TYPE_STYLE[e.type] || TYPE_STYLE.status;
          return (
            <div key={i} style={{ alignItems: "flex-start" }}>
              <time style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span
                  className="dot"
                  style={{ background: s.color, marginTop: 1 }}
                  title={s.label}
                ></span>
                {new Date(e.timestamp * 1000).toLocaleString()}
              </time>
              <p>{e.message}</p>
            </div>
          );
        })}
      </div>
    </>
  );
}
