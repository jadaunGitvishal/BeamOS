import Breadcrumb from "./Breadcrumb";
import PeriodSelector from "./PeriodSelector";

// The user's email + Sign out now live in the sidebar footer (Rail.jsx),
// matching the demo — the Topbar keeps only the breadcrumb + period control.
export default function Topbar() {
  return (
    <header className="top">
      <Breadcrumb />
      <div className="topsp"></div>
      <div className="ctl">
        <PeriodSelector />
      </div>
    </header>
  );
}
