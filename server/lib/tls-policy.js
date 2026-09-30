'use strict';

// Ref 2 Stage 1: transport-security policy, shared by server.js and
// test/tls-policy.test.js so the test exercises the exact options production uses.
//
// 1. TLS floor. Node 20's tls.DEFAULT_MIN_VERSION is already TLSv1.2, but that
//    default is process-wide and lowerable (`node --tls-min-v1.0`, NODE_OPTIONS,
//    or any module assigning tls.DEFAULT_MIN_VERSION) and has changed across Node
//    majors. An explicit minVersion on the server's own options can't be lowered
//    that way, so the guarantee doesn't depend on how the process was launched.
//
// 2. HSTS only on requests that actually arrived over TLS (req.secure). That is
//    true for every request on the https server (hasSsl), AND for requests whose
//    TLS was terminated by a TRUSTED proxy that set X-Forwarded-Proto: https
//    (Cloudflare / LAN reverse proxy - server.js's `trust proxy` list), which is
//    how public production is served while hasSsl is false. Gating on hasSsl
//    alone would have stripped HSTS from that deployment. On plain HTTP (a
//    self-hosted LAN) the header is omitted: browsers ignore HSTS over HTTP per
//    RFC 6797 §8.1 anyway, so this changes nothing for them - it just stops
//    advertising a policy the connection can't back.
//
// Plain HTTP stays supported on purpose (self-hosted HTTP-only LANs). This file
// does NOT force TLS on; it guarantees what TLS means when it is on.

const helmet = require('helmet');

const MIN_TLS_VERSION = 'TLSv1.2';
const HSTS_OPTIONS = { maxAge: 31536000, includeSubDomains: true }; // unchanged from the prior helmet() config

function buildSslOptions({ cert, key }) {
  return { cert, key, minVersion: MIN_TLS_VERSION };
}

function hstsWhenSecure(options = HSTS_OPTIONS) {
  const hsts = helmet.strictTransportSecurity(options);
  return function hstsWhenSecureMiddleware(req, res, next) {
    if (!req.secure) return next();
    return hsts(req, res, next);
  };
}

module.exports = { buildSslOptions, hstsWhenSecure, MIN_TLS_VERSION, HSTS_OPTIONS };
