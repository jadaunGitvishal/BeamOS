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
export function getAuthHeaders() {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// Fetch a binary resource (e.g. a field-visit photo) as an object URL. An <img>
// tag can't carry the Authorization header, and unlike /api/devices/:id/screenshot
// the field-visit photo route has no ?token= fallback — so pull the bytes with a
// normal authed fetch and hand back a blob: URL. Caller must revokeObjectURL it.
export async function apiObjectUrl(path, { signal } = {}) {
  const resp = await fetch(path, { headers: getAuthHeaders(), signal });
  if (resp.status === 401) {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    throw new UnauthenticatedError();
  }
  if (!resp.ok) throw new Error(`${path} -> ${resp.status}`);
  return URL.createObjectURL(await resp.blob());
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
