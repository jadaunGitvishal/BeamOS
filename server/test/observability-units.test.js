'use strict';

// #146 — unit coverage for the two new primitives behind the /api/status changes.

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-obsunit-' + crypto.randomBytes(4).toString('hex'));

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const heartbeat = require('../services/heartbeat');
const appSettings = require('../lib/app-settings');
const { db } = require('../db/database');

// The app-settings test writes the real platform-wide key status_debug_enabled: capture
// its row (value + updated_at, or absence) first and put it back exactly afterwards.
const SETTING = 'status_debug_enabled';
let savedSetting;   // undefined = not captured, null = key absent, else the row
before(async () => {
  savedSetting = (await db.prepare('SELECT value, updated_at FROM app_settings WHERE `key` = ?').get(SETTING)) || null;
});
after(async () => {
  try {
    if (savedSetting) {
      await db.prepare('INSERT INTO app_settings (`key`, value, updated_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)')
        .run(SETTING, savedSetting.value, savedSetting.updated_at);
    } else if (savedSetting === null) {
      await db.prepare('DELETE FROM app_settings WHERE `key` = ?').run(SETTING);
    }
  } finally {
    await db.close();
  }
});

test('heartbeat.getConnectedCount reflects the live connection map (not DB status)', () => {
  const start = heartbeat.getConnectedCount();
  heartbeat.registerConnection('dev-a', 'sock-a');
  heartbeat.registerConnection('dev-b', 'sock-b');
  assert.equal(heartbeat.getConnectedCount(), start + 2, 'count rises with registered sockets');
  heartbeat.removeConnection('dev-a');
  assert.equal(heartbeat.getConnectedCount(), start + 1, 'count falls when a socket leaves');
  heartbeat.removeConnection('dev-b');
  assert.equal(heartbeat.getConnectedCount(), start);
});

test('app-settings: env default until set, then persisted value overrides (cached)', async () => {
  assert.equal(appSettings.getBool('status_debug_enabled', true), true, 'falls back to env default when unset');
  assert.equal(appSettings.getBool('status_debug_enabled', false), false, 'default honored when unset');
  await appSettings.setBool('status_debug_enabled', false);
  assert.equal(appSettings.getBool('status_debug_enabled', true), false, 'persisted false overrides the (true) default');
  await appSettings.setBool('status_debug_enabled', true);
  assert.equal(appSettings.getBool('status_debug_enabled', false), true, 'persisted true overrides the (false) default');
});
