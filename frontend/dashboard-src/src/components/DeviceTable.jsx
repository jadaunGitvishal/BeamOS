import { useNavigate } from "react-router-dom";
import { timeAgo } from "../lib/format";
import { isAtRisk, isWeakSignal } from "../lib/risk";
import StatusTag from "./StatusTag";
import StatusCategoryTag from "./StatusCategoryTag";

// Free storage: GB (1 dp) from 1024 MB up, else whole MB; "—" when unknown.
function fmtStorage(mb) {
  if (mb === null || mb === undefined) return "—";
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

function DeviceTableRow({ device: d }) {
  const navigate = useNavigate();
  const risk = isAtRisk(d) || isWeakSignal(d);
  const seenTitle =
    d.last_heartbeat !== null && d.last_heartbeat !== undefined ? new Date(d.last_heartbeat * 1000).toLocaleString() : "";
  return (
    <tr className="click" onClick={() => navigate(`/device/${encodeURIComponent(d.id)}`)}>
      <td style={{ fontWeight: 500 }}>{d.name}</td>
      <td>
        <StatusTag status={d.status} />
        {risk ? (
          <span className="plain p-warn" style={{ marginLeft: 6 }}>
            at risk
          </span>
        ) : null}
      </td>
      <td>
        <StatusCategoryTag category={d.status_category} />
      </td>
      <td className="num" style={isWeakSignal(d) ? { color: "var(--warn)" } : undefined}>
        {d.wifi_rssi === null || d.wifi_rssi === undefined ? "—" : `${d.wifi_rssi} dBm`}
      </td>
      <td
        className="num"
        style={d.storage_free_mb !== null && d.storage_free_mb !== undefined && d.storage_free_mb < 500 ? { color: "var(--warn)" } : undefined}
      >
        {fmtStorage(d.storage_free_mb)}
      </td>
      <td className="num" title={seenTitle}>
        {timeAgo(d.last_heartbeat)}
      </td>
    </tr>
  );
}

export default function DeviceTable({ devices }) {
  return (
    <div className="card pad0">
      <table style={{ minWidth: 640 }}>
        <thead>
          <tr>
            <th>Name</th>
            <th>Status</th>
            <th>Category</th>
            <th>Wi-Fi</th>
            <th>Free storage</th>
            <th>Last seen</th>
          </tr>
        </thead>
        <tbody>
          {devices.map((d) => (
            <DeviceTableRow key={d.id} device={d} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
