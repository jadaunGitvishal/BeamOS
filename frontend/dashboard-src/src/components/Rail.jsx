import { useClock } from "../hooks/useClock";
import { useSession } from "../hooks/useSession";
import Nav from "./Nav";
import WorkspaceSwitcher from "./WorkspaceSwitcher";

export default function Rail() {
  const clock = useClock();
  const { me, logout } = useSession();
  // /api/auth/me spreads the user's fields at the top level (...req.user),
  // so the email is me.email — same source the Topbar used.
  const email = me?.email || "";
  const initial = email.trim().charAt(0) || "?";

  return (
    <aside className="rail">
      <div className="brand">
        <span className="brand-name">
          CXO1<span>.ai</span>
        </span>
      </div>
      <WorkspaceSwitcher />
      <Nav />
      <div className="railfoot">
        <div className="railstatus">
          <span className="livedot" aria-hidden="true"></span>
          <div>
            <strong>Fleet sync live</strong>
            <small>as of {clock}</small>
          </div>
        </div>
        <div className="railuser">
          <span className="railuser-av" aria-hidden="true">
            {initial}
          </span>
          <span className="railuser-email" title={email}>
            {email}
          </span>
          <button type="button" onClick={() => logout()}>
            Sign out
          </button>
        </div>
      </div>
    </aside>
  );
}
