'use strict';

// Express 4 (this app's version) does not catch rejected promises from async
// route handlers or middleware - an unguarded `await` that throws becomes an
// unhandled rejection, which server.js's global crash handler treats as FATAL
// (process.exit(1), on every request, not just the one that failed). This
// wrapper is required on every async Express handler/middleware introduced by
// the MySQL migration (mysql2 is promise-based, unlike the old synchronous
// better-sqlite3 calls these replaced) so a thrown/rejected error is routed to
// next(err) - Express's normal error-handling path - instead of escaping.
function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = { asyncHandler };
