const express = require("express");
const router = express.Router();
const { db } = require("../db/database");
const { asyncHandler } = require("../lib/async-handler");
const { getRuntimeSummary, avgRuntimeHoursPerDay, completeUtcDays } = require("../lib/runtime-summary");

// PMI Ref 71 (Part 1): screen runtime on the Overview dashboard.
//
// GET /api/dashboard/runtime?period=1|7|30   (also 24h|7d|30d; anything else -> 30)
//
// Same mount as GET /api/dashboard/overview (config/api-surface.js: JWT-only,
// resolveTenancy), so the same callers can read it and API tokens get 401. Covers
// the caller's active workspace only (req.workspaceId), over whole complete UTC
// days that never include today (lib/runtime-summary.completeUtcDays).
//
// Every figure comes from lib/runtime-summary.js, the source the Ref 66 regional
// reports use, so the dashboard and the reports can't disagree:
//   avg_runtime_hours     hours online per screen per day (time-weighted uptime x 24)
//   avg_uptime_pct        the reports' "Average uptime"
//   zero_runtime_*        the reports' zero-runtime rule, count of eligible, %
//   zero_runtime_screens  up to ZERO_LIST_LIMIT of them, by name
// Values with no denominator are null (the UI shows "n/a").
const ZERO_LIST_LIMIT = 10;

const byName = (a, b) =>
  String(a.name ?? "").localeCompare(String(b.name ?? "")) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const range = completeUtcDays(req.query.period);
    const summary =
      req.workspaceId && req.organizationId
        ? await getRuntimeSummary(db, {
            organizationId: req.organizationId,
            workspaceIds: [req.workspaceId],
            startEpoch: range.startEpoch,
            endEpoch: range.endEpoch,
          })
        : null;
    const o = summary?.overall ?? null;
    const zero = summary ? summary.screens.filter((s) => s.zero_runtime).sort(byName) : [];

    res.json({
      workspace_id: req.workspaceId || null,
      period: {
        days: range.days,
        defaulted: range.defaulted,
        first_day: range.first_day,
        last_day: range.last_day,
        start: new Date(range.startEpoch * 1000).toISOString(),
        end: new Date(range.endEpoch * 1000).toISOString(),
        label: range.label,
      },
      screens: o ? o.screens : 0,
      new_screens: o ? o.new_screens : 0,
      avg_runtime_hours: avgRuntimeHoursPerDay(o),
      avg_uptime_pct: o ? o.avg_uptime_pct : null,
      zero_runtime_count: o ? o.zero_runtime_count : 0,
      zero_runtime_eligible: o ? o.zero_runtime_eligible : 0,
      zero_runtime_pct: o ? o.zero_runtime_pct : null,
      zero_runtime_screens: zero.slice(0, ZERO_LIST_LIMIT).map((s) => ({ id: s.id, name: s.name })),
      zero_runtime_list_limit: ZERO_LIST_LIMIT,
    });
  }),
);

module.exports = router;
