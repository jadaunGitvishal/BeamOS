'use strict';
// #146 — minimal global key/value settings for admin-toggleable RUNTIME flags. No
// generic settings table existed (ai_settings is per-workspace, white_labels is
// branding), so this adds one (app_settings). Values are CACHED in memory and refreshed
// on write, so a hot path — e.g. /api/status, polled under load — reads a cached boolean,
// never a per-poll DB read.

const { db } = require('../db/database');

// `key` is a reserved word in MySQL - every reference below backtick-quotes it
// (SQLite didn't require this).
const cache = new Map();   // key -> string value
let loaded = false;

// Async (queries the DB) - called once at boot (db/database.js's initDb(), after the
// schema exists) so the cache is warm before the first request. get()/getBool() stay
// SYNCHRONOUS reads of that cache on purpose: they're called inline in the /api/status
// hot path, which is polled under load and must never do a per-poll DB round trip.
async function loadAll() {
  cache.clear();
  try {
    for (const r of await db.prepare('SELECT `key`, value FROM app_settings').all()) cache.set(r.key, r.value);
  } catch (_) { /* table may not exist yet */ }
  loaded = true;
}

function get(key, dflt) {
  // Cache is populated at boot; if something reads before that (shouldn't happen with
  // the boot ordering in database.js), fall back to the caller's default rather than
  // trying to do a synchronous DB read, which is no longer possible with mysql2.
  return cache.has(key) ? cache.get(key) : dflt;
}

// Persist + refresh the cache so the change takes effect immediately (no restart).
async function set(key, value) {
  const v = String(value);
  await db.prepare(
    "INSERT INTO app_settings (`key`, value, updated_at) VALUES (?, ?, UNIX_TIMESTAMP()) ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)"
  ).run(key, v);
  cache.set(key, v);
  loaded = true;
}

// Boolean read with an env-default fallback: the PERSISTED value overrides once set,
// else the caller's env default applies.
function getBool(key, envDefault) {
  const v = get(key, undefined);
  if (v === undefined) return !!envDefault;
  return v === 'true' || v === '1';
}
async function setBool(key, value) { await set(key, value ? 'true' : 'false'); }

module.exports = { get, set, getBool, setBool, __reload: loadAll };
