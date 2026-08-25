import { useNavigate } from "react-router-dom";
import { timeAgo } from "../lib/format";
import { isAtRisk, isWeakSignal } from "../lib/risk";
import StatusTag from "./StatusTag";

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
      <td className="num" title={seenTitle}>
        {timeAgo(d.last_heartbeat)}
      </td>
    </tr>
  );
}

export default function DeviceTable({ devices }) {
  return (
    <div className="card pad0">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Status</th>
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
