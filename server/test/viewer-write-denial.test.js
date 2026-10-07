'use strict';

// PMI security fix (found in the Ref 49/67 Step 1 investigation): read-only
// callers must not be able to write. A read-only caller is a workspace_viewer, or
// a "synthetic" viewer that lib/tenancy.accessContext resolves to
// { workspaceRole: 'workspace_viewer', actingAs: false } - an org-wide
// field_technician, or (Refs 49/67) a regional_viewer whose region scope covers
// the workspace. All three roles are swept below.
//
//   A. Targeted: POST /api/status/import, POST /api/provision/pair, the PiP routes
//      (POST /api/pip, POST /api/pip/clear, DELETE /api/pip) and
//      POST /api/layouts/:id/duplicate - all were missing the standard
//      `!actingAs && workspaceRole === 'workspace_viewer'` gate. Denied requests
//      change no rows, leave the import temp dir alone and send nothing to a
//      device; an editor still imports / pairs / shows PiP / duplicates as before.
//   B. Sweep: EVERY mounted non-GET route, enumerated by walking the real Express
//      router stacks of every router server.js mounts (config/api-surface.js plus
//      server.js's own app.use(... require('./routes/...')) mounts) and server.js's
//      inline app.post/put/patch/delete routes. Each is sent as a workspace_viewer
//      and as a field_technician, with path params filled with REAL ids from their
//      own workspace, and must answer 403 - or be on ALLOWLIST / DENIED_WITH (each
//      with a reason). A new write route that is on neither fails the test until
//      it is gated or classified.
//   C. Socket.IO: write-type dashboard events are refused for all three roles and the
//      device receives nothing; the read event (request-screenshot) behaves as today.
//
// Runs against the REAL server.js, spawned on its own port (same pattern as
// device-pairing-notify.test.js), because /api/provision/pair is an inline
// server.js route that no in-process harness mounts. Real MySQL; every fixture is
// disposable and deleted in after(). server.js rate-limits per (client IP + path);
// the server trusts CF-Connecting-IP from a loopback peer, so each request carries
// a fresh one and the sweep never meets a shared 429 counter.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const ioClient = require('socket.io-client');

const { db, initDb } = require('../db/database');
const { randTag, cleanupUsers, cleanupDevices } = require('./helpers/disposable');

const SERVER_DIR = path.join(__dirname, '..');
const PORT = 39100 + crypto.randomInt(0, 800);
const BASE = `http://127.0.0.1:${PORT}`;
const TAG = randTag();
const DATA_DIR = path.join(os.tmpdir(), `st-vwd-${TAG}`);
const LOG = path.join(os.tmpdir(), `st-vwd-${TAG}.log`);
const PASSWORD = 'viewer-write-denial-1';
const READ_ONLY = { error: 'Read-only access' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fakeIp = () => `10.${crypto.randomInt(1, 255)}.${crypto.randomInt(1, 255)}.${crypto.randomInt(1, 255)}`;

let proc;
const cleanupUserIds = [];
const cleanupDeviceIds = [];
const sockets = [];

async function req(method, urlPath, { token, body, form } = {}) {
  const headers = { 'CF-Connecting-IP': fakeIp() };
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${urlPath}`, { method, headers, body: payload });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

async function ok(method, urlPath, opts, expect = [200, 201]) {
  const r = await req(method, urlPath, opts);
  assert.ok([].concat(expect).includes(r.status), `${method} ${urlPath} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

// ---------------------------------------------------------------- route list

// Every non-GET route server.js mounts, by walking the real router stacks.
function enumerateWriteRoutes() {
  const src = fs.readFileSync(path.join(SERVER_DIR, 'server.js'), 'utf8');
  const { PUBLIC_ROUTERS, JWT_ONLY_ROUTERS, AGENCY_ROUTERS } = require('../config/api-surface');
  const mounts = [...PUBLIC_ROUTERS, ...JWT_ONLY_ROUTERS, ...AGENCY_ROUTERS].map((r) => [r.path, r.mod, null]);
  const idents = {};
  for (const m of src.matchAll(/const (\w+) = require\("(\.\/routes\/[\w-]+)"\)/g)) idents[m[1]] = m[2];
  for (const m of src.matchAll(/app\.use\(\s*"([^"]+)"((?:[^;](?!app\.use))*?)\);/gs)) {
    const tail = m[2].trim();
    const rq = /require\("(\.\/routes\/[\w-]+)"\)(?:\.(\w+))?\s*,?\s*$/.exec(tail);
    if (rq) { mounts.push([m[1], rq[1], rq[2] || null]); continue; }
    const id = /(\w+)\s*,?\s*$/.exec(tail);
    if (id && idents[id[1]]) mounts.push([m[1], idents[id[1]], null]);
  }
  for (const m of src.matchAll(/app\.use\(require\("(\.\/routes\/[\w-]+)"\)\)/g)) mounts.push(['', m[1], null]);

  const routes = [];
  const seen = new Set();
  const add = (method, p, origin) => {
    const key = `${method} ${p}`;
    if (seen.has(key)) return;
    seen.add(key);
    routes.push({ method, path: p, key, origin });
  };
  for (const [base, mod, prop] of mounts) {
    let router = require(path.join(SERVER_DIR, mod));
    if (prop) router = router[prop];
    for (const layer of router.stack) {
      if (!layer.route) continue;
      for (const p of [].concat(layer.route.path)) {
        for (const m of Object.keys(layer.route.methods)) {
          if (m === 'get' || m === 'head') continue;
          add(m === '_all' ? 'ALL' : m.toUpperCase(), `${base}${p}`.replace(/(.)\/$/, '$1'), mod);
        }
      }
    }
  }
  for (const m of src.matchAll(/^\s*app\.(post|put|patch|delete)\(\s*"([^"]+)"/gm)) add(m[1].toUpperCase(), m[2], 'server.js (inline)');
  return { routes, mountCount: mounts.length };
}

// Routes that may legitimately answer something other than 403 to a read-only
// session. Key: "METHOD /path" exactly as enumerated. roles: which of the two
// swept roles the exemption applies to (default both). These are NOT sent.
const ALLOWLIST = {
  // auth flows (no session involved, or establishing one)
  'POST /api/auth/register': 'auth flow: creates a new account, not a workspace write',
  'POST /api/auth/login': 'auth flow',
  'POST /api/auth/google': 'auth flow',
  'POST /api/auth/microsoft': 'auth flow',
  'POST /api/auth/totp/verify': 'auth flow (second factor)',
  'POST /api/field-auth/send-otp': 'auth flow (field-tech OTP)',
  'POST /api/field-auth/verify-otp': 'auth flow (field-tech OTP)',
  // self-service on the caller's own account / session
  'POST /api/auth/switch-workspace': 'self-service: re-mints the own session for a workspace the caller can already read',
  'PUT /api/auth/me': 'self-service: own profile / password / notification prefs / phone',
  'POST /api/auth/totp/setup': 'self-service: own TOTP',
  'POST /api/auth/totp/enable': 'self-service: own TOTP',
  'POST /api/auth/totp/disable': 'self-service: own TOTP',
  'POST /api/auth/totp/recovery-codes/regenerate': 'self-service: own TOTP recovery codes',
  'POST /api/auth/accept-invite/:inviteId': 'self-service: accepts an invite addressed to the caller\'s own email',
  'DELETE /api/tokens/:id': 'self-service: revokes one of the caller\'s own API tokens (minting is gated)',
  'PUT /api/tokens/:id/targets': 'self-service: the caller\'s own agency token (WHERE user_id = caller); minting one is gated',
  // read-only POSTs (a body carries the query; nothing is written)
  'POST /api/reports/custom/preview': 'read-only: custom report query preview',
  'POST /api/reports/custom/export': 'read-only: custom report file export (exports are allowed to readers)',
  'POST /api/widgets/preview': 'read-only: renders widget HTML from the body, writes nothing',
  // device-side, public or non-session surfaces
  'POST /api/provisioning/registration-codes/claim': 'device-facing activation-code claim (no user session)',
  'POST /api/player-debug': 'device/player-facing debug-log ingestion (no user session)',
  'POST /api/contact/enterprise': 'public contact form',
  'POST /api/stripe/webhook': 'Stripe webhook (signature-authenticated, no user session)',
  'POST /api/subscription/webhook/stripe': 'Stripe webhook (no user session)',
  'POST /scim/v2/Users': 'SCIM: own bearer secret, rejects user sessions (401)',
  'PATCH /scim/v2/Users/:id': 'SCIM: own bearer secret, rejects user sessions (401)',
  'PUT /scim/v2/Users/:id': 'SCIM: own bearer secret, rejects user sessions (401)',
  'DELETE /scim/v2/Users/:id': 'SCIM: own bearer secret, rejects user sessions (401)',
  'ALL /scim/v2/Groups': 'SCIM: own bearer secret, rejects user sessions (401)',
  'ALL /scim/v2/Groups/*': 'SCIM: own bearer secret, rejects user sessions (401)',
  'ALL /scim/v2/Bulk': 'SCIM: own bearer secret, rejects user sessions (401)',
  'ALL /scim/v2/Me': 'SCIM: own bearer secret, rejects user sessions (401)',
  // removed / disabled endpoints that write nothing for anyone
  'POST /api/provision': 'removed endpoint: always 410 Gone (#90)',
  'ALL /api/teams*': 'disabled feature: always 503 (teams redesign)',
  // field-visit logging: field_technician ONLY (the viewer is still swept)
  'POST /api/workspaces/:id/field-visits': { roles: ['field_technician'], reason: 'field-visit logging (canLogFieldVisit, Ref 43)' },
  'PATCH /api/workspaces/:id/field-visits/:visitId': { roles: ['field_technician'], reason: 'field-visit logging (canLogFieldVisit, Ref 43)' },
  'POST /api/workspaces/:id/field-visits/:visitId/photos': { roles: ['field_technician'], reason: 'field-visit photo upload (canLogFieldVisit, Ref 43)' },
};

// Allowlisted, but still SENT: routes whose write gate exists and answers with a
// status other than 403 for a read-only caller. Accepted only with exactly the
// status listed (the swept id is a real row in W, so the 404 is the gate itself,
// not a missing fixture), and still inside the no-state-change snapshot.
const DENIED_WITH = {
  'PUT /api/folders/:id': [404, 'accessibleFolder(..., requireWrite) returns null for a read-only caller -> "Folder not found"'],
  'DELETE /api/folders/:id': [404, 'accessibleFolder(..., requireWrite) returns null for a read-only caller -> "Folder not found"'],
};

function allowFor(key, role) {
  const a = ALLOWLIST[key];
  if (!a) return null;
  if (typeof a === 'string') return a;
  return a.roles.includes(role) ? a.reason : null;
}

// ---------------------------------------------------------------- fixtures

let owner, editor, viewer, tech, regional;
let W, O; // the workspace / org every swept role reads
const F = {}; // real resource ids in W

async function register(prefix, createOrg) {
  const email = `${prefix}-${randTag()}@vwd.local`;
  const r = await ok('POST', '/api/auth/register', { body: { email, password: PASSWORD, name: prefix, createOrg } });
  cleanupUserIds.push(r.user.id);
  return { id: r.user.id, email, token: r.token, workspaceId: r.current_workspace_id };
}

// A session JWT bound to W (switch-workspace re-validates access server-side).
async function sessionIn(user, wsId) {
  const r = await ok('POST', '/api/auth/switch-workspace', { token: user.token, body: { workspace_id: wsId } });
  user.token = r.token;
  return user;
}

// A device that registered itself with a pairing code (status provisioning,
// workspace NULL) - the shape POST /api/provision/pair claims.
function provisionDevice(code) {
  return new Promise((resolve, reject) => {
    const sock = ioClient(`${BASE}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
    const t = setTimeout(() => { sock.close(); reject(new Error('device:registered timeout')); }, 8000);
    sock.on('connect', () => sock.emit('device:register', { pairing_code: code }));
    sock.on('device:registered', (d) => {
      clearTimeout(t);
      sock.close();
      cleanupDeviceIds.push(d.device_id);
      resolve({ id: d.device_id, token: d.device_token });
    });
  });
}

async function buildFixtures() {
  owner = await register('vwdowner', true);
  editor = await register('vwdeditor', false);
  viewer = await register('vwdviewer', false);
  tech = await register('vwdtech', false);
  regional = await register('vwdregional', false);
  W = owner.workspaceId;
  O = (await db.prepare('SELECT organization_id FROM workspaces WHERE id = ?').get(W)).organization_id;
  await db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)').run(W, editor.id, 'workspace_editor');
  await db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)').run(W, viewer.id, 'workspace_viewer');
  await db.prepare('INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, ?)').run(O, tech.id, 'field_technician');
  for (const u of [owner, editor, viewer, tech]) await sessionIn(u, W);

  const T = owner.token;
  for (const k of ['device', 'device2']) {
    F[k] = crypto.randomUUID();
    await db.prepare("INSERT INTO devices (id, user_id, workspace_id, name, status, created_at) VALUES (?, ?, ?, ?, 'offline', UNIX_TIMESTAMP())")
      .run(F[k], owner.id, W, `vwd-${k}-${TAG}`);
  }
  F.content = (await ok('POST', '/api/content/remote', { token: T, body: { url: 'https://example.com/vwd.png', name: `vwd-${TAG}`, mime_type: 'image/png' } })).id;
  F.folder = (await ok('POST', '/api/folders', { token: T, body: { name: `vwd-${TAG}` } })).id;
  F.assignment = (await ok('POST', `/api/assignments/device/${F.device}`, { token: T, body: { content_id: F.content } })).id;
  F.layout = (await ok('POST', '/api/layouts', { token: T, body: { name: `vwd-${TAG}`, width: 1920, height: 1080 } })).id;
  F.zone = (await ok('POST', `/api/layouts/${F.layout}/zones`, { token: T, body: { name: 'z', x_percent: 0, y_percent: 0, width_percent: 50, height_percent: 50 } })).id;
  F.widget = (await ok('POST', '/api/widgets', { token: T, body: { widget_type: 'clock', name: `vwd-${TAG}`, config: {} } })).id;
  F.playlist = (await ok('POST', '/api/playlists', { token: T, body: { name: `vwd-${TAG}` } })).id;
  const item = await ok('POST', `/api/playlists/${F.playlist}/items`, { token: T, body: { content_id: F.content } });
  F.item = item.id || item.item?.id || (await db.prepare('SELECT id FROM playlist_items WHERE playlist_id = ? ORDER BY id DESC LIMIT 1').get(F.playlist)).id;
  F.schedule = (await ok('POST', '/api/schedules', { token: T, body: { device_id: F.device, content_id: F.content, title: 'vwd', start_time: '2030-01-01T00:00:00Z', end_time: '2030-01-01T01:00:00Z' } })).id;
  F.wall = (await ok('POST', '/api/walls', { token: T, body: { name: `vwd-${TAG}`, grid_cols: 2, grid_rows: 1 } })).id;
  F.group = (await ok('POST', '/api/groups', { token: T, body: { name: `vwd-${TAG}` } })).id;
  await ok('POST', `/api/groups/${F.group}/devices`, { token: T, body: { device_id: F.device } });
  F.kiosk = (await ok('POST', '/api/kiosk', { token: T, body: { name: `vwd-${TAG}` } })).id;
  F.ticket = (await ok('POST', `/api/workspaces/${W}/tickets`, { token: T, body: { title: `vwd-${TAG}` } })).id;
  F.campaign = (await ok('POST', `/api/workspaces/${W}/campaigns`, { token: T, body: { name: `vwd-${TAG}`, start_date: '2030-01-01', end_date: '2030-01-31' } })).id;
  F.visit = (await ok('POST', `/api/workspaces/${W}/field-visits`, { token: T, body: { device_id: F.device, visit_type: 'Routine check' } })).id;
  F.region = (await ok('POST', `/api/organizations/${O}/regions`, { token: T, body: { name: `vwd-${TAG}` } })).id;
  // Refs 49/67: W sits in F.region, and the regional_viewer is scoped to it.
  await ok('PATCH', `/api/workspaces/${W}/region`, { token: T, body: { region_id: F.region } });
  await ok('POST', `/api/organizations/${O}/members`, { token: T, body: { email: regional.email, role: 'regional_viewer' } });
  await ok('PUT', `/api/organizations/${O}/members/${regional.id}/region-scopes`, { token: T, body: { region_ids: [F.region] } });
  await sessionIn(regional, W);
  F.mapping = (await ok('POST', `/api/organizations/${O}/entra-role-mappings`, { token: T, body: { claim_value: `vwd.${TAG}`, role: 'org_admin' } })).id;
  F.sim = (await ok('POST', '/api/sim-inventory', { token: T, body: { iccid: `8991${crypto.randomInt(1e9, 1e10)}` } })).id;
  F.code = (await ok('POST', '/api/provisioning/registration-codes', { token: T, body: { workspace_id: W } })).id;
  F.invite = (await ok('POST', `/api/workspaces/${W}/invites`, { token: T, body: { email: `vwd-invitee-${TAG}@vwd.local`, role: 'workspace_viewer' } })).id;
  for (const [k, v] of Object.entries(F)) assert.ok(v, `fixture ${k} has an id`);
}

// Fill each :param with a real id from W (or a real related id), so a 404 can
// never stand in for a missing permission check.
function fillPath(route) {
  const p = route.path;
  const byRouterId = [
    ['/api/devices/', F.device], ['/api/content/', F.content], ['/api/folders/', F.folder],
    ['/api/assignments/', F.assignment], ['/api/layouts/', F.layout], ['/api/widgets/', F.widget],
    ['/api/schedules/', F.schedule], ['/api/walls/', F.wall], ['/api/groups/', F.group],
    ['/api/playlists/', F.playlist], ['/api/kiosk/', F.kiosk], ['/api/sim-inventory/', F.sim],
    ['/api/provisioning/registration-codes/', F.code], ['/api/workspaces/', W],
    ['/api/organizations/:id', O], ['/api/admin/orgs/', O], ['/api/admin/workspaces/', W],
    ['/api/admin/users/', viewer.id], ['/api/auth/users/', editor.id], ['/api/subscription/plans/', 'enterprise'],
    ['/api/admin/entra-service-principals/', '1'], ['/api/admin/scim-tokens/', '1'],
    ['/api/organizations/:orgId/regions/', F.region], ['/api/organizations/:orgId/entra-role-mappings/', F.mapping],
  ];
  let idVal = null;
  for (const [prefix, val] of byRouterId) if (p.startsWith(prefix)) idVal = val;
  const named = {
    deviceId: F.device, targetDeviceId: F.device2, zoneId: F.zone, itemId: F.item, inviteId: F.invite,
    userId: editor.id, ticketId: F.ticket, campaignId: F.campaign, visitId: F.visit, orgId: O,
    workspaceId: W, playlistId: F.playlist,
  };
  return p.replace(/:(\w+)/g, (_, name) => {
    const v = name === 'id' ? idVal : named[name];
    if (!v) throw new Error(`no real fixture id for :${name} in ${route.key}`);
    return encodeURIComponent(v);
  });
}

// A minimal but plausible body: valid enough that a route that validates BEFORE it
// checks permissions can't hide a missing gate behind a 400.
function bodyFor(route) {
  const k = route.key;
  if (k.startsWith('POST /api/pip')) return { device_id: F.device, type: 'image', uri: 'https://example.com/x.png' };
  if (k === 'DELETE /api/pip') return { device_id: F.device };
  if (k.includes('/command')) return { type: 'screen_on' };
  if (k.includes('/assign-content') || k.includes('/assignments/device/')) return { content_id: F.content };
  if (k.includes('/assign-playlist') || k.includes('/assign')) return { playlist_id: F.playlist, device_ids: [F.device] };
  if (k.endsWith('/items')) return { content_id: F.content };
  if (k.includes('/groups/:id/devices')) return { device_id: F.device2 };
  if (k === 'POST /api/schedules') return { device_id: F.device, content_id: F.content, title: 'swept', start_time: '2031-01-01T00:00:00Z', end_time: '2031-01-01T01:00:00Z' };
  if (k === 'POST /api/provisioning/registration-codes') return { workspace_id: W };
  if (k === 'POST /api/admin/users') return { email: `vwd-x-${TAG}@vwd.local`, name: 'x', password: 'long-enough-pass-1', workspaceId: W, role: 'workspace_viewer' };
  if (k === 'POST /api/provision/pair') return { pairing_code: '123456' };
  return { name: `vwd-swept-${TAG}`, title: 'swept', role: 'workspace_admin', email: `vwd-x-${TAG}@vwd.local` };
}

// ------------------------------------------------- state snapshot (no change)

// Every row the swept requests could touch: all tables with a workspace_id
// column (rows of W), all with an organization_id column (rows of O), plus the
// child / user tables keyed elsewhere. Logs and telemetry are excluded (the
// server's own heartbeat / audit writers touch them), as are devices' liveness
// columns.
const VOLATILE_TABLE = /(log|logs|telemetry|history|events|usage|_daily|escalations|screenshots|activity|chain)$/;
const VOLATILE_COL = /^(status|last_seen|last_heartbeat|updated_at|ip_address)$/;
async function snapshot() {
  const cols = await db.prepare(
    `SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME IN ('workspace_id', 'organization_id')`,
  ).all();
  const queries = [];
  for (const { t, c } of cols) {
    if (VOLATILE_TABLE.test(t)) continue;
    queries.push([t, `SELECT * FROM \`${t}\` WHERE \`${c}\` = ?`, [c === 'workspace_id' ? W : O]]);
  }
  const users = [owner.id, editor.id, viewer.id, tech.id, regional.id];
  const ph = users.map(() => '?').join(',');
  queries.push(
    ['users', `SELECT * FROM users WHERE id IN (${ph})`, users],
    ['api_tokens', `SELECT * FROM api_tokens WHERE user_id IN (${ph})`, users],
    ['playlist_items', 'SELECT * FROM playlist_items WHERE playlist_id = ?', [F.playlist]],
    ['layout_zones', 'SELECT * FROM layout_zones WHERE layout_id = ?', [F.layout]],
    ['assignments', 'SELECT * FROM assignments WHERE device_id IN (?, ?)', [F.device, F.device2]],
    ['device_group_members', 'SELECT * FROM device_group_members WHERE group_id = ?', [F.group]],
    ['video_wall_devices', 'SELECT * FROM video_wall_devices WHERE wall_id = ?', [F.wall]],
  );
  const out = {};
  for (const [name, sql, params] of queries) {
    const rows = (await db.prepare(sql).all(...params)).map((r) => {
      const o = {};
      for (const key of Object.keys(r).sort()) if (!VOLATILE_COL.test(key)) o[key] = r[key];
      return JSON.stringify(o);
    }).sort();
    out[name] = crypto.createHash('sha256').update(rows.join('\n')).digest('hex').slice(0, 16) + `:${rows.length}`;
  }
  return out;
}

const importTempEntries = () => {
  const tmp = os.tmpdir();
  const top = fs.readdirSync(tmp).filter((n) => n.startsWith('screentinker-import')).sort();
  const inner = fs.existsSync(path.join(tmp, 'screentinker-import')) ? fs.readdirSync(path.join(tmp, 'screentinker-import')).sort() : [];
  return { top, inner };
};
const countIn = async (table) => (await db.prepare(`SELECT COUNT(*) AS n FROM \`${table}\` WHERE workspace_id = ?`).get(W)).n;
const IMPORT_TABLES = ['devices', 'content', 'widgets', 'playlists', 'layouts'];
const importCounts = async () => Object.fromEntries(await Promise.all(IMPORT_TABLES.map(async (t) => [t, await countIn(t)])));

// -------------------------------------------------------------- lifecycle

test.before(async () => {
  await initDb();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const logFd = fs.openSync(LOG, 'w');
  proc = spawn(process.execPath, ['server.js'], {
    cwd: SERVER_DIR,
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 160 && !up; i++) {
    try { up = (await fetch(`${BASE}/api/status`)).ok; } catch { /* booting */ }
    if (!up) await sleep(250);
  }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-3000));
  await buildFixtures();
});

test.after(async () => {
  for (const s of sockets) { try { s.close(); } catch { /* */ } }
  try { proc.kill('SIGKILL'); } catch { /* */ }
  // Members first (the owner's org can only be deleted once it has no other members).
  const [ownerId, ...rest] = cleanupUserIds;
  await cleanupUsers(db, [...rest.reverse(), ownerId]);
  await cleanupDevices(db, cleanupDeviceIds);
  await db.close();
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* */ }
  try { fs.rmSync(LOG, { force: true }); } catch { /* */ }
});

// =============================================================== A. targeted

test('import: workspace_viewer, field_technician and regional_viewer -> 403 (JSON and multipart); no rows, no temp files', async () => {
  const before = await importCounts();
  const tmpBefore = importTempEntries();
  const data = { format: 'screentinker-export-v2', widgets: [{ id: 'w1', widget_type: 'clock', name: `vwd-imp-${TAG}`, config: {} }] };
  for (const u of [viewer, tech, regional]) {
    const r = await req('POST', '/api/status/import', { token: u.token, body: data });
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.deepEqual(r.body, READ_ONLY);
    const form = new FormData();
    form.append('file', new Blob([crypto.randomBytes(4096)], { type: 'application/zip' }), 'export.zip');
    const m = await req('POST', '/api/status/import', { token: u.token, form });
    assert.equal(m.status, 403, JSON.stringify(m.body));
    assert.deepEqual(m.body, READ_ONLY);
  }
  assert.deepEqual(await importCounts(), before, 'no devices/content/widgets/playlists/layouts written');
  assert.deepEqual(importTempEntries(), tmpBefore, 'nothing stored in the import temp dir');
});

test('import: an editor still imports as before (rows created)', async () => {
  const before = await importCounts();
  const data = {
    format: 'screentinker-export-v2',
    devices: [{ id: 'd1', name: `vwd-imp-dev-${TAG}` }],
    widgets: [{ id: 'w1', widget_type: 'clock', name: `vwd-imp-w-${TAG}`, config: {} }],
    layouts: [{ id: 'l1', name: `vwd-imp-l-${TAG}`, width: 1920, height: 1080, zones: [] }],
    playlists: [{ id: 'p1', name: `vwd-imp-p-${TAG}`, items: [] }],
  };
  const r = await req('POST', '/api/status/import', { token: editor.token, body: data });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const after = await importCounts();
  assert.equal(after.devices, before.devices + 1);
  assert.equal(after.widgets, before.widgets + 1);
  assert.equal(after.layouts, before.layouts + 1);
  assert.equal(after.playlists, before.playlists + 1);
});

test('pair: workspace_viewer, field_technician and regional_viewer -> 403; the code stays unclaimed, the device row unchanged', async () => {
  const code = String(crypto.randomInt(100000, 1000000));
  const dev = await provisionDevice(code);
  const rowBefore = await db.prepare('SELECT * FROM devices WHERE id = ?').get(dev.id);
  assert.equal(rowBefore.pairing_code, code);
  assert.equal(rowBefore.workspace_id, null);
  const devicesInW = await countIn('devices');
  for (const u of [viewer, tech, regional]) {
    const r = await req('POST', '/api/provision/pair', { token: u.token, body: { pairing_code: code, name: 'nope' } });
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.deepEqual(r.body, READ_ONLY);
  }
  assert.deepEqual(await db.prepare('SELECT * FROM devices WHERE id = ?').get(dev.id), rowBefore, 'device row byte-for-byte unchanged');
  assert.equal(await countIn('devices'), devicesInW, 'no device created or moved into W');

  // The same code, by an editor: paired as before.
  const ok200 = await req('POST', '/api/provision/pair', { token: editor.token, body: { pairing_code: code, name: `vwd-paired-${TAG}` } });
  assert.equal(ok200.status, 200, JSON.stringify(ok200.body));
  const rowAfter = await db.prepare('SELECT * FROM devices WHERE id = ?').get(dev.id);
  assert.equal(rowAfter.pairing_code, null);
  assert.equal(rowAfter.workspace_id, W);
  assert.equal(rowAfter.user_id, editor.id);
  F.pairedDevice = dev; // reused by the socket tests (a real device that can connect)
});

test('layout duplicate: workspace_viewer, field_technician and regional_viewer -> 403, no layout/zone rows; an editor still duplicates (own layout and a template)', async () => {
  const counts = async () => ({
    layouts: await countIn('layouts'),
    zones: (await db.prepare('SELECT COUNT(*) AS n FROM layout_zones z JOIN layouts l ON l.id = z.layout_id WHERE l.workspace_id = ?').get(W)).n,
  });
  // "Use template" in the layout editor duplicates a platform template into the
  // caller's workspace - the main real use of this route.
  const tpl = await db
    .prepare('SELECT l.id, (SELECT COUNT(*) FROM layout_zones z WHERE z.layout_id = l.id) AS zones FROM layouts l WHERE l.is_template = 1 ORDER BY zones DESC, l.id LIMIT 1')
    .get();
  assert.ok(tpl, 'a platform template layout exists');
  const ownZones = (await db.prepare('SELECT COUNT(*) AS n FROM layout_zones WHERE layout_id = ?').get(F.layout)).n;

  const before = await counts();
  for (const u of [viewer, tech, regional]) {
    for (const src of [F.layout, tpl.id]) {
      const r = await req('POST', `/api/layouts/${encodeURIComponent(src)}/duplicate`, { token: u.token, body: {} });
      assert.equal(r.status, 403, `${src}: ${JSON.stringify(r.body)}`);
      assert.deepEqual(r.body, READ_ONLY);
    }
  }
  assert.deepEqual(await counts(), before, 'no layout or zone rows created');

  const own = await req('POST', `/api/layouts/${F.layout}/duplicate`, { token: editor.token, body: {} });
  assert.equal(own.status, 201, JSON.stringify(own.body));
  const fromTpl = await req('POST', `/api/layouts/${encodeURIComponent(tpl.id)}/duplicate`, { token: editor.token, body: {} });
  assert.equal(fromTpl.status, 201, JSON.stringify(fromTpl.body));
  assert.equal((await db.prepare('SELECT workspace_id FROM layouts WHERE id = ?').get(fromTpl.body.id)).workspace_id, W);
  assert.deepEqual(await counts(), { layouts: before.layouts + 2, zones: before.zones + ownZones + tpl.zones });
});

// =================================================================== B. sweep

const sweepResults = [];
test('sweep: every mounted non-GET route is 403 for workspace_viewer, field_technician and regional_viewer (or classified)', async () => {
  const { routes, mountCount } = enumerateWriteRoutes();
  console.log(`[sweep] ${routes.length} non-GET routes across ${mountCount} router mounts + server.js inline routes`);
  assert.ok(routes.length >= 150, `enumerated ${routes.length}`);
  for (const key of [...Object.keys(ALLOWLIST), ...Object.keys(DENIED_WITH)]) {
    assert.ok(routes.some((r) => r.key === key), `classified route "${key}" no longer exists - update the lists`);
  }
  const ROLES = [['workspace_viewer', viewer], ['field_technician', tech], ['regional_viewer', regional]];
  const send = (route, user) =>
    req(route.method === 'ALL' ? 'POST' : route.method, fillPath(route).replace(/\*$/, 'x'), { token: user.token, body: bodyFor(route) });

  // Every non-allowlisted route must deny; the snapshot brackets the whole sweep.
  const before = await snapshot();
  const unclassified = [];
  for (const route of routes) {
    for (const [role, user] of ROLES) {
      const reason = allowFor(route.key, role);
      if (reason) { sweepResults.push({ route: route.key, role, result: 'allowlisted', reason }); continue; }
      const r = await send(route, user);
      const alt = DENIED_WITH[route.key];
      const denied = r.status === 403 || (alt && r.status === alt[0]);
      sweepResults.push({ route: route.key, role, result: String(r.status), reason: alt && r.status === alt[0] ? `denied: ${alt[1]}` : undefined });
      if (!denied) unclassified.push(`${route.key} as ${role} -> ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
    }
  }
  const after = await snapshot();

  const lines = sweepResults.map((x) => `${x.result.padEnd(22)} ${x.role.padEnd(17)} ${x.route}${x.reason ? `   # ${x.reason}` : ''}`);
  console.log(`[sweep] results (${sweepResults.length}):\n${lines.join('\n')}`);
  assert.deepEqual(unclassified, [], 'write routes that are neither 403 nor allowlisted');
  const changed = Object.keys(before).filter((t) => before[t] !== after[t]);
  console.log(`[sweep] snapshot: ${Object.keys(before).length} row sets checked, changed: [${changed.join(', ')}]`);
  assert.deepEqual(changed, [], `denied requests changed rows in: ${changed.join(', ')}`);
});

// ================================================================ C. sockets

function connectDashboard(user) {
  return new Promise((resolve, reject) => {
    const s = ioClient(`${BASE}/dashboard`, { auth: { token: user.token }, transports: ['websocket'], reconnection: false, forceNew: true });
    sockets.push(s);
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
}

function connectDevice(dev) {
  return new Promise((resolve, reject) => {
    const s = ioClient(`${BASE}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
    sockets.push(s);
    const got = [];
    for (const ev of ['device:command', 'device:remote-touch', 'device:remote-key', 'device:remote-start', 'device:remote-stop', 'device:screenshot-request', 'device:pip-show', 'device:pip-clear']) {
      s.on(ev, (payload) => got.push({ ev, payload }));
    }
    const t = setTimeout(() => reject(new Error('device reconnect timeout')), 8000);
    s.on('connect', () => s.emit('device:register', { device_id: dev.id, device_token: dev.token, device_info: { app_version: 'test' } }));
    // The server rotates the device token on every register; keep the new one.
    s.on('device:registered', (d) => { clearTimeout(t); if (d?.device_token) dev.token = d.device_token; resolve({ s, got }); });
  });
}
let deviceConn; // one live device connection shared by the socket tests

const emitAck = (s, ev, data) => new Promise((resolve) => {
  const t = setTimeout(() => resolve({ timeout: true }), 1500);
  s.emit(ev, data, (ack) => { clearTimeout(t); resolve(ack); });
});

// The write-type dashboard events in ws/dashboardSocket.js (canActOnDevice 'write').
const WRITE_EVENTS = ['dashboard:remote-touch', 'dashboard:remote-key', 'dashboard:remote-start', 'dashboard:remote-stop'];

test('socket: write events from workspace_viewer / field_technician / regional_viewer are refused; the device receives nothing', async () => {
  assert.ok(F.pairedDevice, 'the pair test provided a real device');
  const device = deviceConn = await connectDevice(F.pairedDevice);
  await sleep(300);
  device.got.length = 0;

  for (const user of [viewer, tech, regional]) {
    const dash = await connectDashboard(user);
    const ack = await emitAck(dash, 'dashboard:device-command', { device_id: F.pairedDevice.id, type: 'screen_on', payload: {} });
    assert.deepEqual(ack, { delivered: false, reason: 'forbidden' });
    for (const ev of WRITE_EVENTS) dash.emit(ev, { device_id: F.pairedDevice.id, x: 1, y: 1, action: 'down', keycode: 3 });
    await sleep(600);
    assert.deepEqual(device.got, [], `device received something from ${user.email}`);
  }

  // Positive control: an editor's write reaches the same device, so the harness can see delivery.
  const ed = await connectDashboard(editor);
  const edAck = await emitAck(ed, 'dashboard:device-command', { device_id: F.pairedDevice.id, type: 'screen_on', payload: {} });
  assert.deepEqual(edAck, { delivered: true });
  ed.emit('dashboard:remote-key', { device_id: F.pairedDevice.id, keycode: 3 });
  await sleep(600);
  assert.deepEqual(device.got.map((g) => g.ev).sort(), ['device:command', 'device:remote-key']);
});

test('socket: the read event (request-screenshot) still works for all three roles, as today', async () => {
  const device = deviceConn;
  assert.ok(device, 'the previous socket test connected the device');
  device.got.length = 0;
  for (const user of [viewer, tech, regional]) {
    const dash = await connectDashboard(user);
    dash.emit('dashboard:request-screenshot', { device_id: F.pairedDevice.id });
  }
  await sleep(800);
  assert.equal(device.got.filter((g) => g.ev === 'device:screenshot-request').length, 3);
  assert.equal(device.got.length, 3, 'and nothing else');
});

test('PiP: workspace_viewer, field_technician and regional_viewer -> 403 and the device receives nothing; an editor\'s PiP reaches it', async () => {
  const device = deviceConn;
  assert.ok(device, 'the socket tests connected the device');
  device.got.length = 0;
  const target = { device_id: F.pairedDevice.id };
  const show = { ...target, type: 'image', uri: 'https://example.com/vwd-pip.png' };
  for (const u of [viewer, tech, regional]) {
    for (const [method, url, body] of [['POST', '/api/pip', show], ['POST', '/api/pip/clear', target], ['DELETE', '/api/pip', target]]) {
      const r = await req(method, url, { token: u.token, body });
      assert.equal(r.status, 403, `${method} ${url}: ${JSON.stringify(r.body)}`);
      assert.deepEqual(r.body, READ_ONLY);
    }
  }
  await sleep(600);
  assert.deepEqual(device.got, [], 'nothing was sent to the device');

  // Positive control: the editor's show + clear reach the same live device.
  const shown = await req('POST', '/api/pip', { token: editor.token, body: show });
  assert.equal(shown.status, 200, JSON.stringify(shown.body));
  assert.equal(shown.body.sent, 1);
  const cleared = await req('DELETE', '/api/pip', { token: editor.token, body: target });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  await sleep(600);
  assert.deepEqual(device.got.map((g) => g.ev), ['device:pip-show', 'device:pip-clear']);
});
