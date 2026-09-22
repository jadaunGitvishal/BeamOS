'use strict';

// SINGLE SOURCE OF TRUTH for the API router partition.
//
// server.js mounts from these two lists; test/api.test.js (the partition firewall
// test) asserts against the SAME lists. Because both read this one file, the mount
// list and the test cannot drift: add a router to PUBLIC_ROUTERS and it gets the
// token front door AND the firewall test covers it; the day a JWT-only router stops
// returning 401 to a `Bearer st_` token (e.g. someone gives it the token door), CI
// fails. This is the firewall-rule-as-code.
//
//   PUBLIC_ROUTERS   - token-reachable. Mounted with the bearerAuth front door +
//                      resolveTenancy + tokenScopeGate. A scoped API token, a JWT
//                      session, AND a registered Entra ID Service Principal's
//                      access token (Ref 9 - middleware/entraToken.js) all reach
//                      these; the latter two both resolve down to the exact same
//                      req.viaToken/req.tokenScope shape a token produces, so
//                      tokenScopeGate enforces identically for all three.
//   JWT_ONLY_ROUTERS - requireAuth only (no token front door). A `Bearer st_`
//                      token or an Entra-issued JWT both fail requireAuth's
//                      jwt.verify (wrong format / wrong signing algorithm) -> 401,
//                      so these are unreachable by either (secure by exclusion,
//                      not by extra code). Privileged surfaces live here.
//
// Per-entry flags:
//   renderBypass: also exposes a public GET /:id/render (device render) that skips auth.
//   tenancy:      JWT-only router also runs resolveTenancy (acts on the caller's active
//                 workspace). Routers without it target a workspace by URL/body param
//                 and are gated per-handler (e.g. canAdminWorkspace).
//
// Granularity note (Ref 73): an entry moves its WHOLE router's module to the
// token door - there's no per-route split at this layer. That's fine for a
// router that's entirely GET (dashboard-reports.js) or whose writes are
// already gated by both requireWorkspaceAdmin and tokenScopeGate's write/full
// requirement (sim-inventory.js). It is NOT fine for a router mixing a narrow
// read surface with broad privileged operations (routes/workspaces.js: org/
// workspace admin, members, campaigns, regions, AND tickets) - moving that
// whole file would hand a write-scope token far more than intended. For that
// case the fix is a NEW, purpose-built, GET-only router (tickets-readonly.js)
// that reuses the original's query/shape via a shared lib, not a wider door.

const PUBLIC_ROUTERS = [
  { path: '/api/devices',     mod: './routes/devices' },
  { path: '/api/content',     mod: './routes/content' },
  { path: '/api/folders',     mod: './routes/folders' },
  { path: '/api/assignments', mod: './routes/assignments' },
  { path: '/api/layouts',     mod: './routes/layouts' },
  { path: '/api/widgets',     mod: './routes/widgets', renderBypass: true },
  { path: '/api/schedules',   mod: './routes/schedules' },
  { path: '/api/walls',       mod: './routes/video-walls' },
  { path: '/api/reports',     mod: './routes/reports' },
  { path: '/api/groups',      mod: './routes/device-groups' },
  { path: '/api/playlists',   mod: './routes/playlists' },
  { path: '/api/activity',    mod: './routes/activity' },
  { path: '/api/kiosk',       mod: './routes/kiosk', renderBypass: true },
  { path: '/api/pip',         mod: './routes/pip' },
  // Ref 73 (Power BI / Tableau / external-reader access): three read-only
  // additions, each deliberately narrow rather than a whole privileged
  // router moved wholesale:
  //   - /api/dashboard/reports (routes/dashboard-reports.js) is ENTIRELY
  //     GET - sla-overview/sla-trend/uptime/availability/reconciliation/
  //     pending-installations, no writes exist in the file - so moving the
  //     whole router is exactly as narrow as moving one route would be.
  //   - /api/sim-inventory (routes/sim-inventory.js) DOES have POST/PATCH,
  //     but they're already gated by requireWorkspaceAdmin AND now also by
  //     tokenScopeGate (write/full scope) - a bare 'read' token cannot reach
  //     them, matching this Ref's "never opened to a bare read token" bar.
  //   - /api/tickets (routes/tickets-readonly.js) is a NEW, purpose-built
  //     GET-only router - NOT the existing /api/workspaces ticket routes,
  //     which stay JWT-only. /api/workspaces itself is far too broad a
  //     surface (org/workspace admin, members, campaigns, regions...) to
  //     ever go on the token door - see MUST_BE_PRIVATE in test/api.test.js.
  //     tickets-readonly.js reuses the exact same query/shape as the JWT
  //     routes (lib/ticket-query.js) so the two can't drift.
  { path: '/api/dashboard/reports', mod: './routes/dashboard-reports' },
  { path: '/api/sim-inventory',     mod: './routes/sim-inventory' },
  { path: '/api/tickets',           mod: './routes/tickets-readonly' },
];

const JWT_ONLY_ROUTERS = [
  { path: '/api/ai',          mod: './routes/ai',           tenancy: true },
  { path: '/api/provision',   mod: './routes/provisioning', tenancy: true },
  // Ref 30 Stage 1: advance device registration codes. Targets a workspace by
  // body/query param and gates per-handler (canAdminWorkspace), so no tenancy.
  { path: '/api/provisioning', mod: './routes/registration-codes' },
  { path: '/api/teams',       mod: './routes/teams',        tenancy: true },
  { path: '/api/white-label', mod: './routes/white-label',  tenancy: true },
  { path: '/api/workspaces',  mod: './routes/workspaces' },
  { path: '/api/organizations', mod: './routes/organizations' },
  { path: '/api/admin',       mod: './routes/admin' },
  { path: '/api/tokens',      mod: './routes/tokens',       tenancy: true },
  // Merged in from the standalone BeamOS-Dashboard app (read-only reporting:
  // Overview / Devices / Content delivery / Issues). Mounted under its own
  // /api/dashboard/* prefix rather than reusing /api/devices or /api/reports
  // - those paths are already live above with different response shapes, so
  // sharing them would shadow the existing routers instead of merging with
  // them. Any workspace member (workspace_viewer and up) can read these -
  // resolveTenancy alone gates that, same as every other tenancy:true router
  // here; there's no additional role check because none of these routes
  // expose anything a viewer couldn't already piece together from the
  // devices/content/activity surfaces they already have read access to.
  // (dashboard/reports moved to PUBLIC_ROUTERS - Ref 73 - since it's entirely
  // GET; the other three stay JWT-only, not asked for by that Ref.)
  { path: '/api/dashboard/overview', mod: './routes/dashboard-overview', tenancy: true },
  { path: '/api/dashboard/content',  mod: './routes/dashboard-content',  tenancy: true },
  { path: '/api/dashboard/issues',   mod: './routes/dashboard-issues',   tenancy: true },
  { path: '/api/dashboard/devices',  mod: './routes/dashboard-devices',  tenancy: true },
];

// #73: AGENCY_ROUTERS - capability-restricted ('agency' scope) surface. Mounted with
// bearerAuth + resolveTenancy + agencyGate (NOT tokenScopeGate). An 'agency' token is
// OFF the read/write/full ladder, so tokenScopeGate rejects it on every PUBLIC_ROUTER -
// it can reach ONLY this router, and only its allowlisted playlists in its bound
// workspace (agencyGate enforces both). read/write/full tokens and JWTs are rejected here.
const AGENCY_ROUTERS = [
  { path: '/api/agency', mod: './routes/agency' },
];

module.exports = { PUBLIC_ROUTERS, JWT_ONLY_ROUTERS, AGENCY_ROUTERS };
