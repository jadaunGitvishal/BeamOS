'use strict';

// Ref 32: unit coverage for the telemetry lat/long sanitiser. Mirrors the Kotlin
// LocationTelemetryTest contract (android .../telemetry/LocationTelemetryTest.kt).
// No DB, no server.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeCoords } = require('../lib/geo');

test('valid fix passes through, rounded to 6 decimals', () => {
  assert.deepEqual(sanitizeCoords(37.4224082733, -122.0840684311), {
    latitude: 37.422408,
    longitude: -122.084068,
  });
});

test('numeric strings are accepted (wire JSON may send either)', () => {
  assert.deepEqual(sanitizeCoords('51.5074', '-0.1278'), {
    latitude: 51.5074,
    longitude: -0.1278,
  });
});

test('missing / empty / non-finite values -> null', () => {
  assert.equal(sanitizeCoords(undefined, undefined), null);
  assert.equal(sanitizeCoords(null, null), null);
  assert.equal(sanitizeCoords(10, null), null);
  assert.equal(sanitizeCoords('', 10), null);
  assert.equal(sanitizeCoords(NaN, 10), null);
  assert.equal(sanitizeCoords(10, Infinity), null);
  assert.equal(sanitizeCoords('not-a-number', 10), null);
  assert.equal(sanitizeCoords(true, 10), null);
});

test('out-of-range values -> null', () => {
  assert.equal(sanitizeCoords(90.001, 10), null);
  assert.equal(sanitizeCoords(-90.5, 10), null);
  assert.equal(sanitizeCoords(10, 180.5), null);
  assert.equal(sanitizeCoords(10, -181), null);
});

test('exact range bounds are accepted', () => {
  assert.deepEqual(sanitizeCoords(90, 180), { latitude: 90, longitude: 180 });
  assert.deepEqual(sanitizeCoords(-90, -180), { latitude: -90, longitude: -180 });
});

test('(0, 0) is rejected as Null Island', () => {
  assert.equal(sanitizeCoords(0, 0), null);
  assert.equal(sanitizeCoords('0', '0'), null);
});

test('a single zero axis is fine', () => {
  assert.deepEqual(sanitizeCoords(0, 12.5), { latitude: 0, longitude: 12.5 });
  assert.deepEqual(sanitizeCoords(45, 0), { latitude: 45, longitude: 0 });
});
