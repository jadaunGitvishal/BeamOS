const path = require('path');
const fs = require('fs');
const { db } = require('../db/database');
const config = require('../config');
const heartbeat = require('./heartbeat');

// Ref 36: periodic live screen preview.
//
// On-demand previews (dashboard:request-screenshot) only stream the image to the
// dashboard - no disk write, no DB row. This sweep adds an automatic cadence: every
// screenshotPreviewIntervalMs it asks every currently-connected device for a
// screenshot and PERSISTS the reply (file + screenshots row), so the dashboard has a
// recent-ish thumbnail even for devices nobody is actively watching.
//
// Follows scheduler.js's setInterval pattern (async tick, .catch so a rejection can't
// become a fatal unhandled rejection).

let io = null;

// device_id -> requestedAtMs. An entry is added when the sweep asks a device for a
// screenshot and consumed (cleared) when that device's next device:screenshot arrives -
// that's the signal deviceSocket.js uses to decide "persist this one". On-demand
// requests never populate this map, so their screenshots stay relay-only (unchanged).
const pendingCaptures = new Map();

function startScreenshotScheduler(socketIo) {
  io = socketIo;
  const interval = config.screenshotPreviewIntervalMs;
  if (!interval || interval < 1000) {
    console.log('Screenshot preview scheduler disabled (SCREENSHOT_PREVIEW_INTERVAL_MS not set)');
    return;
  }
  setInterval(() => {
    sweep().catch((e) => console.error('[screenshot-scheduler] tick failed:', e.message));
  }, interval);
  console.log(`Screenshot preview scheduler started (every ${Math.round(interval / 1000)}s)`);
}

async function sweep() {
  const deviceNs = io && io.of('/device');
  if (!deviceNs) return;

  // Drop stale pending entries so a late reply - or an on-demand shot that lands after
  // we gave up waiting - is never mistaken for this cycle's capture and persisted.
  const ttl = Math.max(config.screenshotPreviewIntervalMs, 60000);
  const cutoff = Date.now() - ttl;
  for (const [id, ts] of pendingCaptures) {
    if (ts < cutoff) pendingCaptures.delete(id);
  }

  // heartbeat's in-memory presence map is the authoritative "connected right now" set
  // (heartbeat.js itself trusts it over devices.status). Only poll devices we actually
  // hold a live socket for.
  for (const [deviceId, conn] of heartbeat.getAllConnections()) {
    if (!deviceNs.sockets.has(conn.socketId)) continue;
    pendingCaptures.set(deviceId, Date.now());
    deviceNs.to(deviceId).emit('device:screenshot-request', {});
  }
}

// Called by deviceSocket.js for every incoming device:screenshot. When this device has
// a pending periodic request, writes the file + a screenshots row and returns true;
// otherwise does nothing and returns false, so on-demand previews stay relay-only.
async function persistScreenshotIfPending(deviceId, imageB64) {
  if (!pendingCaptures.has(deviceId)) return false;
  pendingCaptures.delete(deviceId);
  try {
    const filename = `${deviceId}_${Date.now()}.jpg`;
    fs.writeFileSync(
      path.join(config.screenshotsDir, filename),
      Buffer.from(imageB64, 'base64'),
    );
    await db.prepare('INSERT INTO screenshots (device_id, filepath) VALUES (?, ?)').run(deviceId, filename);
    await pruneOldPreviews(deviceId);
    return true;
  } catch (e) {
    console.error(`[screenshot-scheduler] failed to persist screenshot for ${deviceId}: ${e.message}`);
    return false;
  }
}

// Keep only the newest screenshotPreviewRetention rows per device (and delete the
// backing files for the ones we drop). Same nested-subquery shape as
// database.js's pruneScreenshots so MySQL accepts the LIMIT-in-subquery.
async function pruneOldPreviews(deviceId) {
  const keep = config.screenshotPreviewRetention;
  if (!keep || keep < 1) return;
  const stale = await db
    .prepare(
      `SELECT id, filepath FROM screenshots
       WHERE device_id = ? AND id NOT IN (
         SELECT id FROM (SELECT id FROM screenshots WHERE device_id = ? ORDER BY captured_at DESC LIMIT ?) x
       )`,
    )
    .all(deviceId, deviceId, keep);
  if (!stale.length) return;
  for (const row of stale) {
    const p = path.join(config.screenshotsDir, path.basename(row.filepath));
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (_) {
      /* file already gone */
    }
  }
  await db
    .prepare(
      `DELETE FROM screenshots
       WHERE device_id = ? AND id NOT IN (
         SELECT id FROM (SELECT id FROM screenshots WHERE device_id = ? ORDER BY captured_at DESC LIMIT ?) x
       )`,
    )
    .run(deviceId, deviceId, keep);
}

module.exports = {
  startScreenshotScheduler,
  persistScreenshotIfPending,
  // exposed for tests
  _pendingCaptures: pendingCaptures,
  _sweep: sweep,
  _setIo: (x) => { io = x; },
};
