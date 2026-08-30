'use strict';

// Ref 30: the public /activate/:code landing page (server/lib/activate-page.js)
// and its "Copy code" behaviour (frontend/js/activate.js). Covers the pure
// renderer, the real Express handler, and — crucially — the copy button run in a
// DOM configured as a PLAIN-HTTP, non-localhost origin, which is where
// navigator.clipboard.writeText() silently fails (the bug the user hit).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { JSDOM } = require('jsdom');

const raw = new Database(':memory:');
raw.exec(`
  CREATE TABLE registration_codes (
    id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, workspace_id TEXT NOT NULL,
    planned_device_name TEXT, status TEXT NOT NULL DEFAULT 'unused',
    created_by TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER,
    claimed_by_device_id TEXT, claimed_at INTEGER
  );
`);
raw.prepare(`INSERT INTO registration_codes (id, code, workspace_id, created_by, created_at, expires_at)
             VALUES ('rc1', '284765', 'ws-a', 'u1', 1700000000, 1799999999)`).run();
raw.prepare(`INSERT INTO registration_codes (id, code, workspace_id, status, created_by, created_at)
             VALUES ('rc2', '111222', 'ws-a', 'claimed', 'u1', 1700000000)`).run();

const dbModulePath = require.resolve('../db/database');
require.cache[dbModulePath] = { id: dbModulePath, filename: dbModulePath, loaded: true, exports: { db: raw } };

const express = require('express');
const { renderActivatePage, activateHandler } = require('../lib/activate-page');

const ACTIVATE_JS = fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend', 'js', 'activate.js'), 'utf8',
);

// ---- pure renderer -----------------------------------------------------------
test('renderActivatePage: known code shows the code, instruction, copy button + hooks', () => {
  const html = renderActivatePage({ code: '284765', found: true });
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /Activation Code/);
  assert.match(html, /<p class="code" id="code">284765<\/p>/);
  assert.match(html, /Type this code into the display's setup screen/);
  assert.match(html, /<button class="copy" type="button" id="copyBtn">Copy code<\/button>/);
  assert.match(html, /<p class="status" id="copyStatus"/, 'has a live status element for feedback');
  assert.match(html, /<script src="\/js\/activate\.js" defer><\/script>/, 'behaviour is an external script (CSP scriptSrc self)');
  assert.doesNotMatch(html, /onclick=/i, 'no inline onclick — it cannot report async copy success/failure');
});

test('renderActivatePage: unknown code shows "Code not found", no copy button or script', () => {
  const html = renderActivatePage({ code: '999999', found: false });
  assert.match(html, /Code not found/);
  assert.match(html, /doesn't exist/);
  assert.doesNotMatch(html, /Copy code/);
  assert.doesNotMatch(html, /activate\.js/);
});

test('renderActivatePage: malformed code (null) shows the invalid-format message', () => {
  const html = renderActivatePage({ code: null, found: false });
  assert.match(html, /Code not found/);
  assert.match(html, /valid 6-digit activation code/);
  assert.doesNotMatch(html, /Copy code/);
});

test('renderActivatePage: escapes the code into the HTML', () => {
  // The handler only ever passes /^[0-9]{6}$/ or null, but the renderer must not
  // trust its input.
  const html = renderActivatePage({ code: `1'2<3`, found: true });
  assert.match(html, /1&#39;2&lt;3/);
  assert.doesNotMatch(html, /1'2<3/);
});

// ---- "Copy code" behaviour (frontend/js/activate.js) ------------------------
//
// Run in a JSDOM window whose URL is a plain-HTTP, non-localhost origin — i.e.
// exactly http://172.23.208.1:5001/activate/... from the report. JSDOM exposes
// neither navigator.clipboard (secure-context only) nor document.execCommand, so
// `clipboard: null` is the faithful "no auto-copy available" reproduction. The
// companion activate-copy-browser.test.js drives the same paths in real Chrome.
function runCopyPage(clipboard) {
  const html = renderActivatePage({ code: '722165', found: true });
  const dom = new JSDOM(html, {
    url: 'http://172.23.208.1:5001/activate/722165',
    runScripts: 'dangerously',
  });
  const win = dom.window;
  Object.defineProperty(win.navigator, 'clipboard', { value: clipboard, configurable: true });
  const el = win.document.createElement('script');
  el.textContent = ACTIVATE_JS;
  win.document.body.appendChild(el); // executes synchronously
  return win;
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const statusOf = (win) => win.document.getElementById('copyStatus');

test('copy (plain HTTP, no auto-copy available): shows the manual-copy message, not silence', async () => {
  const win = runCopyPage(null); // navigator.clipboard undefined — the reported case
  win.document.getElementById('copyBtn').click();
  await tick();
  const s = statusOf(win);
  assert.match(s.textContent, /Couldn't auto-copy/);
  assert.match(s.textContent, /press and hold the code/i);
  assert.equal(s.className, 'status warn');
});

test('copy (clipboard.writeText rejects, e.g. blocked on non-secure origin): manual-copy message', async () => {
  const win = runCopyPage({ writeText: () => Promise.reject(new Error('NotAllowedError')) });
  win.document.getElementById('copyBtn').click();
  await tick();
  await tick();
  const s = statusOf(win);
  assert.match(s.textContent, /Couldn't auto-copy/);
  assert.equal(s.className, 'status warn');
});

test('copy (HTTPS, clipboard works): shows "Copied!"', async () => {
  let wrote = null;
  const win = runCopyPage({ writeText: (v) => { wrote = v; return Promise.resolve(); } });
  win.document.getElementById('copyBtn').click();
  await tick();
  const s = statusOf(win);
  assert.equal(wrote, '722165', 'the actual code was written');
  assert.equal(s.textContent, 'Copied!');
  assert.equal(s.className, 'status ok');
});

test('copy: the button never throws and the status starts empty', () => {
  const win = runCopyPage(null);
  const s = statusOf(win);
  assert.equal(s.textContent, '', 'no premature feedback before a click');
  assert.doesNotThrow(() => win.document.getElementById('copyBtn').click());
});

// ---- Express handler -------------------------------------------------------
const app = express();
app.get('/activate/:code', activateHandler);
const server = app.listen(0);
let base;
test.before(async () => {
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); raw.close(); });

test('GET /activate/:code — valid + existing code renders the code', async () => {
  const res = await fetch(`${base}/activate/284765`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  assert.match(html, />284765</);
  assert.match(html, /Activation Code/);
  assert.match(html, /Copy code/);
});

test('GET /activate/:code — a claimed code still just shows the code (device claim gives the real error)', async () => {
  const html = await (await fetch(`${base}/activate/111222`)).text();
  assert.match(html, />111222</);
  assert.doesNotMatch(html, /Code not found/);
});

test('GET /activate/:code — unknown (well-formed) code -> "Code not found"', async () => {
  const html = await (await fetch(`${base}/activate/999999`)).text();
  assert.match(html, /Code not found/);
  assert.doesNotMatch(html, /Copy code/);
});

test('GET /activate/:code — malformed code -> "Code not found", never an error page', async () => {
  for (const bad of ['abcdef', '12345', '12345678', '<x>']) {
    const res = await fetch(`${base}/activate/${encodeURIComponent(bad)}`);
    assert.equal(res.status, 200, `"${bad}" still returns a rendered page`);
    const html = await res.text();
    assert.match(html, /Code not found/);
    assert.doesNotMatch(html, new RegExp(bad.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'raw input not reflected');
  }
});
