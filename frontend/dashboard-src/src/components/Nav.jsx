import { Link, useLocation } from "react-router-dom";
import { useSession } from "../hooks/useSession";

const BASE_NAV = [
  { path: "/overview", label: "Overview", countKey: null },
  { path: "/devices", label: "Screens", countKey: "devices" },
  { path: "/content", label: "Content delivery", countKey: null },
];

export default function Nav() {
  const { me, navCounts } = useSession();
  const location = useLocation();
  const items = me?.is_platform_admin
    ? [...BASE_NAV, { path: "/issues", label: "Issues", countKey: "issues" }]
    : BASE_NAV;
  const cur = location.pathname === "/" ? "/overview" : location.pathname;

  return (
    <nav className="nav">
      {items.map((n) => {
        const cnt = n.countKey ? navCounts[n.countKey] : null;
        return (
          <Link key={n.path} to={n.path} className={cur === n.path ? "on" : ""}>
            <span className="gl"></span>
            {n.label}
            {cnt !== null && cnt !== undefined ? <span className="cnt">{cnt}</span> : null}
          </Link>
        );
      })}
    </nav>
  );
}
