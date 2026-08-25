export class UnauthenticatedError extends Error {
  constructor() {
    super("unauthenticated");
    this.name = "UnauthenticatedError";
  }
}

// Auth: Authorization header + localStorage token, same as BeamOS's own
// frontend/js/api.js getAuthHeaders(). Now that the merged Dashboard runs on
// the same origin/server as BeamOS, there's no separate dash_token cookie
// session and no per-request X-Workspace-Id override - workspace context
// travels in the JWT's current_workspace_id claim instead (set by
// POST /api/auth/switch-workspace, see SessionContext's switchWorkspace).
// The 401-redirect-to-login behavior stays out of here - callers catch
// UnauthenticatedError and flip session state instead, see useApi/useSession.
function getAuthHeaders() {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function apiFetch(path, { signal } = {}) {
  const resp = await fetch(path, { headers: getAuthHeaders(), signal });
  if (resp.status === 401) {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    throw new UnauthenticatedError();
  }
  if (!resp.ok) throw new Error(`${path} -> ${resp.status}`);
  return resp.json();
}
