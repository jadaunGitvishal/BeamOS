'use strict';

// Ref 32: pure lat/long sanitiser for the telemetry ingestion path. Mirrors the
// Android LocationTelemetry.sanitize() contract (telemetry/LocationTelemetry.kt) so
// the server stores the same "valid fix or NULL" shape the device already applies -
// and still holds the line if a future/other client sends something sloppy.
//
// No DB, no I/O - unit-tested in test/geo.test.js.

// Coerce to a finite number, or null. Accepts numeric strings (JSON from the wire
// can be either), rejects '', null, undefined, NaN, +/-Infinity, booleans, objects.
function toFiniteNumber(v) {
  if (typeof v === 'boolean') return null;
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function round6(v) {
  return Math.round(v * 1e6) / 1e6;
}

/**
 * @returns {{latitude:number, longitude:number}|null}
 *   null when the pair is unusable and telemetry should store NULL/NULL:
 *     - either value missing / non-finite
 *     - latitude outside [-90, 90] or longitude outside [-180, 180]
 *     - exactly (0, 0) — "Null Island", a default/failed fix, never a real screen
 *   Kept fixes are rounded to 6 decimals (~11 cm).
 */
function sanitizeCoords(latitude, longitude) {
  const lat = toFiniteNumber(latitude);
  const lon = toFiniteNumber(longitude);
  if (lat === null || lon === null) return null;
  if (lat < -90 || lat > 90) return null;
  if (lon < -180 || lon > 180) return null;
  if (lat === 0 && lon === 0) return null;
  return { latitude: round6(lat), longitude: round6(lon) };
}

module.exports = { sanitizeCoords };
