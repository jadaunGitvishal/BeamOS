'use strict';

// Wraps an async Express route handler so a rejected promise is forwarded to
// next(err) instead of becoming an unhandled rejection / hung request.
function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = { asyncHandler };
