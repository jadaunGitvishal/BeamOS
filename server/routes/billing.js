'use strict';

// #146 BILLING — admin-gated Usage Report (ByteTinker–Bold agreement §4.1 system-of-record
// / §4.2 verification). DELIBERATELY a standalone route, separate from routes/status.js:
// /api/status is the hot, constantly-polled path; this is a heavier admin-only aggregate
// and must not touch it. Reads the daily rollup ONLY (cheap — no raw-log scans).

const express = require('express');
const router = express.Router();
const { requireBillingRead } = require('../middleware/apiToken');
const { asyncHandler } = require('../lib/async-handler');
const billing = require('../lib/billing');

// GET /api/billing/usage?month=YYYY-MM  (default: current month)
// #146 Option C — DUAL PATH: authorized by a 'billing:read' scoped API token OR a
// platform-admin session (requireBillingRead, explicit OR). Admins keep read access but a
// least-privilege token is the intended consumer (tooling / invoice-time pulls / §4.2).
//
// buildUsageReport() is async (it queries device_usage_daily via the mysql2-backed
// db module) - this handler was never updated to await it when the route was
// written, so res.json() was serializing the un-awaited Promise itself (no
// enumerable own properties -> a silent, valid-looking `{}`) instead of the real
// report, for every caller, since the MySQL migration. Fixed: await it, and wrap
// in asyncHandler per every other async route in this codebase (lib/async-handler.js)
// so a rejected promise reaches Express's error handler instead of crashing the
// process outright.
router.get('/usage', requireBillingRead, asyncHandler(async (req, res) => {
  try {
    res.json(await billing.buildUsageReport(req.query.month));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

module.exports = router;
