import { Link, useLocation } from "react-router-dom";
import { useBreadcrumb } from "../hooks/useBreadcrumb";
import { useSession } from "../hooks/useSession";

const MAP = {
  "/overview": "Overview",
  "/devices": "Screens",
  "/content": "Content delivery",
  "/campaigns": "Campaigns",
  "/regions": "Regions",
  "/operations": "Operations",
  "/reconciliation": "Reconciliation",
  "/pending-installations": "Pending installs",
  "/issues": "Issues",
};

// "Organisation / <page>", matching the demo. The org segment is the real
// organization name when the session has one, else the literal word
// "Organisation" so the crumb never starts blank.
export default function Breadcrumb() {
  const location = useLocation();
  const { deviceCrumbName } = useBreadcrumb();
  const { me } = useSession();
  const orgName = me?.current_organization?.name || "Organisation";
  const path = location.pathname === "/" ? "/overview" : location.pathname;

  if (path.startsWith("/device/")) {
    return (
      <div className="crumb">
        <span>{orgName}</span> <span>/</span> <Link to="/devices">Screens</Link> <span>/</span>{" "}
        <b>{deviceCrumbName || "Device"}</b>
      </div>
    );
  }
  return (
    <div className="crumb">
      <span>{orgName}</span> <span>/</span> <b>{MAP[path] || "Overview"}</b>
    </div>
  );
}
