import { createContext, useCallback, useEffect, useRef, useState } from "react";
import { apiFetch, UnauthenticatedError } from "../lib/api";

export const SessionContext = createContext(null);

// authState: "loading" | "authenticated" | "unauthenticated"
//
// Session now IS BeamOS's own session - same localStorage token, same
// GET /api/auth/me, same POST /api/auth/switch-workspace. No more separate
// dash_token cookie or X-Workspace-Id header (see lib/api.js). Since the
// token itself carries current_workspace_id, /api/auth/me always resolves
// the right workspace on its own - there's no local "remembered workspace"
// override to reconcile against the server's answer like phase 1 had.
export function SessionProvider({ children }) {
  const [me, setMe] = useState(null);
  const [authState, setAuthState] = useState("loading");
  const [activeWorkspace, setActiveWorkspace] = useState(null);
  const [navCounts, setNavCounts] = useState({ devices: null, issues: null });

  // Guards the workspace-switcher race condition (rapid double-switch:
  // whichever /api/auth/me refetch resolved last used to win, regardless of
  // which selection was newer).
  const switchRequestId = useRef(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // No token at all -> skip the network round trip entirely, matching
      // the main app's boot() check (frontend/js/app.js).
      if (!localStorage.getItem("token")) {
        setAuthState("unauthenticated");
        return;
      }
      try {
        const data = await apiFetch("/api/auth/me");
        if (cancelled) return;
        setMe(data);
        setActiveWorkspace(data.current_workspace_id || null);
        setAuthState("authenticated");
      } catch (err) {
        if (cancelled) return;
        if (err instanceof UnauthenticatedError) {
          setAuthState("unauthenticated");
        } else {
          console.error(err);
          setAuthState("unauthenticated");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const markUnauthenticated = useCallback(() => {
    setMe(null);
    setAuthState("unauthenticated");
  }, []);

  // Mints a fresh JWT with the new current_workspace_id baked in (BeamOS's
  // own switch mechanism - frontend/js/api.js switchWorkspace ->
  // POST /api/auth/switch-workspace) and stores it, then re-fetches /api/auth/me
  // for the new session snapshot. One switch mechanism shared with the main
  // app, not a second X-Workspace-Id-header system running in parallel.
  const switchWorkspace = useCallback(async (newWs) => {
    if (!newWs) return null;
    const requestId = ++switchRequestId.current;
    try {
      const resp = await fetch("/api/auth/switch-workspace", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${localStorage.getItem("token")}`,
        },
        body: JSON.stringify({ workspace_id: newWs }),
      });
      if (resp.status === 401) throw new UnauthenticatedError();
      if (!resp.ok) throw new Error(`switch-workspace -> ${resp.status}`);
      const sw = await resp.json();
      if (requestId !== switchRequestId.current) return null; // superseded by a later switch
      if (sw.token) localStorage.setItem("token", sw.token);

      const data = await apiFetch("/api/auth/me");
      if (requestId !== switchRequestId.current) return null;
      setMe(data);
      setActiveWorkspace(data.current_workspace_id || null);
      return data;
    } catch (err) {
      if (requestId !== switchRequestId.current) return null;
      if (err instanceof UnauthenticatedError) {
        markUnauthenticated();
        return null;
      }
      throw err;
    }
  }, [markUnauthenticated]);

  const logout = useCallback(() => {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    markUnauthenticated();
  }, [markUnauthenticated]);

  const setDeviceCount = useCallback((n) => {
    setNavCounts((c) => (c.devices === n ? c : { ...c, devices: n }));
  }, []);
  const setIssueCount = useCallback((n) => {
    setNavCounts((c) => (c.issues === n ? c : { ...c, issues: n }));
  }, []);

  const value = {
    me,
    authState,
    activeWorkspace,
    navCounts,
    switchWorkspace,
    markUnauthenticated,
    logout,
    setDeviceCount,
    setIssueCount,
  };

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
