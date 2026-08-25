import { Link } from "react-router-dom";
import { isAtRisk, isWeakSignal } from "../lib/risk";
import { TileScreenshot } from "./DeviceScreenshot";

export default function DeviceTile({ device: d }) {
  const cls = d.status === "offline" ? "off" : isAtRisk(d) || isWeakSignal(d) ? "warn" : "";
  return (
    <Link to={`/device/${encodeURIComponent(d.id)}`} className={`tile ${cls}`}>
      <div className="scr">
        {d.screenshot_path ? (
          <TileScreenshot deviceId={d.id} />
        ) : d.status === "offline" ? (
          "offline"
        ) : (
          "no screenshot"
        )}
      </div>
      <div className="lb">
        <span className="dot" style={{ background: d.status === "online" ? "var(--on)" : "var(--off)" }}></span>
        <span>{d.name}</span>
      </div>
    </Link>
  );
}
