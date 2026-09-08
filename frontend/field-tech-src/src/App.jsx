import { useEffect, useState } from "react";
import LoginScreen from "./screens/LoginScreen.jsx";
import VisitFlow from "./screens/VisitFlow.jsx";
import { getToken, getMe, clearSession } from "./lib/api.js";

// authState: "loading" | "in" | "out"
export default function App() {
  const [authState, setAuthState] = useState("loading");
  const [me, setMe] = useState(null);

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
    return <VisitFlow me={me} onLogout={signOut} onSessionExpired={signOut} />;
  }

  return (
    <LoginScreen
      onAuthed={(user) => {
        setMe(user);
        setAuthState("in");
      }}
    />
  );
}
