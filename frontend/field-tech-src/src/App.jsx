import { useEffect, useState } from "react";
import LoginScreen from "./screens/LoginScreen.jsx";
import VisitFlow from "./screens/VisitFlow.jsx";
import ReportFlow from "./screens/ReportFlow.jsx";
import { getToken, getMe, getStoredMode, clearSession } from "./lib/api.js";

// authState: "loading" | "in" | "out"
// mode: "technician" | "management" - which LoginScreen form was used (see
// lib/api.js's getStoredMode/setSession comment for why this, not a JWT
// role claim, is the branch signal). Only meaningful once authState === "in".
export default function App() {
  const [authState, setAuthState] = useState("loading");
  const [me, setMe] = useState(null);
  const [mode, setMode] = useState("technician");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!getToken()) {
        setAuthState("out");
        return;
      }
      try {
        const data = await getMe();
        if (cancelled) return;
        setMe(data);
        setMode(getStoredMode());
        setAuthState("in");
      } catch {
        if (cancelled) return;
        clearSession();
        setAuthState("out");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function signOut() {
    clearSession();
    setMe(null);
    setAuthState("out");
  }

  if (authState === "loading") {
    return (
      <main className="screen screen--center">
        <p className="muted">Loading…</p>
      </main>
    );
  }

  if (authState === "in") {
    return mode === "management" ? (
      <ReportFlow me={me} onLogout={signOut} onSessionExpired={signOut} />
    ) : (
      <VisitFlow me={me} onLogout={signOut} onSessionExpired={signOut} />
    );
  }

  return (
    <LoginScreen
      onAuthed={(user, loginMode) => {
        setMe(user);
        setMode(loginMode);
        setAuthState("in");
      }}
    />
  );
}
