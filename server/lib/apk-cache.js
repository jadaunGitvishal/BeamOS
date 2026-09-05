"use strict";
// #146 hardening (Item C) — cache the OTA APK resolution so no /api/update/check or
// /download/apk does a per-request synchronous filesystem call. The path/size/mtime are
// resolved once at boot and refreshed on an interval (like the frontend-hash refresh),
// so a poll/download flood can't turn into an existsSync/statSync flood on the loop.

const fs = require("fs");
const path = require("path");
const config = require("../config");
const { computeSignatureChecksum } = require("./apk-signature-checksum");

// A copy under DATA_DIR wins (container operators mount /data/ScreenTinker.apk),
// else the legacy in-repo root path — same order as the old resolveApkPath().
function candidates() {
  return [
    path.join(config.dataDir, "BeamOS.apk"),
    path.join(__dirname, "..", "..", "BeamOS.apk"),
  ];
}

let cache = { path: null, exists: false, size: 0, mtime: 0, sigChecksum: null };
// Ref 35 Stage B: the mtime `cache.sigChecksum` was actually computed for, and an
// in-flight guard - the checksum needs a zip-read + ASN.1 parse (lib/apk-signature-
// checksum.js), so it's computed off the refresh() hot path (async, fire-and-
// forget) and only when the file's mtime actually changed since the last
// successful computation. A poll/refresh flood never re-parses an unchanged APK.
let checksumMtime = null;
let checksumInFlight = null;

function refresh() {
  for (const p of candidates()) {
    try {
      const st = fs.statSync(p);
      const reusableChecksum = (cache.path === p && checksumMtime === st.mtimeMs) ? cache.sigChecksum : null;
      cache = { path: p, exists: true, size: st.size, mtime: st.mtimeMs, sigChecksum: reusableChecksum };
      if (reusableChecksum === null) scheduleChecksum(p, st.mtimeMs);
      return cache;
    } catch (_) {
      /* next */
    }
  }
  cache = { path: null, exists: false, size: 0, mtime: 0, sigChecksum: null };
  checksumMtime = null;
  return cache;
}

function scheduleChecksum(p, mtime) {
  if (checksumInFlight) return;
  checksumInFlight = computeSignatureChecksum(p)
    .then((checksum) => {
      if (cache.path === p && cache.mtime === mtime) {
        cache = { ...cache, sigChecksum: checksum };
        checksumMtime = mtime;
      }
    })
    .catch((e) => {
      console.warn(`[apk-cache] signature checksum computation failed for ${p}: ${e.message}`);
    })
    .finally(() => {
      checksumInFlight = null;
    });
}

function get() {
  return cache;
}

let timer = null;
function start() {
  refresh(); // resolve once at boot
  if (!timer) {
    timer = setInterval(refresh, config.otaApkRefreshMs);
    if (timer.unref) timer.unref();
  }
  return cache;
}

module.exports = { start, refresh, get };
