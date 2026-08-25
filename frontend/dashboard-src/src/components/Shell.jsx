import { Outlet } from "react-router-dom";
import Rail from "./Rail";
import Topbar from "./Topbar";
import ToastHost from "./ToastHost";

export default function Shell() {
  return (
    <>
      <div className="shell">
        <Rail />
        <div className="main">
          <Topbar />
          <main className="wrap" id="view" tabIndex={-1}>
            <Outlet />
          </main>
        </div>
      </div>
      <ToastHost />
    </>
  );
}
