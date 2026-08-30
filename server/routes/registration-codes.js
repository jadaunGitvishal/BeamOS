'use strict';

// Ref 30: advance device registration codes.
//
// Stage 1 (`router`, default export): a workspace_admin (or org / platform admin)
// generates a short numeric code ahead of an install, optionally naming the
// device it is destined for, and lists / QRs the codes for a workspace. Targets
// a workspace by BODY / QUERY param (not the caller's active workspace), so it is
// mounted WITHOUT resolveTenancy and gates every handler with
// canAdminWorkspace(db, user, workspace) - the same pattern as routes/workspaces.js.
// Mounted JWT-only (config/api-surface.js), so a Bearer st_ API token can never
// reach it.
//
// Stage 2 (`claimRouter`): the device-facing counterpart. The installer types the
// pre-generated code ON the device (Android ProvisioningActivity / web player);
// the device POSTs it here to claim itself into the code's workspace. Device-
// facing => NO requireAuth, so server.js mounts claimRouter on its own public
// path (/api/provisioning/registration-codes/claim) BEFORE the JWT-only router,
// behind a rate limit. See the claimRouter block at the bottom of this file.

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const QRCode = require('qrcode');
const { db } = require('../db/database');
const { canAdminWorkspace } = require('../lib/permissions');
const { asyncHandler } = require('../lib/async-handler');
const { getClientIp } = require('../services/activity');
const { stripDeviceSecrets } = require('../lib/device-sanitize');
const { workspaceRoom, emitToWorkspace } = require('../lib/socket-rooms');

const NAME_MAX = 255;
const CODE_MIN = 100000;
const CODE_SPAN = 900000; // codes span 100000-999999 inclusive
const CODE_RE = /^[0-9]{6}$/;
const GEN_MAX_ATTEMPTS = 12;
// TTL: a code that is never claimed stops being claimable after this window, so
// an unused code can't sit around indefinitely as a brute-force target. 30 days
// is generous for real install logistics (order hardware, schedule an installer)
// without leaving the window open for months.
const CODE_TTL_SECONDS = 30 * 24 * 60 * 60;

// Load the workspace named by `workspaceId` and confirm the caller may administer
// it. Sends the response and returns null on any failure (caller bails on null).
// Stamps req.workspaceId so activityLogger attributes the mutation to the right
// tenant (this router has no resolveTenancy, so it would otherwise be undefined).
async function loadAdminWorkspace(req, res, workspaceId) {
  if (!workspaceId) {
    res.status(400).json({ error: 'workspace_id is required' });
    return null;
  }
  const ws = await db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId);
  if (!ws) {
    res.status(404).json({ error: 'Workspace not found' });
    return null;
  }
  if (!(await canAdminWorkspace(db, req.user, ws))) {
    res.status(403).json({ error: 'Workspace admin required' });
    return null;
  }
  req.workspaceId = ws.id;
  return ws;
}

function serializeCode(row) {
  return {
    id: row.id,
    code: row.code,
    workspace_id: row.workspace_id,
    planned_device_name: row.planned_device_name || null,
    status: row.status,
    created_by: row.created_by,
    created_at: row.created_at,
    expires_at: row.expires_at || null,
    expired: !!(row.expires_at && row.expires_at <= Math.floor(Date.now() / 1000) && row.status === 'unused'),
    claimed_by_device_id: row.claimed_by_device_id || null,
    claimed_at: row.claimed_at || null,
    claimed_by_device_name: row.claimed_by_device_name || null,
  };
}

// Mint one unused code for a workspace. Retries until it lands a value no other
// LIVE ('unused') row holds; the UNIQUE(code) constraint is the backstop against
// the check-then-insert race. Returns the stored row, or null if every attempt
// collided (astronomically unlikely at any realistic code count).
async function mintCode({ workspaceId, plannedName, createdBy }) {
  const now = Math.floor(Date.now() / 1000);
  for (let attempt = 0; attempt < GEN_MAX_ATTEMPTS; attempt++) {
    const code = String(CODE_MIN + crypto.randomInt(CODE_SPAN));
    const clash = await db
      .prepare("SELECT 1 FROM registration_codes WHERE code = ? AND status = 'unused'")
      .get(code);
    if (clash) continue;
    const id = crypto.randomUUID();
    try {
      await db.prepare(`
        INSERT INTO registration_codes (id, code, workspace_id, planned_device_name, status, created_by, created_at, expires_at)
        VALUES (?, ?, ?, ?, 'unused', ?, ?, ?)
      `).run(id, code, workspaceId, plannedName, createdBy, now, now + CODE_TTL_SECONDS);
    } catch (e) {
      // MySQL: ER_DUP_ENTRY. better-sqlite3 (tests): SQLITE_CONSTRAINT_UNIQUE.
      if (e.code === 'ER_DUP_ENTRY' || /duplicate entry|unique/i.test(e.message || '')) continue;
      throw e;
    }
    return db.prepare('SELECT * FROM registration_codes WHERE id = ?').get(id);
  }
  return null;
}

// POST /api/provisioning/registration-codes
// body: { workspace_id, planned_device_name? }
// -> generates a unique 6-digit code, stores it 'unused', returns the row (201).
router.post('/registration-codes', asyncHandler(async (req, res) => {
  const ws = await loadAdminWorkspace(req, res, req.body && req.body.workspace_id);
  if (!ws) return;

  let plannedName = req.body && req.body.planned_device_name;
  plannedName = plannedName == null ? null : String(plannedName).trim();
  if (plannedName === '') plannedName = null;
  if (plannedName && plannedName.length > NAME_MAX) {
    return res.status(400).json({ error: `planned_device_name must be ${NAME_MAX} characters or fewer` });
  }

  const row = await mintCode({ workspaceId: ws.id, plannedName, createdBy: req.user.id });
  if (!row) {
    return res.status(503).json({ error: 'Could not allocate a unique code, please retry' });
  }
  res.status(201).json(serializeCode(row));
}));

// POST /api/provisioning/registration-codes/:id/regenerate
// -> mints a FRESH code (+ new 30-day expiry) reusing the old row's workspace and
// planned_device_name, so staff don't re-fill the form when a code lapsed unused.
// The old row is left exactly as it is (expired, unused) for the audit trail.
router.post('/registration-codes/:id/regenerate', asyncHandler(async (req, res) => {
  const old = await db.prepare('SELECT * FROM registration_codes WHERE id = ?').get(req.params.id);
  if (!old) return res.status(404).json({ error: 'Registration code not found' });
  const ws = await loadAdminWorkspace(req, res, old.workspace_id);
  if (!ws) return;
  // Only an UNUSED code can be regenerated - a claimed code already has its device.
  if (old.status !== 'unused') {
    return res.status(409).json({ error: 'That code was already claimed by a device and cannot be regenerated.' });
  }
  const row = await mintCode({
    workspaceId: old.workspace_id,
    plannedName: old.planned_device_name || null,
    createdBy: req.user.id,
  });
  if (!row) {
    return res.status(503).json({ error: 'Could not allocate a unique code, please retry' });
  }
  res.status(201).json(serializeCode(row));
}));

// DELETE /api/provisioning/registration-codes/:id
// -> removes a code from the list. An UNUSED (or expired-unused) code is freely
// deletable. A CLAIMED code is a history record - which device claimed which
// code, when - so it is refused (409, requires_confirmation:true) unless the
// caller re-sends with ?force=true / { force: true }, which the UI does behind a
// sterner confirm.
router.delete('/registration-codes/:id', asyncHandler(async (req, res) => {
  const row = await db.prepare('SELECT * FROM registration_codes WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Registration code not found' });
  const ws = await loadAdminWorkspace(req, res, row.workspace_id);
  if (!ws) return;

  const force = req.query.force === 'true' || req.query.force === '1'
    || !!(req.body && req.body.force === true);
  if (row.status === 'claimed' && !force) {
    return res.status(409).json({
      error: 'This code was claimed by a device. Deleting it removes the record of that claim. Re-send with force to delete it anyway.',
      requires_confirmation: true,
    });
  }

  await db.prepare('DELETE FROM registration_codes WHERE id = ?').run(row.id);
  res.json({ success: true });
}));

// GET /api/provisioning/registration-codes?workspace_id=...
// -> every code for that workspace, newest first, with the claiming device name.
router.get('/registration-codes', asyncHandler(async (req, res) => {
  const ws = await loadAdminWorkspace(req, res, req.query.workspace_id);
  if (!ws) return;
  const rows = await db.prepare(`
    SELECT rc.*, d.name AS claimed_by_device_name
    FROM registration_codes rc
    LEFT JOIN devices d ON d.id = rc.claimed_by_device_id
    WHERE rc.workspace_id = ?
    ORDER BY rc.created_at DESC, rc.id DESC
  `).all(ws.id);
  res.json(rows.map(serializeCode));
}));

// GET /api/provisioning/registration-codes/:id/qr
// -> image/png QR encoding the LINK to the public /activate/<code> page (not the
// bare 6-digit number - a bare number makes a phone camera run a web search).
// Same workspace-admin gate as the rest of the router (resolved from the code's
// own workspace_id). The dashboard fetches this with the Authorization header and
// blob-URLs it into an <img>, so it stays inside the standard JWT-only partition.
router.get('/registration-codes/:id/qr', asyncHandler(async (req, res) => {
  const row = await db.prepare('SELECT * FROM registration_codes WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Registration code not found' });
  const ws = await loadAdminWorkspace(req, res, row.workspace_id);
  if (!ws) return;
  // trust proxy is on, so req.protocol / req.get('host') are the public-facing
  // scheme + host (Cloudflare / reverse-proxy forwarded), not the internal ones.
  const activateUrl = `${req.protocol}://${req.get('host')}/activate/${row.code}`;
  const png = await QRCode.toBuffer(activateUrl, {
    type: 'png',
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 320,
  });
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'private, max-age=300');
  res.send(png);
}));

// ============================ Stage 2: device self-claim ============================
//
// A device (Android player / web player) the installer typed a pre-generated
// activation code into POSTs { code, device_info?, fingerprint? } here. We create
// AND claim the device in one atomic step, landing on the exact same end state the
// two-step pairing_code flow produces (socket `device:register` INSERT in
// ws/deviceSocket.js + `POST /api/provision/pair` claim in server.js): a devices
// row with status='online', workspace_id + user_id set, name assigned, a
// device_token minted. The only difference is the lookup key - a pre-generated
// registration_codes row instead of a device-minted devices.pairing_code.
//
// The device then authenticates its /device socket with the returned
// device_id + device_token and receives `device:paired` via the normal reconnect
// path (deviceSocket.js re-sends it whenever devices.user_id is set), so no
// bespoke socket handling is needed on either side.
const claimRouter = express.Router();

// Mirrors ws/deviceSocket.js generateDeviceToken().
function generateDeviceToken() {
  return crypto.randomBytes(32).toString('hex');
}

claimRouter.post('/', asyncHandler(async (req, res) => {
  const code = String((req.body && req.body.code) || '').trim();
  if (!CODE_RE.test(code)) {
    return res.status(400).json({ error: 'A 6-digit activation code is required.' });
  }
  const info = (req.body && req.body.device_info) || {};
  const fingerprint = (req.body && req.body.fingerprint)
    ? String(req.body.fingerprint) : null;

  const rc = await db.prepare('SELECT * FROM registration_codes WHERE code = ?').get(code);
  if (!rc) {
    return res.status(404).json({ error: 'That activation code is not recognised. Check for a typo and try again.' });
  }
  if (rc.status === 'claimed') {
    return res.status(409).json({ error: 'That activation code has already been used. Generate a new one from the dashboard.' });
  }
  if (rc.status !== 'unused') {
    return res.status(409).json({ error: 'That activation code is no longer available.' });
  }
  // An expired code is a real code that lapsed (not a typo), so it gets its own
  // distinct 410 - "generate a new one" - not the 404 an unknown code returns.
  if (rc.expires_at && rc.expires_at <= Math.floor(Date.now() / 1000)) {
    return res.status(410).json({ error: 'This code has expired - generate a new one from the dashboard.' });
  }
  const ws = await db.prepare('SELECT * FROM workspaces WHERE id = ?').get(rc.workspace_id);
  if (!ws) {
    // workspace_id FK is ON DELETE CASCADE, so a code outliving its workspace is
    // only reachable in a delete race - treat it as a dead code.
    return res.status(409).json({ error: 'The workspace for this activation code no longer exists.' });
  }

  const now = Math.floor(Date.now() / 1000);
  const deviceId = crypto.randomUUID();
  const deviceToken = generateDeviceToken();
  const ip = getClientIp(req);

  // Default name mirrors POST /api/provision/pair: "Display N" scoped to the
  // provisioning admin's device count, used only when the code carries no
  // planned_device_name (case 4: name can still be set later, same as normal).
  let name = rc.planned_device_name && String(rc.planned_device_name).trim();
  if (!name) {
    const c = await db.prepare('SELECT COUNT(*) AS count FROM devices WHERE user_id = ?').get(rc.created_by);
    name = 'Display ' + ((c ? c.count : 0) + 1);
  }

  let raced = false;
  try {
    await db.transaction(async (tx) => {
      // Device row created ALREADY claimed. INSERT before the code UPDATE so the
      // registration_codes.claimed_by_device_id FK target exists.
      await tx.prepare(`
        INSERT INTO devices (id, user_id, workspace_id, name, status, ip_address,
          android_version, app_version, screen_width, screen_height, render_width, render_height,
          device_token, last_heartbeat, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'online', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        deviceId, rc.created_by, ws.id, name, ip,
        info.android_version || null, info.app_version || null,
        info.screen_width || null, info.screen_height || null,
        info.render_width || null, info.render_height || null,
        deviceToken, now, now, now,
      );

      // The `AND status = 'unused'` makes this the race gate: two devices POSTing
      // the same code concurrently both INSERT a device, but only the first
      // UPDATE matches a row. The loser throws -> ROLLBACK -> its device row is
      // undone -> 409.
      const upd = await tx.prepare(`
        UPDATE registration_codes SET status = 'claimed', claimed_by_device_id = ?, claimed_at = ?
        WHERE code = ? AND status = 'unused'
      `).run(deviceId, now, code);
      if (!upd.changes) {
        const e = new Error('registration code claimed concurrently');
        e.code = 'CLAIM_RACE';
        throw e;
      }

      // Link the hardware fingerprint to the new device + provisioning admin,
      // mirroring the `UPDATE device_fingerprints` in POST /api/provision/pair.
      if (fingerprint) {
        const existing = await tx.prepare('SELECT fingerprint FROM device_fingerprints WHERE fingerprint = ?').get(fingerprint);
        if (existing) {
          await tx.prepare('UPDATE device_fingerprints SET device_id = ?, user_id = ?, last_seen = ? WHERE fingerprint = ?')
            .run(deviceId, rc.created_by, now, fingerprint);
        } else {
          await tx.prepare('INSERT INTO device_fingerprints (fingerprint, device_id, user_id, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)')
            .run(fingerprint, deviceId, rc.created_by, now, now);
        }
      }
    })();
  } catch (e) {
    if (e.code === 'CLAIM_RACE') raced = true;
    else throw e;
  }
  if (raced) {
    return res.status(409).json({ error: 'That activation code has already been used. Generate a new one from the dashboard.' });
  }

  const device = await db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId);

  // Live dashboard update, mirroring POST /api/provision/pair's dashboard:device-added.
  try {
    const io = req.app.get('io');
    if (io) {
      const row = { ...device };
      stripDeviceSecrets(row);
      emitToWorkspace(io.of('/dashboard'), workspaceRoom(ws.id), 'dashboard:device-added', row);
    }
  } catch (_) { /* dashboard push is best-effort */ }

  // device_token is returned ONLY here (same as the socket device:registered
  // event) - never via the admin list endpoints (serializeCode omits it).
  res.status(201).json({
    device_id: deviceId,
    device_token: deviceToken,
    name,
    workspace_id: ws.id,
    status: 'online',
  });
}));

module.exports = router;
module.exports.claimRouter = claimRouter;
