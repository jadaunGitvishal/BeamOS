import { useClock } from "../hooks/useClock";
import Nav from "./Nav";
import WorkspaceSwitcher from "./WorkspaceSwitcher";

export default function Rail() {
  const clock = useClock();
  return (
    <aside className="rail">
      <div className="brand">
        <span className="mark">
          <i></i>
        </span>
        <span>
          <b>BeamOS</b>
          <span>Dashboard</span>
        </span>
      </div>
      <WorkspaceSwitcher />
      <p className="navgrp">Fleet</p>
      <Nav />
      <div className="railfoot">
        Fleet sync live
        <br />
        <span className="mono">{clock}</span>
      </div>
    </aside>
  );
}
