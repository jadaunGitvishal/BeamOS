import { useState } from "react";

// GET /api/devices/:id/screenshot requires auth, and an <img> tag can't set
// an Authorization header - BeamOS's own frontend/js/views/dashboard.js and
// device-detail.js hit this same constraint and pass the token as a ?token=
// query param (the route accepts either), so this mirrors that exact
// pattern rather than inventing a second convention.
function screenshotUrl(deviceId) {
  const token = localStorage.getItem("token");
  return `/api/devices/${encodeURIComponent(deviceId)}/screenshot?token=${encodeURIComponent(token || "")}`;
}

// Tile thumbnail: on load failure, replaced with plain text (matches the
// vanilla tile's inline onerror="this.replaceWith(textNode('unavailable'))").
export function TileScreenshot({ deviceId }) {
  const [failed, setFailed] = useState(false);
  if (failed) return "unavailable";
  return (
    <img
      src={screenshotUrl(deviceId)}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

// Device-detail screenshot: on load failure, just hidden (matches the
// vanilla onerror="this.style.display='none'").
export function DetailScreenshot({ deviceId }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <img
      className="shot"
      src={screenshotUrl(deviceId)}
      alt=""
      onError={() => setFailed(true)}
    />
  );
}
