'use strict';

// test/helpers/spawn-server.js - the shared spawned-server helper. Its readiness, failure
// and cleanup paths run against small stub scripts written to a temp dir OUTSIDE the repo
// (passed via the helper's internal `script` option), so they don't depend on the real
// server; one smoke test boots the real server.js against the test database.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { startServer } = require('./helpers/spawn-server');
const { freePort } = require('./helpers/free-port');

let stubDir;
const stub = {};

// Each stub is plain node; PORT and DATA_DIR come from the helper.
const STUBS = {
  // Stage lines, then a listener answering /api/status - a healthy boot.
  ready: `
    const http = require('http');
    console.log('[boot] pid ' + process.pid + ' starting (node ' + process.version + ')');
    console.log('[boot] modules loaded in 1ms');
    console.log('[db] connecting');
    console.log('stub DATA_DIR=' + process.env.DATA_DIR + ' exists=' + require('fs').existsSync(process.env.DATA_DIR));
    http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); })
      .listen(Number(process.env.PORT), '127.0.0.1', () => console.log('[boot] listening on :' + process.env.PORT + ' (5ms since start)'));
  `,
  // Exits at once with code 3.
  exit3: `
    console.log('[boot] pid ' + process.pid + ' starting (node ' + process.version + ')');
    console.error('stub: fatal, exiting with 3');
    process.exit(3);
  `,
  // Starts, then hangs forever before "modules loaded".
  hang: `
    console.log('[boot] pid ' + process.pid + ' starting (node ' + process.version + ')');
    setInterval(() => {}, 1000);
  `,
  // Gets as far as a DB phase, never listens.
  stallDb: `
    console.log('[boot] pid ' + process.pid + ' starting (node ' + process.version + ')');
    console.log('[boot] modules loaded in 1ms');
    console.log('[db] connecting');
    console.log('[db] applySchema ...');
    setInterval(() => {}, 1000);
  `,
};

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const pidFrom = (msg) => Number((msg.match(/child pid (\d+)/) || [])[1]);

test.before(() => {
  stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beamos-spawn-stubs-'));
  for (const [k, src] of Object.entries(STUBS)) {
    stub[k] = path.join(stubDir, `${k}.js`);
    fs.writeFileSync(stub[k], src);
  }
});
test.after(() => { if (stubDir) fs.rmSync(stubDir, { recursive: true, force: true }); });

test('ready stub: reported ready on a fresh port, output captured, stop() kills it and removes DATA_DIR', async () => {
  const srv = await startServer({ name: 'stub-ready', script: stub.ready, bootTimeoutMs: 10000 });
  try {
    assert.equal(srv.base, `http://127.0.0.1:${srv.port}`);
    assert.equal((await fetch(srv.base + '/api/status')).status, 200);
    assert.match(srv.output(), /\[boot\] pid \d+ starting/);
    assert.match(srv.output(), /\[db\] connecting/);
    assert.match(srv.output(), new RegExp(`\\[boot\\] listening on :${srv.port}\\b`));
    assert.match(srv.output(), /stub DATA_DIR=.+ exists=true/, 'the child got a fresh, existing DATA_DIR');
    assert.ok(fs.existsSync(srv.logPath) && /\[db\] connecting/.test(fs.readFileSync(srv.logPath, 'utf8')), 'output also appended to logPath');
    assert.equal((await srv.waitForOutput(/listening on :(\d+)/))[1], String(srv.port));
  } finally {
    await srv.stop();
  }
  assert.equal(alive(srv.pid), false, 'child is gone after stop()');
  assert.equal(fs.existsSync(srv.dataDir), false, 'DATA_DIR removed');
  assert.equal(fs.existsSync(path.dirname(srv.logPath)), false, 'temp dir (log) removed');
  await srv.stop();   // idempotent
});

test('early exit: rejects fast with the exit code and the output tail', async () => {
  const t0 = Date.now();
  const err = await startServer({ name: 'stub-exit3', script: stub.exit3, bootTimeoutMs: 30000 }).then(() => null, (e) => e);
  assert.ok(err, 'rejected');
  assert.ok(Date.now() - t0 < 10000, `rejected well under the 30s timeout (${Date.now() - t0}ms)`);
  assert.match(err.message, /stub-exit3: exited before it was ready/);
  assert.match(err.message, /exited with code 3/);
  assert.match(err.message, /stub: fatal, exiting with 3/, 'output tail included');
  assert.match(err.message, /last stage line: \[boot\] pid \d+ starting/);
  fs.rmSync(path.dirname(err.message.match(/log: (.+)/)[1]), { recursive: true, force: true });
});

test('hang: rejects at bootTimeoutMs with "still running", the last stage line and the hint; the child is gone', async () => {
  const t0 = Date.now();
  const err = await startServer({ name: 'stub-hang', script: stub.hang, bootTimeoutMs: 2000 }).then(() => null, (e) => e);
  assert.ok(err, 'rejected');
  const ms = Date.now() - t0;
  assert.ok(ms >= 1900 && ms < 10000, `gave up at the 2s timeout (${ms}ms)`);
  assert.match(err.message, /stub-hang: not ready within 2000ms/);
  assert.match(err.message, /still running \(killed\)/);
  assert.match(err.message, /last stage line: \[boot\] pid \d+ starting \(node v/);
  assert.match(err.message, /hint: no "\[boot\] modules loaded" line: module loading was slow or stuck/);
  const logPath = err.message.match(/log: (.+)/)[1];
  assert.ok(fs.existsSync(logPath), 'the log is kept for post-mortem');
  assert.equal(fs.existsSync(path.join(path.dirname(logPath), 'data')), false, 'DATA_DIR removed even on failure');
  const pid = pidFrom(err.message);
  assert.ok(pid > 0);
  assert.equal(alive(pid), false, `child ${pid} is no longer alive`);
  fs.rmSync(path.dirname(logPath), { recursive: true, force: true });
});

test('a stall in a DB phase: the hint points at the last [db] line', async () => {
  const err = await startServer({ name: 'stub-stall-db', script: stub.stallDb, bootTimeoutMs: 1500 }).then(() => null, (e) => e);
  assert.ok(err);
  assert.match(err.message, /last stage line: \[db\] applySchema \.\.\./);
  assert.match(err.message, /hint: the last \[db\]\/\[boot\] line shown is the startup stage where it stalled/);
  assert.equal(alive(pidFrom(err.message)), false);
  fs.rmSync(path.dirname(err.message.match(/log: (.+)/)[1]), { recursive: true, force: true });
});

test('orphan protection: another listener answering /api/status on the port is NOT taken for this child', async () => {
  const port = await freePort();
  const orphan = http.createServer((req, res) => { res.writeHead(200); res.end('{"orphan":true}'); });
  await new Promise((r) => orphan.listen(port, '127.0.0.1', r));
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/status`)).status, 200, 'precondition: the orphan answers');
    const err = await startServer({ name: 'stub-orphan', script: stub.stallDb, port, bootTimeoutMs: 2000 }).then(() => null, (e) => e);
    assert.ok(err, 'not reported ready');
    assert.match(err.message, /not ready within 2000ms/);
    assert.match(err.message, new RegExp(`never printed "\\[boot\\] listening on :${port}" - another process \\(an orphaned server\\?\\) holds the port`));
    assert.equal(alive(pidFrom(err.message)), false);
    fs.rmSync(path.dirname(err.message.match(/log: (.+)/)[1]), { recursive: true, force: true });
  } finally {
    await new Promise((r) => orphan.close(r));
  }
});

test('expectExit: resolves with the exit code and output once the child exits', async () => {
  const r = await startServer({ name: 'stub-expect-exit', script: stub.exit3, expectExit: true, bootTimeoutMs: 10000 });
  assert.equal(r.code, 3);
  assert.equal(r.signal, null);
  assert.match(r.output, /stub: fatal, exiting with 3/);
});

test('guard: an inherited MYSQL_DATABASE pointing at the dev database refuses to spawn', async () => {
  const before = fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('beamos-spawn-stub-guard-')).length;
  const saved = process.env.MYSQL_DATABASE;
  process.env.MYSQL_DATABASE = 'beamos';
  try {
    await assert.rejects(startServer({ name: 'stub-guard', script: stub.ready, bootTimeoutMs: 5000 }),
      /\[spawn-server\] stub-guard: refusing to spawn: \[test-db-guard\] refusing to use database "beamos"/);
  } finally {
    if (saved === undefined) delete process.env.MYSQL_DATABASE; else process.env.MYSQL_DATABASE = saved;
  }
  const after = fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('beamos-spawn-stub-guard-')).length;
  assert.equal(after, before, 'no temp dir left behind');
});

test('real server.js (helper-smoke): ready against the test database, /api/status 200, stop() cleans up', async () => {
  const srv = await startServer({ name: 'helper-smoke' });
  try {
    assert.equal((await fetch(srv.base + '/api/status')).status, 200);
    assert.match(srv.output(), /\[db\] MySQL ready \(.+\/beamos_test\)/);
    assert.match(srv.output(), new RegExp(`\\[boot\\] listening on :${srv.port} \\(\\d+ms since start\\)`));
  } finally {
    await srv.stop();
  }
  assert.equal(alive(srv.pid), false, 'server process is gone');
  assert.equal(fs.existsSync(path.dirname(srv.logPath)), false, 'temp dir removed');
});
