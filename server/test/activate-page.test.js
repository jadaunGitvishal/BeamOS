'use strict';

// Ref 30: the public /activate/:code landing page (server/lib/activate-page.js).
// The registration-code QR encodes a link to this page; scanning it should open a
// clean "here is your code" page, not trigger a phone web search. Covers the pure
// renderer and the real Express handler (with an in-memory registration_codes DB
// swapped in, same pattern as the other Ref 30 tests).

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

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

// ---- pure renderer -------------------------------------------------------
test('renderActivatePage: known code shows the code, instruction, and copy button', () => {
  const html = renderActivatePage({ code: '284765', found: true });
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /Activation Code/);
  assert.match(html, />284765</);
  assert.match(html, /Type this code into the display's setup screen/);
  assert.match(html, /Copy code/);
  assert.match(html, /writeText\('284765'\)/, 'copy button wired to the actual code');
  assert.doesNotMatch(html, /<script/i, 'no <script> block (CSP-safe: inline onclick only)');
});

test('renderActivatePage: unknown code shows "Code not found", no copy button', () => {
  const html = renderActivatePage({ code: '999999', found: false });
  assert.match(html, /Code not found/);
  assert.match(html, /doesn't exist/);
  assert.doesNotMatch(html, /Copy code/);
});

test('renderActivatePage: malformed code (null) shows the invalid-format message', () => {
  const html = renderActivatePage({ code: null, found: false });
  assert.match(html, /Code not found/);
  assert.match(html, /valid 6-digit activation code/);
  assert.doesNotMatch(html, /Copy code/);
});

test('renderActivatePage: escapes the code into HTML/JS contexts', () => {
  // The handler only ever passes /^[0-9]{6}$/ or null, but the renderer must not
  // trust its input — a stray quote/angle-bracket must come back escaped.
  const html = renderActivatePage({ code: `1'2<3`, found: true });
  assert.doesNotMatch(html, /writeText\('1'2<3'\)/);
  assert.match(html, /&#39;/);
  assert.match(html, /&lt;/);
});

// ---- Express handler ----------------------------------------------------
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
