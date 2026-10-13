'use strict';

// Graceful shutdown waits for pending audit writes (server.js gracefulShutdown +
// services/activity.js drainActivity). Most audit rows are written fire-and-forget - the
// response goes out first - so a shutdown that closed the DB pool straight away lost
// whatever was still in flight ("Pool is closed", or a rolled-back transaction).
//
// Spawns a REAL server.js with two preloads:
//  - test/helpers/slow-audit-write.js holds every audit write SLOW_AUDIT_MS in flight;
//  - test/helpers/shutdown-trigger.js lets Windows deliver the shutdown signal (there a
//    SIGTERM from another process can't be caught); POSIX gets a real SIGTERM.
// The audit row comes from a failed login for an unknown email, written fire-and-forget
// by routes/auth.js, so no other test data is created. Real MySQL test DB (beamos_test
// via npm test). The audit rows stay: deleting them would break the hash chain, and the
// runner recreates beamos_test on every run.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { db } = require('../db/database');
const { randTag } = require('./helpers/disposable');
const { startServer } = require('./helpers/spawn-server');

const PRELOADS = [
  '--require', path.join(__dirname, 'helpers', 'slow-audit-write.js'),
  '--require', path.join(__dirname, 'helpers', 'shutdown-trigger.js'),
];

after(async () => { await db.close(); });

function sendShutdownSignal(srv) {
  if (process.platform === 'win32') fs.writeFileSync(path.join(srv.dataDir, 'shutdown-trigger'), '');
  else process.kill(srv.pid, 'SIGTERM');
}

// A failed login for an unknown email: 401 at once, its audit row written afterwards.
async function failedLogin(srv, email) {
  const r = await fetch(`${srv.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'not-the-password' }),
  });
  assert.equal(r.status, 401, 'unknown email is refused');
}

const auditRows = (email) => db.prepare(
  "SELECT id FROM activity_log WHERE action = 'auth:login_failed' AND details = ?",
).all(`${email} - User not found`);

// The child's exit, or null if it is still running after ms.
async function exitWithin(srv, ms) {
  let t;
  const timeout = new Promise((r) => { t = setTimeout(() => r(null), ms); });
  try { return await Promise.race([srv.exited, timeout]); } finally { clearTimeout(t); }
}

test('shutdown waits for an in-flight audit write: the row is written before exit', async () => {
  const srv = await startServer({ name: 'shutdown-audit-drain', nodeArgs: PRELOADS, env: { SLOW_AUDIT_MS: '500' } });
  try {
    const email = `drain-${randTag()}@x.local`;
    await failedLogin(srv, email);
    await srv.waitForOutput(/\[slow-audit-write\] delaying 500ms for auth:login_failed/);   // the write is in flight
    sendShutdownSignal(srv);
    const exit = await exitWithin(srv, 20000);
    assert.ok(exit, 'the server exited');

    assert.equal((await auditRows(email)).length, 1, 'the in-flight audit row was written before exit');
    const m = await srv.waitForOutput(/\[shutdown\] audit drain: (\d+) written, (\d+) failed, (\d+) remaining after \d+ ms/, 3000);
    assert.ok(Number(m[1]) >= 1, 'the drain reports the write');
    assert.equal(m[2], '0', 'no failed writes');
    assert.equal(m[3], '0', 'nothing left pending');
    assert.equal(exit.code, 0, 'clean exit code');
  } finally {
    await srv.stop();
  }
});

test('the drain is bounded: a write slower than SHUTDOWN_AUDIT_DRAIN_MS does not hold up the exit', async () => {
  const DRAIN_MS = 300;
  const SLOW_MS = 5000;
  const srv = await startServer({
    name: 'shutdown-audit-drain',
    nodeArgs: PRELOADS,
    env: { SLOW_AUDIT_MS: String(SLOW_MS), SHUTDOWN_AUDIT_DRAIN_MS: String(DRAIN_MS) },
  });
  try {
    const email = `drain-slow-${randTag()}@x.local`;
    await failedLogin(srv, email);
    await srv.waitForOutput(new RegExp(`\\[slow-audit-write\\] delaying ${SLOW_MS}ms for auth:login_failed`));
    const t0 = Date.now();
    sendShutdownSignal(srv);
    const exit = await exitWithin(srv, 20000);
    const elapsed = Date.now() - t0;
    assert.ok(exit, 'the server exited');

    const m = await srv.waitForOutput(/\[shutdown\] audit drain: (\d+) written, (\d+) failed, (\d+) remaining after (\d+) ms/, 3000);
    assert.equal(m[3], '1', 'the slow write is reported as remaining');
    assert.ok(Number(m[4]) < DRAIN_MS + 500, `the drain stopped at its limit (${m[4]} ms)`);
    assert.ok(elapsed < SLOW_MS - 1000, `the exit did not wait for the slow write (${elapsed} ms)`);
    assert.equal(exit.code, 0, 'a normal exit, not the forced one');
    assert.equal((await auditRows(email)).length, 0, 'the write still pending at exit is lost (the documented bound)');
  } finally {
    await srv.stop();
  }
});
