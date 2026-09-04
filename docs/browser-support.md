# Browser Support

This is BeamOS's browser support statement for the two web surfaces an operator
uses day to day:

- **Main app** (`frontend/js/`) — login, device management, content, playlists,
  layouts, schedule, settings/provisioning, served at `/app`.
- **React Dashboard** (`frontend/dashboard-src/`) — the CXO1 Assurance
  Dashboard (Overview, Operations, Campaigns, Regions, Screens, Device
  Detail), served at `/dashboard`.

It does not cover the Android player app (`android/`) or the browser-based
kiosk player (`/player`), which have their own compatibility notes.

## Support matrix

| Browser | Status | Basis |
|---|---|---|
| **Google Chrome** | ✅ Fully supported | Primary development and QA browser. Every feature in this codebase — including everything shipped this session — is built and verified against Chrome first, via real Chrome (not just code review), continuously through development. |
| **Microsoft Edge** | ✅ Verified | Real Microsoft Edge (Chromium-based, v152.0.4191.53), tested end-to-end 2026-09-04 — see [Edge test results](#microsoft-edge-test-results) below. Edge shares Chrome's Blink/V8 engine, so this is expected to hold across the Chromium-based browser family; each release is not individually re-verified. |
| **Safari** | ⚠️ Not tested — platform limitation | Safari does not run on Windows, and this development environment is Windows-only. No Safari testing (WebKit-specific CSS/JS behavior, iOS Safari touch handling, etc.) has been performed at any point. This is a genuine gap, not a claim of support — see [Safari](#safari) below. |
| **Firefox** | Not tested | Out of scope for this round; no Gecko-specific testing has been done. |

## Microsoft Edge test results

**Method:** real Microsoft Edge (`msedge.exe`, v152.0.4191.53, the actual
browser installed on this Windows machine — not a Chrome build wearing an
Edge user-agent), driven headless via the Chrome DevTools Protocol (the same
protocol Edge and Chrome both speak, since Edge is Chromium-based), logged
into a real workspace on the live dev server. Every page below was actually
loaded, its console/network traffic monitored for errors, and screenshotted.
Interactive tests (drag, resize) used real synthesized mouse events
(`mousedown` → multiple `mousemove` steps → `mouseup`), not just a
code-level assertion that a handler exists.

**Result: 11/11 pages clean.** Zero console errors, zero failed requests
(other than expected 403s — see note below), zero visual anomalies, across
every page tested.

### Main app (`/app`)

| Page | Result |
|---|---|
| Login (fresh session, credentials, redirect) | ✅ Clean. Landed on `#/`, token stored correctly. |
| Dashboard / device list | ✅ Clean. Device cards render. |
| Device detail | ✅ Clean. |
| Device Provisioning / Registration Codes (Settings) | ✅ Clean. Table, "Generate code" button, existing codes (including one claimed by a real paired device) all render correctly. |
| **Layout Editor — drag and resize** | ✅ Clean, and specifically re-verified the drag/resize fixes made earlier this session (see below). |

**Layout Editor detail:** this session's two Layout Editor fixes were
re-tested on Edge with the same overlapping-zones scenario used to diagnose
and verify them on Chrome:
- Dragging a zone's body: the visible element moved on **every one of 6
  sampled mid-drag positions** (not just a jump at the end) — confirms the
  selection no longer tears down and re-creates the DOM node mid-drag on
  Edge either.
- The previously-covered zone's resize handle was reachable immediately on
  selection (the elevated z-index while selected works identically on
  Edge's rendering engine), and dragging it resized the correct zone
  (40%×40% → 43.7%×43.4%), leaving the other zone untouched.

Both fixes hold on Edge with no Edge-specific regressions.

### React Dashboard (`/dashboard`)

| Page | Result |
|---|---|
| Overview | ✅ Clean. Sidebar (Monitor/Explore groups), the SLA compliance gauge, and the condensed Priority actions / Regions / Campaigns summaries all render correctly. |
| Operations | ✅ Clean. |
| Campaigns | ✅ Clean. |
| Regions | ✅ Clean. |
| Screens (device list) | ✅ Clean. |
| Device Detail | ✅ Clean, including the App version / Android version tiles added earlier this session. |

**Note on 403s:** several pages logged `403` responses from the live
device-screenshot polling endpoint (`/api/devices/:id/screenshot`). This is
**expected, not an Edge issue** — every test device happened to be offline
at test time (no player was connected), and that endpoint correctly refuses
to serve a live screenshot for an offline device regardless of which browser
asks. The same 403s occur in Chrome under the same conditions; they were
excluded from the "clean" verdict above because they are server-side device
state, not a rendering or compatibility problem.

### What this does and doesn't prove

Proven: Edge renders both apps' current UI correctly, including the newest
work (Layout Editor fixes, Registration Codes admin UI, Dashboard sidebar
redesign, compliance gauge, condensed summaries), with no Edge-specific
console errors or interaction failures.

Not covered by this pass: older Edge (Legacy EdgeHTML, pre-Chromium — long
end-of-life, not a realistic deployment target), Edge on mobile/tablet, and
any Edge-specific enterprise policy restrictions (e.g. IT-managed
`SmartScreen` or extension-injected content) an operator's environment might
add on top of stock Edge.

## Safari

**Not tested. This is a platform limitation, not an oversight or a claim of
coverage.** Safari does not run on Windows, and every environment used to
develop and test BeamOS during this engagement has been Windows-based, so
there has been no way to launch real Safari at any point.

Concretely un-verified on Safari/WebKit:
- Any WebKit-specific CSS rendering differences (flexbox/grid edge cases,
  custom scrollbar styling, `backdrop-filter` etc.).
- Safari's stricter default behavior around third-party storage/cookies,
  which could affect the dashboard's shared-`localStorage`-token session
  model if the two apps were ever split across origins (they currently are
  not).
- iOS/iPadOS Safari touch-event handling for the Layout Editor's
  mouse-event-based drag and resize (`mousedown`/`mousemove`/`mouseup`) —
  touch browsers typically need these translated from `touchstart` etc.,
  which has not been verified to work or fail either way.
- Video/HLS playback quirks specific to Safari's native `<video>` and
  AVFoundation stack (distinct from the Android player's ExoPlayer, which
  is covered separately).

If Safari support is a requirement, it needs dedicated testing on real macOS
or iOS hardware (or a cloud device lab) — none of which has been available
in this environment. Until then, Safari should be treated as **unverified**,
not assumed compatible on the strength of it also being a modern
standards-based browser.

## How this was produced

Chrome coverage is continuous and implicit — it is the browser every feature
in this session (and the codebase generally) was built and manually verified
against as it was written. The Edge results above are a dedicated,
point-in-time pass (2026-09-04) run specifically to produce this document;
re-run it (or extend it to Firefox/Safari) before citing this file as
current if significant UI changes land afterward.
