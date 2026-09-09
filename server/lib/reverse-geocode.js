'use strict';

// Ref 43 — reverse-geocode a field-visit photo's GPS fix into a short
// human-readable place name ("Gurugram, Haryana, India") via OpenStreetMap's
// Nominatim (the same OSM ecosystem the "View location" links use).
//
// Best-effort by design: every failure path returns null and is swallowed +
// logged. The caller (routes/workspaces.js) runs this AFTER responding 201, so
// it can never block or fail a photo upload.
//
// Nominatim usage policy (https://operations.osmfoundation.org/policies/nominatim/):
//   - an identifying User-Agent  -> config.nominatimUserAgent (+ publicBaseUrl)
//   - <= 1 request / second      -> a process-wide promise chain gates every call
//                                   to MIN_INTERVAL_MS apart
//   - no bulk / systematic use   -> this only fires on a human uploading a photo

const config = require('../config');

const MIN_INTERVAL_MS = 1100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const userAgent =
  config.nominatimUserAgent +
  (config.publicBaseUrl ? ` (${config.publicBaseUrl})` : '');

// Serialize ALL reverse-geocode calls in this process so the 1 req/s cap holds
// even when several photos upload back-to-back.
let chain = Promise.resolve();
let lastStartedAt = 0;

function reverseGeocode(lat, lon) {
  if (!config.reverseGeocodeEnabled) return Promise.resolve(null);
  if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    return Promise.resolve(null);
  }
  const run = chain.then(async () => {
    const wait = MIN_INTERVAL_MS - (Date.now() - lastStartedAt);
    if (wait > 0) await sleep(wait);
    lastStartedAt = Date.now();
    return lookup(lat, lon);
  });
  // keep the chain alive regardless of this call's outcome
  chain = run.then(() => {}, () => {});
  return run;
}

async function lookup(lat, lon) {
  const url = `${config.nominatimUrl}?format=jsonv2&addressdetails=1&zoom=14&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.nominatimTimeoutMs);
  try {
    const resp = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': userAgent, Accept: 'application/json' },
    });
    if (!resp.ok) {
      console.warn(`[reverse-geocode] ${lat},${lon} -> HTTP ${resp.status}`);
      return null;
    }
    const json = await resp.json();
    return formatPlace(json);
  } catch (e) {
    console.warn(`[reverse-geocode] ${lat},${lon} -> ${e.name === 'AbortError' ? 'timeout' : e.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Compose a short "<locality>, <state>, <country>" from Nominatim's structured
// address, falling back to the trimmed display_name.
function formatPlace(json) {
  if (!json || typeof json !== 'object') return null;
  const a = json.address || {};
  const locality =
    a.city || a.town || a.village || a.suburb || a.municipality ||
    a.city_district || a.county || a.state_district || null;
  const parts = [locality, a.state, a.country].filter(Boolean);
  let name = parts.length ? [...new Set(parts)].join(', ') : (json.display_name || '');
  name = String(name).trim();
  if (!name) return null;
  return name.length > 255 ? name.slice(0, 255) : name;
}

module.exports = { reverseGeocode, formatPlace };
