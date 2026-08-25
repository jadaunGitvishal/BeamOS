import { useEffect } from "react";

// No separate Dashboard login anymore - this IS BeamOS now, so "signed out"
// means "no valid BeamOS session", and the only sign-in page is BeamOS's own
// (this bundle is a distinct page at /dashboard, not an SPA route inside the
// main app, so getting there is a full navigation, not a client-side one -
// see main app's frontend/js/api.js 401 handler for the same pattern:
// clear the stale token, then send the browser to the login screen).
export default function AuthPlaceholder() {
  useEffect(() => {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    window.location.href = "/#/login";
  }, []);

  return null;
}
