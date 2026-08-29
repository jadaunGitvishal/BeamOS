const express = require("express");
const router = express.Router();
const { db } = require("../db/database");
const { asyncHandler } = require("../lib/async-handler");
const { stripDeviceSecrets } = require("../lib/device-sanitize");
const { accessContext } = require("../lib/tenancy");
const { getWorkspaceDeviceFilter } = require("../lib/workspace-scope");
const { toCsvRow } = require("../lib/csv");
const { renderXlsx, renderPdf } = require("../lib/report-export");

// Merged in from BeamOS-Dashboard's routes/devices.js. Its standalone-app
// GET /:id/screenshot proxy (which forwarded a dash_token cookie to BeamOS's
// real screenshot endpoint over HTTP because the two apps ran on separate
// servers/filesystems) is dropped — the frontend now calls BeamOS's own
// GET /api/devices/:id/screenshot directly, same origin, same auth.

// GET /api/dashboard/devices?at_risk=1&weak_signal=1
// 2.1, ported/trimmed from BeamOS's server/routes/devices.js GET / (same
// latest-telemetry + latest-screenshot join pattern). 2.5 (storage/RAM/
// battery risk) and the 8.1-style weak-signal flag are folded in as filters
// on that same join, per the blueprint's "extend, don't duplicate" note.
router.get(
  "/",
  asyncHandler(async (req, res) => {
    if (!req.workspaceId) return res.json([]);

    let sql = `
    SELECT d.*,
      t.battery_level, t.battery_charging, t.storage_free_mb, t.storage_total_mb,
      t.ram_free_mb, t.ram_total_mb, t.wifi_ssid, t.wifi_rssi, t.uptime_seconds,
      t.cpu_usage, t.latitude, t.longitude, t.reported_at AS last_heartbeat,
      s.filepath as screenshot_path, s.captured_at as screenshot_at
    FROM devices d
    LEFT JOIN (
      SELECT * FROM (
        SELECT dt.*, ROW_NUMBER() OVER (
          PARTITION BY dt.device_id ORDER BY dt.reported_at DESC, dt.id DESC
        ) as rn
        FROM device_telemetry dt
      ) ranked WHERE rn = 1
    ) t ON d.id = t.device_id
    LEFT JOIN (
      SELECT * FROM (
        SELECT sc.*, ROW_NUMBER() OVER (
          PARTITION BY sc.device_id ORDER BY sc.captured_at DESC, sc.id DESC
        ) as rn
        FROM screenshots sc
      ) ranked WHERE rn = 1
    ) s ON d.id = s.device_id
    WHERE d.workspace_id = ?
  `;
    const params = [req.workspaceId];

    if (req.query.at_risk === "1") {
      sql += " AND (t.storage_free_mb < 500 OR (t.ram_total_mb > 0 AND t.ram_free_mb / t.ram_total_mb < 0.1))";
    }
    if (req.query.weak_signal === "1") {
      sql += " AND t.wifi_rssi < -75";
    }

    sql += " ORDER BY d.sort_order ASC, d.created_at ASC";

    const devices = await db.prepare(sql).all(...params);
    res.json(devices.map(stripDeviceSecrets));
  }),
);

// GET /api/dashboard/devices/export?workspace_id=
// Device inventory as a CSV download. Scoped the same way reports.js scopes
// its own device-joined queries (getWorkspaceDeviceFilter), not the inline
// `WHERE d.workspace_id = ?` GET / uses — no new scoping logic. No
// screenshot join / cpu_usage here; neither is a CSV column.
function formatTimestamp(epochSeconds) {
  if (epochSeconds === null || epochSeconds === undefined) return "";
  return new Date(epochSeconds * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}
function formatUptime(seconds) {
  if (seconds === null || seconds === undefined) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h === 0 ? `${m}m` : `${h}h ${m}m`;
}
// PDF-only: blank telemetry reads as "device has never reported" rather
// than "field forgot to render" - CSV/XLSX keep true empty cells since
// those are consumed by spreadsheets/scripts that expect blank = null.
function dashIfBlank(value) {
  return value === null || value === undefined || value === "" ? "—" : value;
}
function formatMergedPair(free, total) {
  if (free === null || free === undefined || total === null || total === undefined) return "—";
  return `${free} / ${total}`;
}

router.get(
  "/export",
  asyncHandler(async (req, res) => {
    const scope = getWorkspaceDeviceFilter(req);
    const sql = `
    SELECT d.id, d.name, d.status,
      t.battery_level, t.battery_charging, t.storage_free_mb, t.storage_total_mb,
      t.ram_free_mb, t.ram_total_mb, t.wifi_ssid, t.wifi_rssi, t.uptime_seconds,
      t.reported_at AS last_heartbeat
    FROM devices d
    LEFT JOIN (
      SELECT * FROM (
        SELECT dt.*, ROW_NUMBER() OVER (
          PARTITION BY dt.device_id ORDER BY dt.reported_at DESC, dt.id DESC
        ) as rn
        FROM device_telemetry dt
      ) ranked WHERE rn = 1
    ) t ON d.id = t.device_id
    WHERE 1=1${scope.sql}
    ORDER BY d.sort_order ASC, d.created_at ASC
  `;
    const devices = await db.prepare(sql).all(...scope.params);

    const format = ["csv", "xlsx", "pdf"].includes(req.query.format)
      ? req.query.format
      : "csv";

    const headers = [
      "Name",
      "Status",
      "Last Heartbeat (UTC)",
      "Battery (%)",
      "Charging",
      "Storage Free (MB)",
      "Storage Total (MB)",
      "RAM Free (MB)",
      "RAM Total (MB)",
      "Wi-Fi SSID",
      "Wi-Fi Signal (dBm)",
      "Uptime",
      "Device ID",
    ];
    const dataRows = devices.map((d) => [
      d.name,
      d.status,
      formatTimestamp(d.last_heartbeat),
      d.battery_level,
      d.battery_level === null || d.battery_level === undefined ? "" : d.battery_charging ? "Yes" : "No",
      d.storage_free_mb,
      d.storage_total_mb,
      d.ram_free_mb,
      d.ram_total_mb,
      d.wifi_ssid,
      d.wifi_rssi,
      formatUptime(d.uptime_seconds),
      d.id,
    ]);

    const date = new Date().toISOString().slice(0, 10);

    if (format === "xlsx") {
      const buffer = await renderXlsx("Devices", headers, dataRows);
      res.set(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      res.set("Content-Disposition", `attachment; filename="devices-${date}.xlsx"`);
      res.send(buffer);
      return;
    }

    if (format === "pdf") {
      // PDF-only column layout: 13 columns of even width made most of them
      // unreadable (long names/headers all ellipsis-truncated to the point
      // of being ambiguous between devices). Merge the free/total pairs
      // into one column each and shorten verbose headers so Name - the
      // actual identifier - can get real width instead of an even 1/13th.
      const pdfHeaders = [
        "Name",
        "Status",
        "Last Seen",
        "Battery (%)",
        "Charging",
        "Storage (MB)",
        "RAM (MB)",
        "Wi-Fi SSID",
        "Signal (dBm)",
        "Uptime",
        "Device ID",
      ];
      const pdfRows = devices.map((d) => [
        d.name,
        d.status,
        dashIfBlank(formatTimestamp(d.last_heartbeat)),
        dashIfBlank(d.battery_level),
        d.battery_level === null || d.battery_level === undefined ? "—" : d.battery_charging ? "Yes" : "No",
        formatMergedPair(d.storage_free_mb, d.storage_total_mb),
        formatMergedPair(d.ram_free_mb, d.ram_total_mb),
        dashIfBlank(d.wifi_ssid),
        dashIfBlank(d.wifi_rssi),
        dashIfBlank(formatUptime(d.uptime_seconds)),
        d.id,
      ]);
      // Column widths auto-fit to the actual header/data lengths (see
      // renderPdf) - no more hand-tuned weights to keep in sync as columns
      // or typical content change.
      const buffer = await renderPdf("Devices", pdfHeaders, pdfRows);
      res.set("Content-Type", "application/pdf");
      res.set("Content-Disposition", `attachment; filename="devices-${date}.pdf"`);
      res.send(buffer);
      return;
    }

    const header = toCsvRow(headers);
    const csvRows = dataRows.map((row) => toCsvRow(row));
    res.set("Content-Type", "text/csv; charset=utf-8");
    res.set("Content-Disposition", `attachment; filename="devices-${date}.csv"`);
    res.send("﻿" + [header, ...csvRows].join("\r\n"));
  }),
);

// GET /api/dashboard/devices/:id/status-history?start=&end=
// 2.2 — online/offline timeline strip for one device. Rides the existing
// idx_device_status_log_device_ts(device_id, timestamp) index.
router.get(
  "/:id/status-history",
  asyncHandler(async (req, res) => {
    const device = await db
      .prepare("SELECT id, workspace_id FROM devices WHERE id = ?")
      .get(req.params.id);
    if (!device) return res.status(404).json({ error: "Device not found" });
    if (!device.workspace_id) return res.status(403).json({ error: "Device not assigned to a workspace" });

    const ws = await db.prepare("SELECT * FROM workspaces WHERE id = ?").get(device.workspace_id);
    const ctx = ws && (await accessContext(req.user.id, req.user.role, ws));
    if (!ctx) return res.status(403).json({ error: "Access denied" });

    const { start, end } = req.query;
    const startEpoch = start
      ? Math.floor(new Date(start).getTime() / 1000)
      : Math.floor(Date.now() / 1000) - 86400;
    const endEpoch = end ? Math.floor(new Date(end).getTime() / 1000) : Math.floor(Date.now() / 1000);

    const rows = await db
      .prepare(
        `
      SELECT status, timestamp
      FROM device_status_log
      WHERE device_id = ? AND timestamp BETWEEN ? AND ?
      ORDER BY timestamp ASC
    `,
      )
      .all(req.params.id, startEpoch, endEpoch);
    res.json(rows);
  }),
);

module.exports = router;
