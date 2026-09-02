import { Fragment } from "react";

// Phase 2 Stage C — 7-day online/offline heatmap (day rows x hour columns) plus
// the server's simple repeated-issue callout.
// `heatmap` = { days, start: 'YYYY-MM-DD', cells: [{day,hour,online_pct,covered_sec}], pattern|null }.

// green = mostly online that hour, amber = patchy, red = mostly offline,
// grey = no status data for that hour (older than retention, or a gap).
function cellColor(pct) {
  if (pct == null) return "var(--line-soft)";
  if (pct >= 90) return "var(--on)";
  if (pct >= 50) return "var(--warn)";
  return "var(--off)";
}

function addDays(iso, n) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}

const HOURS = Array.from({ length: 24 }, (_, h) => h);

export default function StatusHeatmap({ heatmap }) {
  if (heatmap == null) {
    return (
      <p className="empty" style={{ padding: 0 }}>
        Heatmap isn’t available for this device.
      </p>
    );
  }
  const cells = heatmap.cells || [];
  if (!cells.length) {
    return (
      <p className="empty" style={{ padding: 0 }}>
        No status history recorded yet.
      </p>
    );
  }

  const byKey = new Map(cells.map((c) => [`${c.day}|${c.hour}`, c]));
  const days = Array.from({ length: heatmap.days }, (_, i) => {
    const d = addDays(heatmap.start, i);
    return {
      iso: d.toISOString().slice(0, 10),
      label: d.toLocaleDateString(undefined, { weekday: "short", day: "2-digit", timeZone: "UTC" }),
    };
  });

  const p = heatmap.pattern;

  return (
    <>
      {p && p.detected ? (
        <div
          className="exc rise"
          style={{ borderLeftColor: "var(--bad)", background: "#FBE9E7", marginBottom: 12 }}
        >
          <h3 style={{ margin: 0, fontSize: 13, color: "var(--bad)" }}>{p.message}</h3>
        </div>
      ) : null}

      <div style={{ overflowX: "auto" }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "64px repeat(24, minmax(11px, 1fr))",
            gap: 2,
            minWidth: 460,
          }}
        >
          <div></div>
          {HOURS.map((h) => (
            <div
              key={h}
              style={{ fontSize: 8.5, color: "var(--ink3)", textAlign: "center", fontFamily: "var(--f-mono)" }}
            >
              {h % 6 === 0 ? h : ""}
            </div>
          ))}
          {days.map((day) => (
            <Fragment key={day.iso}>
              <div
                style={{ fontSize: 10.5, color: "var(--ink2)", fontFamily: "var(--f-mono)", alignSelf: "center", whiteSpace: "nowrap" }}
              >
                {day.label}
              </div>
              {HOURS.map((h) => {
                const c = byKey.get(`${day.iso}|${h}`);
                const pct = c ? c.online_pct : null;
                return (
                  <div
                    key={day.iso + "-" + h}
                    title={
                      c
                        ? `${day.label} ${String(h).padStart(2, "0")}:00 — ${pct}% online`
                        : `${day.label} ${String(h).padStart(2, "0")}:00 — no data`
                    }
                    style={{ height: 15, borderRadius: 2, background: cellColor(pct) }}
                  ></div>
                );
              })}
            </Fragment>
          ))}
        </div>
      </div>

      <div className="leg" style={{ marginTop: 10 }}>
        <span><i style={{ background: "var(--on)" }}></i>Mostly online</span>
        <span><i style={{ background: "var(--warn)" }}></i>Patchy</span>
        <span><i style={{ background: "var(--off)" }}></i>Mostly offline</span>
        <span><i style={{ background: "var(--line-soft)" }}></i>No data</span>
      </div>
    </>
  );
}
