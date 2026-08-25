import { useSession } from "../hooks/useSession";
import Breadcrumb from "./Breadcrumb";
import PeriodSelector from "./PeriodSelector";

export default function Topbar() {
  const { me, logout } = useSession();

  return (
    <header className="top">
      <Breadcrumb />
      <div className="topsp"></div>
      <div className="ctl">
        <PeriodSelector />
        <div className="userbox">
          {/* BeamOS's /api/auth/me spreads the user's fields at the top level
              (...req.user), not nested under a `user` key. */}
          <span>{me?.email}</span>
          <button className="btn" onClick={() => logout()}>
            Sign out
          </button>
        </div>
      </div>
    </header>
  );
}
