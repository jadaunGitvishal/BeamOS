import { Link, useLocation } from "react-router-dom";
import { useBreadcrumb } from "../hooks/useBreadcrumb";

const MAP = {
  "/overview": "Overview",
  "/devices": "Screens",
  "/content": "Content delivery",
  "/issues": "Issues",
};

export default function Breadcrumb() {
  const location = useLocation();
  const { deviceCrumbName } = useBreadcrumb();
  const path = location.pathname === "/" ? "/overview" : location.pathname;

  if (path.startsWith("/device/")) {
    return (
      <div className="crumb">
        <Link to="/devices">Screens</Link> <span>/</span> <b>{deviceCrumbName || "Device"}</b>
      </div>
    );
  }
  return (
    <div className="crumb">
      <b>{MAP[path] || "Overview"}</b>
    </div>
  );
}
