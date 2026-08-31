const express = require("express");
const router = express.Router();
const { db } = require("../db/database");
const { asyncHandler } = require("../lib/async-handler");
const { getWorkspaceDeviceSubquery } = require("../lib/workspace-scope");
const { toCsvRow } = require("../lib/csv");
const { renderXlsx, renderPdf } = require("../lib/report-export");

// Merged in from BeamOS-Dashboard's routes/content.js.

// The by_content aggregation, workspace-scoped the same way reports.js scopes
// play_logs (getWorkspaceDeviceSubquery, no admin bypass). Shared verbatim by
// GET / and GET /export so the download can never drift from the on-screen
// table. start/end are the same params GET / has always taken.
async function queryContentAggregation(req) {
  const { start, end } = req.query;
  const startEpoch = start
    ? Math.floor(new Date(start).getTime() / 1000)
    : Math.floor(Date.now() / 1000) - 30 * 86400;
  const endEpoch = end
    ? Math.floor(new Date(end + "T23:59:59").getTime() / 1000)
    : Math.floor(Date.now() / 1000);

  const wsScope = getWorkspaceDeviceSubquery(req);
  const rows = await db
    .prepare(
      `
      SELECT content_id, content_name, COUNT(*) as plays,
             COALESCE(SUM(duration_sec), 0) as total_seconds,
             SUM(completed) as completed_plays
      FROM play_logs
      WHERE started_at >= ? AND started_at <= ?${wsScope.sql}
      GROUP BY content_id, content_name
      ORDER BY plays DESC LIMIT 50
    `,
    )
    .all(startEpoch, endEpoch, ...wsScope.params);

  const content = rows.map((r) => ({
    ...r,
    completion_pct:
      r.plays > 0
        ? Math.round((r.completed_plays / r.plays) * 1000) / 10
        : null,
  }));

  return { startEpoch, endEpoch, content };
}

// GET /api/dashboard/content?start=&end=
// by_content query ported verbatim from BeamOS's server/routes/reports.js
// /summary endpoint, workspace-scoped the same way reports.js scopes
// play_logs (getWorkspaceDeviceSubquery, no admin bypass).
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { startEpoch, endEpoch, content } = await queryContentAggregation(req);
    res.json({
      period: {
        start: new Date(startEpoch * 1000).toISOString(),
        end: new Date(endEpoch * 1000).toISOString(),
      },
      content,
    });
  }),
);

// GET /api/dashboard/content/export?format=csv|xlsx|pdf&start=&end=
// Same scoping + aggregation as GET / (queryContentAggregation), just format
// branching. Mirrors the CSV/XLSX/PDF export on dashboard-devices.js.
//
// total_seconds -> "Total Hours" (1-decimal). Completion % stays a bare number
// in CSV/XLSX (blank when a row has no plays) so spreadsheets/scripts can do
// math on it; the PDF renders "—" / "N%" since it's read by a human.
function hoursFromSeconds(seconds) {
  return Math.round((Number(seconds) || 0) / 360) / 10;
}
function dashIfBlank(value) {
  return value === null || value === undefined || value === "" ? "—" : value;
}

router.get(
  "/export",
  asyncHandler(async (req, res) => {
    const { content } = await queryContentAggregation(req);

    const format = ["csv", "xlsx", "pdf"].includes(req.query.format)
      ? req.query.format
      : "csv";

    const headers = [
      "Content Name",
      "Plays",
      "Total Hours",
      "Completion %",
      "Content ID",
    ];
    const dataRows = content.map((c) => [
      c.content_name || "",
      c.plays,
      hoursFromSeconds(c.total_seconds),
      c.completion_pct === null ? "" : c.completion_pct,
      c.content_id || "",
    ]);

    const date = new Date().toISOString().slice(0, 10);

    if (format === "xlsx") {
      const buffer = await renderXlsx("Content", headers, dataRows);
      res.set(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      res.set("Content-Disposition", `attachment; filename="content-${date}.xlsx"`);
      res.send(buffer);
      return;
    }

    if (format === "pdf") {
      const pdfRows = content.map((c) => [
        dashIfBlank(c.content_name),
        c.plays,
        hoursFromSeconds(c.total_seconds),
        c.completion_pct === null ? "—" : `${c.completion_pct}%`,
        dashIfBlank(c.content_id),
      ]);
      const buffer = await renderPdf("Content", headers, pdfRows);
      res.set("Content-Type", "application/pdf");
      res.set("Content-Disposition", `attachment; filename="content-${date}.pdf"`);
      res.send(buffer);
      return;
    }

    const header = toCsvRow(headers);
    const csvRows = dataRows.map((row) => toCsvRow(row));
    res.set("Content-Type", "text/csv; charset=utf-8");
    res.set("Content-Disposition", `attachment; filename="content-${date}.csv"`);
    res.send("﻿" + [header, ...csvRows].join("\r\n"));
  }),
);

module.exports = router;
