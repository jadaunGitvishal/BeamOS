'use strict';

// Test-only preload (`node --require test/helpers/slow-offline-update.js server.js`), used by
// offline-race.test.js. Wraps db/database's prepare() so a statement whose SQL contains
// "SET status = 'offline'" (the offline UPDATEs in ws/deviceSocket.js offlineTransition and
// services/heartbeat.js) has run() delayed by SLOW_OFFLINE_MS (default 800) ms. That holds
// the offline-marking await open long enough for a test to reconnect the device inside it.
//
// Each delayed run() prints one "[slow-offline-update] delaying <ms>ms for <id>" line first,
// so the test can reconnect exactly inside the window instead of guessing at timing. No
// other statement, and no other behaviour, is touched. Never run as a test itself: the
// runner's explicit file list excludes test/helpers/.

const database = require('../../db/database');

const DELAY_MS = parseInt(process.env.SLOW_OFFLINE_MS, 10) || 800;
const MATCH = "SET status = 'offline'";
const origPrepare = database.db.prepare;

database.db.prepare = function prepare(sql) {
  const stmt = origPrepare.call(this, sql);
  if (typeof sql !== 'string' || !sql.includes(MATCH)) return stmt;
  const origRun = stmt.run;
  stmt.run = async function run(...params) {
    console.log(`[slow-offline-update] delaying ${DELAY_MS}ms for ${params[0]}`);
    await new Promise((r) => setTimeout(r, DELAY_MS));
    return origRun.apply(this, params);
  };
  return stmt;
};
