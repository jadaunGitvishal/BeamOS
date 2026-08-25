import { Link } from "react-router-dom";
import { n0 } from "../lib/format";
import { isWeakSignal } from "../lib/risk";
import StatusTag from "./StatusTag";

export default function AttentionCard({ device: d }) {
  const reasons = [];
  if (d.storage_free_mb !== null && d.storage_free_mb !== undefined && d.storage_free_mb < 500)
    reasons.push(`Storage free is ${n0(d.storage_free_mb)} MB, below the 500 MB threshold.`);
  if (d.ram_total_mb > 0 && d.ram_free_mb / d.ram_total_mb < 0.1)
    reasons.push(`RAM free is ${((d.ram_free_mb / d.ram_total_mb) * 100).toFixed(1)}% of total, below the 10% threshold.`);
  if (isWeakSignal(d)) reasons.push(`Wi-Fi signal is ${d.wifi_rssi} dBm, weak.`);
  const color = d.status === "offline" ? "var(--bad)" : "var(--warn)";
  const metaBits = [d.status];
  if (d.storage_free_mb !== null && d.storage_free_mb !== undefined) metaBits.push(`${n0(d.storage_free_mb)} MB free`);
  if (d.wifi_rssi !== null && d.wifi_rssi !== undefined) metaBits.push(`${d.wifi_rssi} dBm`);

  return (
    <div className="exc rise" style={{ borderLeftColor: color }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
        <div style={{ minWidth: 0 }}>
          <h3>{d.name}</h3>
          <p>{reasons.join(" ")}</p>
        </div>
        <StatusTag status={d.status} />
      </div>
      <div className="meta">
        {metaBits.map((m, i) => (
          <span key={i}>{String(m)}</span>
        ))}
      </div>
      <div className="ctl mt16">
        <Link className="btn" to={`/device/${encodeURIComponent(d.id)}`}>
          Open device
        </Link>
      </div>
    </div>
  );
}
