import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useSession } from "../hooks/useSession";
import { useToast } from "../hooks/useToast";

export default function WorkspaceSwitcher() {
  const { me, activeWorkspace, switchWorkspace } = useSession();
  const { toast } = useToast();
  const navigate = useNavigate();
  const location = useLocation();

  // BeamOS's /api/auth/me returns accessible_workspaces (not workspaces),
  // and marks org-wide access (reached via org_owner/org_admin rather than a
  // direct workspace_members row) by workspace_role being null on that row -
  // same LEFT JOIN semantics Dashboard's own now-retired /api/me used to
  // expose as an explicit org_wide boolean.
  const workspaces = me?.accessible_workspaces || [];
  const orgWide = workspaces.filter((w) => !w.workspace_role);
  const direct = workspaces.filter((w) => w.workspace_role);
  const active = workspaces.find((w) => w.id === activeWorkspace) || null;

  // Custom dropdown, same shape as DevicesView's .export-menu: a ref'd wrapper,
  // aria-haspopup/aria-expanded on the trigger, and an outside-click +
  // Escape listener that only runs while open.
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // On open, move focus into the menu (the active workspace, else the first
  // item) so arrow-key navigation has a starting point - parity with the
  // native <select> this replaces.
  useEffect(() => {
    if (!open || !menuRef.current) return;
    const items = menuRef.current.querySelectorAll(".wsw-item");
    (menuRef.current.querySelector(".wsw-item.on") || items[0])?.focus();
  }, [open]);

  // Same switching behaviour as the previous native <select> onChange: mint a
  // fresh JWT via switchWorkspace, toast, and bounce off a device-detail page
  // (whose device belongs to the workspace we just left).
  async function choose(newWs) {
    setOpen(false);
    if (!newWs || newWs === activeWorkspace) return;
    const data = await switchWorkspace(newWs);
    if (!data) return; // superseded by a later switch, or the session ended
    const label = data.current_workspace ? data.current_workspace.name : "workspace";
    toast(`Switched to ${label}`);
    if (location.pathname.startsWith("/device/")) navigate("/overview");
  }

  function onMenuKeyDown(e) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const items = [...menuRef.current.querySelectorAll(".wsw-item")];
    const i = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown") (items[i + 1] || items[0]).focus();
    else if (e.key === "ArrowUp") (items[i - 1] || items[items.length - 1]).focus();
    else if (e.key === "Home") items[0]?.focus();
    else if (e.key === "End") items[items.length - 1]?.focus();
  }

  const renderItems = (list) =>
    list.map((w) => {
      const on = w.id === activeWorkspace;
      return (
        <button
          key={w.id}
          type="button"
          role="menuitemradio"
          aria-checked={on}
          className={`wsw-item${on ? " on" : ""}`}
          onClick={() => choose(w.id)}
        >
          <span className="wsw-item-tick" aria-hidden="true" />
          <span className="wsw-item-text">
            <span className="wsw-item-name">{w.name}</span>
            <span className="wsw-item-org">{w.organization_name}</span>
          </span>
        </button>
      );
    });

  return (
    <div className="wsw" ref={wrapRef}>
      <small id="wsw-label">Workspace</small>
      <button
        type="button"
        className="wsw-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-labelledby="wsw-label wsw-current"
        onClick={() => setOpen((v) => !v)}
      >
        <span id="wsw-current" className="wsw-current">
          {active ? (
            <>
              <span className="wsw-current-name">{active.name}</span>
              <span className="wsw-current-org">{active.organization_name}</span>
            </>
          ) : (
            <span className="wsw-current-name">Select workspace</span>
          )}
        </span>
        <span className="wsw-chevron" aria-hidden="true" />
      </button>
      {open && (
        <div
          className="wsw-menu"
          role="menu"
          aria-label="Switch workspace"
          ref={menuRef}
          onKeyDown={onMenuKeyDown}
        >
          {orgWide.length ? (
            <>
              <p className="wsw-group" role="presentation">
                Your workspaces
              </p>
              {renderItems(direct)}
              <p className="wsw-group" role="presentation">
                Also in your org
              </p>
              {renderItems(orgWide)}
            </>
          ) : (
            renderItems(workspaces)
          )}
        </div>
      )}
    </div>
  );
}
