'use strict';

// Shared helper for tests that spawn the real server (server.js) as a child process.
//
//   const srv = await startServer({ name, env, nodeArgs, bootTimeoutMs, expectExit });
//   srv.port / srv.base / srv.logPath / srv.output() / await srv.waitForOutput(re, ms) / await srv.stop()
//
// - Port: always a fresh free port. "Ready" means /api/status answered AND this child
//   printed "[boot] listening on :<port>" itself, so an orphaned server still holding a
//   reused port can never be mistaken for this one.
// - Env: { ...process.env, DATA_DIR, PORT, SELF_HOSTED, NODE_ENV, SCHEDULERS_ENABLED,
//   ...env } (caller env wins). The MySQL settings are inherited from the runner; the
//   effective database / user must pass lib/test-db-guard or nothing is spawned.
// - Output: stdout + stderr captured in memory (last ~1MB) and appended to logPath.
// - Failure (timeout or early exit): the child is killed - the whole process tree on
//   Windows - and has exited BEFORE the Error is thrown. The message carries the name,
//   elapsed ms, exit code/signal or "still running", the last [boot]/[db] stage line
//   (server.js / db/database.js startup lines), an output tail, logPath and a hint.
// - expectExit: true -> resolves { code, signal, output } once the child exits by itself
//   (for servers that must refuse to start); a timeout rejects with the same diagnostics.
// - stop(): kill, wait for exit, remove the temp dir (DATA_DIR + log). Idempotent.
//
// Internal options, used only by spawn-server-helper.test.js: `script` (a stub instead of
// server.js) and `port` (force a port, for the orphan-listener check).

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { freePort } = require('./free-port');
const { assertSafeTestDb } = require('../../lib/test-db-guard');

const SERVER_DIR = path.join(__dirname, '..', '..');
const OUTPUT_CAP = 1024 * 1024;   // keep the last ~1MB of output in memory
const TAIL_CHARS = 3000;
const POLL_MS = 200;
const STAGE_LINE = /^\[(boot|db)\] /;

const live = new Set();   // children not yet known to have exited

function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (_) { /* already gone */ }
  }
  try { child.kill('SIGKILL'); } catch (_) { /* already gone */ }
}

// Last-resort cleanup: never leave a spawned server running after this process ends.
let hooksInstalled = false;
function installExitHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;
  process.on('exit', () => { for (const c of live) killTree(c); });
  for (const sig of ['SIGINT', 'SIGTERM']) {
    const onSignal = () => {
      for (const c of live) killTree(c);
      process.removeListener(sig, onSignal);
      process.kill(process.pid, sig);   // then let the default handling end this process
    };
    process.on(sig, onSignal);
  }
}

// p's value, or `fallback` after ms - clearing the timer either way, so a long timeout
// (e.g. expectExit's 60s) never keeps the test process alive after p has settled.
function within(p, ms, fallback) {
  let t;
  const timer = new Promise((r) => { t = setTimeout(() => r(fallback), ms); });
  return Promise.race([p, timer]).finally(() => clearTimeout(t));
}

function hintFor(text) {
  if (!/^\[boot\] pid \d+ starting/m.test(text)) return 'no "[boot] ... starting" line: the process never started server.js.';
  if (!/^\[boot\] modules loaded/m.test(text)) return 'no "[boot] modules loaded" line: module loading was slow or stuck (e.g. cold file cache / antivirus scanning after sleep).';
  return 'the last [db]/[boot] line shown is the startup stage where it stalled or failed.';
}

async function startServer(opts = {}) {
  const { name = 'server', env = {}, nodeArgs = [], expectExit = false, script, port: forcedPort } = opts;
  const bootTimeoutMs = opts.bootTimeoutMs || parseInt(process.env.SPAWN_BOOT_TIMEOUT_MS, 10) || 60000;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `beamos-spawn-${String(name).replace(/[^A-Za-z0-9_-]/g, '_')}-`));
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir);
  const logPath = path.join(dir, 'server.log');
  const port = forcedPort || await freePort();
  const childEnv = {
    ...process.env, DATA_DIR: dataDir, PORT: String(port), SELF_HOSTED: 'true', NODE_ENV: 'test', SCHEDULERS_ENABLED: 'false', ...env,
  };
  try {
    // Defence in depth: the child connects with whatever database / user it ends up with
    // (config.js defaults: beamos / beamos_user) - refuse unless that is the test account
    // on a test database.
    assertSafeTestDb({ database: childEnv.MYSQL_DATABASE || 'beamos', user: childEnv.MYSQL_USER || 'beamos_user' });
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(`[spawn-server] ${name}: refusing to spawn: ${e.message}`);
  }

  installExitHooks();
  const t0 = Date.now();
  const logFd = fs.openSync(logPath, 'a');
  const child = spawn(process.execPath, [...nodeArgs, script || 'server.js'], { cwd: SERVER_DIR, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  live.add(child);

  let out = '';
  let partial = '';
  let lastStage = null;
  const onData = (d) => {
    const s = d.toString();
    try { fs.writeSync(logFd, s); } catch (_) { /* log is best-effort */ }
    out += s;
    if (out.length > OUTPUT_CAP) out = out.slice(out.length - OUTPUT_CAP);
    const lines = (partial + s).split(/\r?\n/);
    partial = lines.pop();
    for (const l of lines) if (STAGE_LINE.test(l)) lastStage = l;
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  let exitInfo = null;
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => {
    exitInfo = { code, signal };
    live.delete(child);
    resolve(exitInfo);
  }));
  // Both stdio pipes drained too, so no output is lost after 'exit'.
  const closed = new Promise((resolve) => child.on('close', resolve));

  const output = () => out + partial;
  let stopped = false;
  async function stop({ keepLog = false } = {}) {
    if (!stopped) {
      stopped = true;
      killTree(child);
      await exited;
      await within(closed, 2000);
      try { fs.closeSync(logFd); } catch (_) { /* already closed */ }
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
    if (!keepLog) fs.rmSync(dir, { recursive: true, force: true });
  }

  async function fail(reason, extra = '') {
    const still = exitInfo === null;
    await stop({ keepLog: true });   // kill (tree) + wait for exit BEFORE throwing; keep the log
    const state = still ? 'still running (killed)' : `exited with code ${exitInfo.code}${exitInfo.signal ? `, signal ${exitInfo.signal}` : ''}`;
    const text = out + partial;
    throw new Error([
      `[spawn-server] ${name}: ${reason} after ${Date.now() - t0}ms; child pid ${child.pid} ${state}.`,
      `last stage line: ${lastStage || '(none)'}`,
      `hint: ${hintFor(text)}`,
      extra,
      `log: ${logPath}`,
      `--- output tail ---`,
      text.slice(-TAIL_CHARS) || '(no output)',
    ].filter(Boolean).join('\n'));
  }

  const timedOut = (ms) => Date.now() - t0 >= ms;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  if (expectExit) {
    const r = await within(exited, bootTimeoutMs, null);
    if (!r) return fail(`did not exit within ${bootTimeoutMs}ms (expectExit)`);
    await within(closed, 2000);
    await stop();
    return { code: r.code, signal: r.signal, output: out + partial };
  }

  const listening = new RegExp(`^\\[boot\\] listening on :${port}\\b`, 'm');
  const base = `http://127.0.0.1:${port}`;
  let foreignAnswer = false;   // /api/status answered while this child had not said it is listening
  for (;;) {
    if (exitInfo) return fail('exited before it was ready');
    if (timedOut(bootTimeoutMs)) {
      return fail(`not ready within ${bootTimeoutMs}ms`, foreignAnswer
        ? `note: something answered ${base}/api/status, but this child never printed "[boot] listening on :${port}" - another process (an orphaned server?) holds the port.`
        : '');
    }
    let ok = false;
    try { ok = (await fetch(`${base}/api/status`, { signal: AbortSignal.timeout(2000) })).ok; } catch (_) { /* not up yet */ }
    if (ok) {
      if (listening.test(out)) break;
      foreignAnswer = true;
    }
    await within(exited, POLL_MS);
  }

  async function waitForOutput(re, ms = 10000) {
    const until = Date.now() + ms;
    for (;;) {
      const m = (out + partial).match(re);
      if (m) return m;
      if (Date.now() >= until) throw new Error(`[spawn-server] ${name}: output did not match ${re} within ${ms}ms\n--- output tail ---\n${(out + partial).slice(-TAIL_CHARS)}`);
      await sleep(20);
    }
  }

  return { name, port, base, logPath, dataDir, pid: child.pid, output, waitForOutput, stop };
}

module.exports = { startServer };
