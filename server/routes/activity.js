const express = require("express");
const router = express.Router();
const { getActivity, pruneActivityLog } = require("../services/activity");
const { PLATFORM_ROLES, ELEVATED_ROLES } = require("../middleware/auth");
const { asyncHandler } = require("../lib/async-handler");
const { toCsvRow } = require("../lib/csv");
const { renderXlsx, renderPdf } = require("../lib/report-export");

function formatTimestamp(epochSeconds) {
  if (epochSeconds === null || epochSeconds === undefined) return "";
  return new Date(epochSeconds * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

// Get activity log
router.get("/", async (req, res) => {
  const { device_id, limit, offset } = req.query;
  const isAdmin = PLATFORM_ROLES.includes(req.user.role);

  const activity = await getActivity({
    userId: isAdmin ? null : req.user.id,
    deviceId: device_id || null,
    limit: Math.min(parseInt(limit) || 50, 200),
    offset: parseInt(offset) || 0,
  });

  res.json(activity);
});

// GET /export?format=csv|xlsx|pdf - same scoping as GET / (isAdmin ? all
// users : caller-only, optional device_id filter), rendered as a downloadable
// file via the shared report-export lib. Capped at 10000 rows - unlike the
// members exports this scopes over an unbounded, ever-growing log rather
// than a small fixed roster, so an explicit ceiling keeps a busy instance's
// export from trying to buffer an unbounded xlsx/pdf in memory.
router.get(
  "/export",
  asyncHandler(async (req, res) => {
    const { device_id } = req.query;
    const isAdmin = PLATFORM_ROLES.includes(req.user.role);

    const activity = await getActivity({
      userId: isAdmin ? null : req.user.id,
      deviceId: device_id || null,
      limit: 10000,
      offset: 0,
    });

    const format = ["csv", "xlsx", "pdf"].includes(req.query.format)
      ? req.query.format
      : "csv";

    const headers = ["User Name", "User Email", "Action", "Device ID", "Details", "IP Address", "Workspace ID", "Created At (UTC)"];
    const dataRows = activity.map((a) => [
      a.user_name || "",
      a.user_email || "",
      a.action,
      a.device_id || "",
      a.details || "",
      a.ip_address || "",
      a.workspace_id || "",
      formatTimestamp(a.created_at),
    ]);

    const date = new Date().toISOString().slice(0, 10);
    const filenameBase = `activity-log-${date}`;

    if (format === "xlsx") {
      const buffer = await renderXlsx("Activity Log", headers, dataRows);
      res.set(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      res.set("Content-Disposition", `attachment; filename="${filenameBase}.xlsx"`);
      res.send(buffer);
      return;
    }

    if (format === "pdf") {
      const buffer = await renderPdf("Activity Log", headers, dataRows);
      res.set("Content-Type", "application/pdf");
      res.set("Content-Disposition", `attachment; filename="${filenameBase}.pdf"`);
      res.send(buffer);
      return;
    }

    const header = toCsvRow(headers);
    const csvRows = dataRows.map((row) => toCsvRow(row));
    res.set("Content-Type", "text/csv; charset=utf-8");
    res.set("Content-Disposition", `attachment; filename="${filenameBase}.csv"`);
    res.send("﻿" + [header, ...csvRows].join("\r\n"));
  }),
);

// Prune old logs (admin only)
router.delete("/prune", (req, res) => {
  if (!ELEVATED_ROLES.includes(req.user.role))
    return res.status(403).json({ error: "Admin only" });
  pruneActivityLog();
  res.json({ success: true });
});

module.exports = router;
