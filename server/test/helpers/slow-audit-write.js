'use strict';

// Test-only preload (`node --require test/helpers/slow-audit-write.js server.js`), used by
// shutdown-audit-drain.test.js. Wraps lib/activity-chain's appendEntry so every audit
// write waits SLOW_AUDIT_MS (default 500) ms before it starts, holding it in flight. It
// must be preloaded: services/activity.js destructures appendEntry when it loads, so a
// later wrap would never be seen.
//
// Each delayed write prints one "[slow-audit-write] delaying <ms>ms for <action>" line
// first, so the test can act exactly while the write is pending. No other behaviour is
// touched. Never run as a test itself: the runner's explicit file list excludes
// test/helpers/.

const chain = require('../../lib/activity-chain');

const DELAY_MS = parseInt(process.env.SLOW_AUDIT_MS, 10) || 500;
const origAppend = chain.appendEntry;

chain.appendEntry = async function appendEntry(db, fields = {}) {
  console.log(`[slow-audit-write] delaying ${DELAY_MS}ms for ${fields.action}`);
  await new Promise((r) => setTimeout(r, DELAY_MS));
  return origAppend(db, fields);
};
