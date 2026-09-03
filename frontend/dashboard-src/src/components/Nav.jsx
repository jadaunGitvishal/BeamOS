import { Link, useLocation } from "react-router-dom";
import { useSession } from "../hooks/useSession";

// Two groups, matching the CXO1 Assurance Dashboard demo. Every item always
// renders (IssuesView degrades gracefully to a "platform admin only" card for
// non-admins, so it's safe to show).
const NAV_GROUPS = [
  {
    label: "Monitor",
    items: [
      { path: "/overview", label: "Overview", icon: "overview", countKey: null },
      { path: "/campaigns", label: "Campaigns", icon: "campaigns", countKey: null },
      { path: "/content", label: "Content delivery", icon: "content", countKey: null },
      { path: "/operations", label: "Operations", icon: "operations", countKey: null },
    ],
  },
  {
    label: "Explore",
    items: [
      { path: "/regions", label: "Regions", icon: "regions", countKey: null },
      { path: "/devices", label: "Screens", icon: "screens", countKey: "devices" },
      { path: "/issues", label: "Issues", icon: "issues", countKey: "issues" },
    ],
  },
];

// Each icon is drawn purely in CSS (.nav-icon.nav-<key> in beamos-theme.css)
// from a fixed number of positioned <i> elements. This map only says how many
// <i> to emit per icon.
const ICON_PARTS = {
  overview: 3,
  campaigns: 3,
  operations: 3,
  regions: 3,
  screens: 3,
  content: 3,
  issues: 2,
};

export default function Nav() {
  const { navCounts } = useSession();
  const location = useLocation();
  const cur = location.pathname === "/" ? "/overview" : location.pathname;

  return (
    <nav className="nav" aria-label="Dashboard sections">
      {NAV_GROUPS.map((group) => (
        <div className="navgroup" key={group.label}>
          <p className="navgrp">{group.label}</p>
          {group.items.map((n) => {
            const cnt = n.countKey ? navCounts[n.countKey] : null;
            const on = cur === n.path;
            return (
              <Link key={n.path} to={n.path} className={on ? "on" : ""} aria-current={on ? "page" : undefined}>
                <span className={`nav-icon nav-${n.icon}`} aria-hidden="true">
                  {Array.from({ length: ICON_PARTS[n.icon] }, (_, i) => (
                    <i key={i} />
                  ))}
                </span>
                <span className="nav-label">{n.label}</span>
                {cnt !== null && cnt !== undefined ? <em className="cnt">{cnt}</em> : null}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
