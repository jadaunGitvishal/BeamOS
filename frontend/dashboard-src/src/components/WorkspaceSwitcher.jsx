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

  async function handleChange(e) {
    const newWs = e.target.value;
    if (!newWs || newWs === activeWorkspace) return;
    const data = await switchWorkspace(newWs);
    if (!data) return; // superseded by a later switch, or the session ended
    const label = data.current_workspace ? data.current_workspace.name : "workspace";
    toast(`Switched to ${label}`);
    if (location.pathname.startsWith("/device/")) navigate("/overview");
  }

  const renderOptions = (list) =>
    list.map((w) => (
      <option key={w.id} value={w.id}>
        {w.name} · {w.organization_name}
      </option>
    ));

  return (
    <div className="wsw">
      <span style={{ width: "100%" }}>
        <small>Workspace</small>
        <select id="wsw-select" className="wsw-select" value={activeWorkspace || ""} onChange={handleChange}>
          {orgWide.length ? (
            <>
              <optgroup label="Your workspaces">{renderOptions(direct)}</optgroup>
              <optgroup label="Also in your org">{renderOptions(orgWide)}</optgroup>
            </>
          ) : (
            renderOptions(workspaces)
          )}
        </select>
      </span>
    </div>
  );
}
