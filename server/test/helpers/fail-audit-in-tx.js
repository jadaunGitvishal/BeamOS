'use strict';

// Test-only hook for in-transaction audit writes (services/activity.js auditInTx).
// Wraps lib/activity-chain's exported appendInTx so ONE chosen call throws, as a failed
// audit write would. auditInTx then throws AuditUnavailableError, the caller's
// transaction rolls back and the request gets 503 AUDIT_UNAVAILABLE.
//
// It must be loaded BEFORE services/activity.js (which destructures appendInTx when it
// loads); it refuses to load afterwards. Two ways to use it:
//   - in-process: require it first in the test file, then failNextAuditInTx('action')
//     arms one failure for the next auditInTx with that action (or any action, if none);
//   - preload (`node --require test/helpers/fail-audit-in-tx.js server.js`): set
//     FAIL_AUDIT_IN_TX_ACTION to arm one failure at load.
// appendEntry (logActivity / auditOrWarn) and pruneChain call appendInTx internally, not
// through the export, so they are never affected. Prints one "[fail-audit-in-tx] failing
// <action>" line when it fires. Never run as a test itself: the runner's explicit file list
// excludes test/helpers/.

const path = require('path');

const activityPath = path.join(__dirname, '..', '..', 'services', 'activity.js');
if (require.cache[activityPath]) {
  throw new Error('fail-audit-in-tx must be loaded before services/activity.js');
}

const chain = require('../../lib/activity-chain');

const origAppendInTx = chain.appendInTx;
let armed = process.env.FAIL_AUDIT_IN_TX_ACTION ? { action: process.env.FAIL_AUDIT_IN_TX_ACTION } : null;
let firedCount = 0;

chain.appendInTx = async function appendInTx(tx, fields = {}) {
  if (armed && (!armed.action || armed.action === fields.action)) {
    armed = null;
    firedCount++;
    console.log(`[fail-audit-in-tx] failing ${fields.action}`);
    throw new Error(`fail-audit-in-tx: injected failure for ${fields.action}`);
  }
  return origAppendInTx(tx, fields);
};

// Arms one failure for the next auditInTx call with `action` (any action when omitted).
function failNextAuditInTx(action = null) {
  armed = { action };
}
// Disarms a failure that never fired; returns true if one was still armed.
function disarm() {
  const was = !!armed;
  armed = null;
  return was;
}
const fired = () => firedCount;

module.exports = { failNextAuditInTx, disarm, fired };
