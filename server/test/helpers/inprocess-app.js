'use strict';

// Shared in-process app builder for tests that need real, full-stack HTTP
// behavior (real route files, real middleware, real MySQL) WITHOUT paying for
// a spawned `node server.js` subprocess or a socket.io handshake.
//
// Why this exists: a cluster of test files (billing-authz, billing-endpoint,
// billing-token-mint, block-authz, device-zone-contract, thumbnail-proxy) used
// to spawn a real server.js subprocess purely to test plain HTTP/RBAC/CRUD
// behavior with no socket.io or process-level timing involved - and, as a
// leftover from the pre-MySQL-migration architecture, seeded/inspected
// fixtures via a flat-file SQLite path (`DATA_DIR/db/remote_display.db`) that
// server.js hasn't created since the MySQL migration (~2026-07-21). Since
// there's nothing about their actual assertions that needs a separate OS
// process, they're converted to this in-process pattern instead - the same
// architectural shape already proven by tenancy-cross-tenant.test.js /
// admin-users.test.js / branding.test.js (mount the real Express app in the
// SAME process, hit it via fetch against `app.listen(0)`), except those three
// inject an in-memory SQLite mock via require-cache, while this helper
// deliberately uses the REAL `db` module (real MySQL) — because the whole
// point of this cluster's original design was to validate against a genuinely
// running app, and several of the routes exercised here (routes/admin.js,
// routes/billing.js) execute MySQL-specific SQL (e.g. UNIX_TIMESTAMP()) that
// a plain-SQLite mock cannot run at all (see admin-users.test.js's own,
// separately-tracked, pre-existing failure for exactly this reason). Callers
// MUST seed only disposable, randomly-suffixed fixtures and delete everything
// they create in their own after() hook (see helpers/disposable.js) - nothing
// here isolates the database the way an in-memory mock or a spawned
// subprocess's own DATA_DIR used to.
//
// Router selection mirrors server.js's own data-driven mount loops
// (config/api-surface.js) exactly, so this can't silently drift from what
// server.js actually mounts in production - the same anti-drift property
// test/api.test.js's partition-firewall test already relies on.

const path = require('path');
const express = require('express');
const { requireAuth } = require('../../middleware/auth');
const { resolveTenancy } = require('../../lib/tenancy');
const { bearerAuth, tokenScopeGate, agencyGate } = require('../../middleware/apiToken');
const { PUBLIC_ROUTERS, JWT_ONLY_ROUTERS, AGENCY_ROUTERS } = require('../../config/api-surface');
const { activityLogger } = require('../../services/activity');

// Builds and starts the app on an ephemeral port. Returns
// { app, server, base, db, stop }.
// `only`: optional array of path prefixes (e.g. ['/api/devices']) to restrict
// PUBLIC_ROUTERS/JWT_ONLY_ROUTERS/AGENCY_ROUTERS to, for tests that only need a
// couple of routers and would rather not pay for require()-ing every route
// file. Omit to mount everything server.js mounts (the safest default - matches
// production exactly, and mounting an unused router costs nothing at runtime).
//
// IMPORTANT: call the returned `stop()` in your after() hook, not just
// `server.close()`. `db` here is the REAL mysql2 pool-backed module
// (db/database.js) - unlike a spawned server.js subprocess (where the OS
// reclaims everything on SIGKILL) or the in-memory-SQLite-mock pattern (which
// has nothing to close), an in-process test sharing this process with the
// pool must end it explicitly or the pool's open sockets keep the event loop
// alive and `node --test` hangs after the test itself has already finished -
// this is not hypothetical, it reproduced reliably during development.
// `stop()` does both (`server.close()` + `await db.close()`) so a caller can't
// forget the second half.
async function startInProcessApp({ only } = {}) {
  const app = express();
  app.use(express.json());

  const want = (p) => !only || only.includes(p);
  // config/api-surface.js's `mod` strings (e.g. './routes/devices') are written
  // relative to server.js's own location (server/), not this helper's
  // (server/test/helpers/) - resolve explicitly rather than requiring them as-is.
  const requireServerMod = (mod) => require(path.join(__dirname, '..', '..', mod));

  // Auth (register/login) - unauthenticated, needed by every caller of this helper.
  app.use('/api/auth', require('../../routes/auth'));

  // Public status page - some tests assert on what it does/doesn't expose.
  if (want('/api/status')) app.use('/api/status', require('../../routes/status'));

  // #146: billing lives on its own route, dual front door (bearerAuth covers both
  // a JWT session and a billing:read token; the route's own requireBillingRead
  // does the actual authz) - no resolveTenancy, billing is platform-global.
  if (want('/api/billing')) app.use('/api/billing', bearerAuth, require('../../routes/billing'));

  // Public content file/thumbnail serving (routes/public-content.js) - MUST be
  // mounted here, before the authenticated /api/content router in the
  // PUBLIC_ROUTERS loop below, exactly like server.js: registration order is
  // what makes these public, unauthenticated routes win over routes/content.js's
  // own (dead-code, shadowed) /:id/file and /:id/thumbnail duplicates. Opt-in
  // via `only` under the sentinel '/api/content/public' (distinct from
  // '/api/content', the authenticated router's own PUBLIC_ROUTERS path) since a
  // caller may want either, both, or neither.
  if (want('/api/content/public')) app.use(require('../../routes/public-content'));

  // Same auto-logger server.js mounts before the workspace routes.
  app.use(activityLogger);

  for (const r of PUBLIC_ROUTERS) {
    if (!want(r.path)) continue;
    const front = r.renderBypass
      ? (req, res, next) => (req._skipAuth ? next() : bearerAuth(req, res, next))
      : bearerAuth;
    app.use(r.path, front, resolveTenancy, tokenScopeGate, requireServerMod(r.mod));
  }
  for (const r of JWT_ONLY_ROUTERS) {
    if (!want(r.path)) continue;
    if (r.tenancy) app.use(r.path, requireAuth, resolveTenancy, requireServerMod(r.mod));
    else app.use(r.path, requireAuth, requireServerMod(r.mod));
  }
  for (const r of AGENCY_ROUTERS) {
    if (!want(r.path)) continue;
    app.use(r.path, bearerAuth, resolveTenancy, agencyGate, requireServerMod(r.mod));
  }

  // Surface handler errors as JSON (same pattern as tenancy-cross-tenant.test.js)
  // instead of Express's default HTML page, so a thrown error fails assertions
  // legibly rather than as an opaque non-JSON body.
  app.use((err, req, res, _next) => {
    res.status(500).json({ error: err.message });
  });

  const server = app.listen(0);
  await new Promise((resolve) => (server.listening ? resolve() : server.once('listening', resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const db = require('../../db/database').db;
  const stop = async () => {
    await new Promise((resolve) => server.close(resolve));
    await db.close();
  };
  return { app, server, base, db, stop };
}

module.exports = { startInProcessApp };
