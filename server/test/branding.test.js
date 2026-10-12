'use strict';

// Issue #15: instance-level default branding. Tests the resolver order
// (workspace row -> custom-domain -> platform default -> hardcoded) and the
// platform-admin GET/PUT /api/admin/branding endpoints.
//
// In-process against the real MySQL test database (beamos_test via npm test): the
// real /api/admin router and real auth. Users, org, workspaces and white_labels rows
// are test-owned under a per-run prefix. The single platform-default row (fixed id) is
// platform-wide: its prior state is captured first and put back exactly afterwards.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { db, initDb } = require('../db/database');
const { generateToken } = require('../middleware/auth');
const { resolveBranding, HARDCODED_BRANDING, PLATFORM_DEFAULT_ID } = require('../lib/branding');
const { startInProcessApp } = require('./helpers/inprocess-app');

const P = 'BR-' + crypto.randomBytes(4).toString('hex');
const id = (s) => `${P}-${s}`;
// The hardcoded fallback brand (lib/branding.js) - 'BeamOS' since the rebrand.
const HARDCODED_NAME = HARDCODED_BRANDING.brand_name;

let app, base, savedPlatformDefault;
const tokens = {};

test.before(async () => {
  await initDb();
  app = await startInProcessApp({ only: ['/api/admin'] });
  base = app.base;
  savedPlatformDefault = (await db.prepare('SELECT * FROM white_labels WHERE id = ?').get(PLATFORM_DEFAULT_ID)) || null;

  await db.prepare("INSERT INTO users (id, email, role, password_hash) VALUES (?, ?, 'platform_admin', 'x')").run(id('u-admin'), `${id('admin').toLowerCase()}@test.local`);
  await db.prepare("INSERT INTO users (id, email, role, password_hash) VALUES (?, ?, 'user', 'x')").run(id('u-reg'), `${id('reg').toLowerCase()}@test.local`);
  await db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run(id('org'), `${P} Org`, id('u-admin'));
  await db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?), (?, ?, ?)')
    .run(id('ws1'), id('org'), 'WS One', id('ws-dom'), id('org'), 'WS Dom');
  tokens.admin = generateToken({ id: id('u-admin'), email: `${id('admin').toLowerCase()}@test.local`, role: 'platform_admin' }, null);
  tokens.reg = generateToken({ id: id('u-reg'), email: `${id('reg').toLowerCase()}@test.local`, role: 'user' }, null);
});

// Restore the platform-default row exactly (or remove it if there was none), then
// remove only this file's rows: its white_labels, its org (cascading its workspaces),
// its users. Audit rows are kept (hash chain).
test.after(async () => {
  try {
    if (app) {
      await db.prepare('DELETE FROM white_labels WHERE id = ?').run(PLATFORM_DEFAULT_ID);
      if (savedPlatformDefault) {
        const cols = Object.keys(savedPlatformDefault);
        await db.prepare(`INSERT INTO white_labels (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
          .run(...cols.map((c) => savedPlatformDefault[c]));
      }
      await db.prepare('DELETE FROM white_labels WHERE id LIKE ?').run(`${P}-%`);
      await db.prepare('DELETE FROM organizations WHERE id = ?').run(id('org'));
      await db.prepare('DELETE FROM users WHERE id LIKE ?').run(`${P}-%`);
    }
  } finally {
    if (app) await app.stop(); else await db.close();
  }
});

// This file's rows + the platform-default row (restored in test.after).
const clearRows = async () => {
  await db.prepare('DELETE FROM white_labels WHERE id LIKE ? OR id = ?').run(`${P}-%`, PLATFORM_DEFAULT_ID);
};
const wl = (rowId, fields) => db.prepare(
  'INSERT INTO white_labels (id, user_id, brand_name, custom_domain, workspace_id) VALUES (?, ?, ?, ?, ?)'
).run(rowId, id('u-admin'), fields.brand_name, fields.custom_domain || null, fields.workspace_id || null);

test('resolver order: workspace row > domain > platform default > hardcoded', async () => {
  await clearRows();
  await wl(id('w1'), { brand_name: 'WS One', workspace_id: id('ws1') });
  // a custom-domain row belongs to a workspace (realistic); also seed a legacy
  // null-workspace row to prove the fixed-id sentinel ignores it.
  await wl(id('dom'), { brand_name: 'Domain Brand', custom_domain: `${P.toLowerCase()}.cust.example`, workspace_id: id('ws-dom') });
  await wl(id('legacy'), { brand_name: 'Legacy Null WS', workspace_id: null });
  await wl(PLATFORM_DEFAULT_ID, { brand_name: 'Global Default', workspace_id: null }); // fixed-id platform default

  assert.equal((await resolveBranding(db, { workspaceId: id('ws1') })).brand_name, 'WS One', 'workspace row wins');
  assert.equal((await resolveBranding(db, { domain: `${P.toLowerCase()}.cust.example` })).brand_name, 'Domain Brand', 'domain match');
  assert.equal((await resolveBranding(db, { workspaceId: id('ws-none') })).brand_name, 'Global Default', 'unbranded workspace inherits platform default (not the legacy null-ws row)');
  assert.equal((await resolveBranding(db, {})).brand_name, 'Global Default', 'no context -> platform default');

  await db.prepare('DELETE FROM white_labels WHERE id = ?').run(PLATFORM_DEFAULT_ID);
  assert.equal((await resolveBranding(db, {})).brand_name, HARDCODED_NAME, 'no platform default -> hardcoded (legacy null-ws row not used)');
});

test('GET /api/admin/branding returns hardcoded default when none set', async () => {
  await clearRows();
  const res = await fetch(base + '/api/admin/branding', { headers: { Authorization: `Bearer ${tokens.admin}` } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).brand_name, HARDCODED_NAME);
});

test('PUT /api/admin/branding creates then updates the single platform-default row', async () => {
  const put = (body) => fetch(base + '/api/admin/branding', {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens.admin}` }, body: JSON.stringify(body),
  });
  let res = await put({ brand_name: 'Acme Signage', primary_color: '#10b981', hide_branding: true });
  assert.equal(res.status, 200);
  // exactly one platform-default row, with workspace_id NULL
  let rows = await db.prepare('SELECT * FROM white_labels WHERE id = ?').all(PLATFORM_DEFAULT_ID);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].brand_name, 'Acme Signage');
  assert.equal(rows[0].primary_color, '#10b981');
  assert.equal(rows[0].hide_branding, 1);
  assert.equal(rows[0].workspace_id, null);

  // second PUT updates the same row (no second row)
  res = await put({ brand_name: 'Acme Displays' });
  assert.equal(res.status, 200);
  rows = await db.prepare('SELECT * FROM white_labels WHERE id = ?').all(PLATFORM_DEFAULT_ID);
  assert.equal(rows.length, 1, 'still a single platform-default row');
  assert.equal(rows[0].brand_name, 'Acme Displays');

  // and now an unbranded workspace resolves to it
  assert.equal((await resolveBranding(db, { workspaceId: id('whatever') })).brand_name, 'Acme Displays');
});

test('branding endpoints are platform-admin only (403 for a regular user)', async () => {
  const get = await fetch(base + '/api/admin/branding', { headers: { Authorization: `Bearer ${tokens.reg}` } });
  assert.equal(get.status, 403);
  const put = await fetch(base + '/api/admin/branding', {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens.reg}` }, body: JSON.stringify({ brand_name: 'Hacker' }),
  });
  assert.equal(put.status, 403);
});
