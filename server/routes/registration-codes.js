'use strict';

// Ref 30 Stage 1: advance device registration codes.
//
// A workspace_admin (or org / platform admin) generates a short numeric code
// ahead of an install, optionally naming the device it is destined for. An
// installer later enters that code ON the device to bind it to the workspace -
// no admin present at install time, no pairing-code round trip. The device-side
// claim is Stage 2 (not built yet); this router only mints and lists codes.
//
// This router targets a workspace by BODY / QUERY param (not the caller's active
// workspace), so it is mounted WITHOUT resolveTenancy and gates every handler
// with canAdminWorkspace(db, user, workspace) - the same pattern as
// routes/workspaces.js. Mounted JWT-only (config/api-surface.js), so a Bearer
// st_ API token can never reach it.

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const QRCode = require('qrcode');
const { db } = require('../db/database');
const { canAdminWorkspace } = require('../lib/permissions');
const { asyncHandler } = require('../lib/async-handler');

const NAME_MAX = 255;
const CODE_MIN = 100000;
const CODE_SPAN = 900000; // codes span 100000-999999 inclusive
const GEN_MAX_ATTEMPTS = 12;

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
    claimed_by_device_id: row.claimed_by_device_id || null,
    claimed_at: row.claimed_at || null,
    claimed_by_device_name: row.claimed_by_device_name || null,
  };
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

  // Retry until we land a code no live ('unused') row already holds. The
  // UNIQUE(code) constraint is the backstop against the check-then-insert race
  // (a concurrent POST that grabbed the same value between our SELECT and
  // INSERT) - a duplicate-key error just costs another attempt.
  let row = null;
  for (let attempt = 0; attempt < GEN_MAX_ATTEMPTS && !row; attempt++) {
    const code = String(CODE_MIN + crypto.randomInt(CODE_SPAN));
    const clash = await db
      .prepare("SELECT 1 FROM registration_codes WHERE code = ? AND status = 'unused'")
      .get(code);
    if (clash) continue;
    const id = crypto.randomUUID();
    try {
      await db.prepare(`
        INSERT INTO registration_codes (id, code, workspace_id, planned_device_name, status, created_by, created_at)
        VALUES (?, ?, ?, ?, 'unused', ?, ?)
      `).run(id, code, ws.id, plannedName, req.user.id, Math.floor(Date.now() / 1000));
    } catch (e) {
      // MySQL: ER_DUP_ENTRY. better-sqlite3 (tests): SQLITE_CONSTRAINT_UNIQUE.
      if (e.code === 'ER_DUP_ENTRY' || /duplicate entry|unique/i.test(e.message || '')) continue;
      throw e;
    }
    row = await db.prepare('SELECT * FROM registration_codes WHERE id = ?').get(id);
  }
  if (!row) {
    return res.status(503).json({ error: 'Could not allocate a unique code, please retry' });
  }
  res.status(201).json(serializeCode(row));
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
// -> image/png QR encoding the bare 6-digit code. Same workspace-admin gate as
// the rest of the router (resolved from the code's own workspace_id). The
// dashboard fetches this with the Authorization header and blob-URLs it into an
// <img>, so it stays inside the standard JWT-only partition (no query-param token).
router.get('/registration-codes/:id/qr', asyncHandler(async (req, res) => {
  const row = await db.prepare('SELECT * FROM registration_codes WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Registration code not found' });
  const ws = await loadAdminWorkspace(req, res, row.workspace_id);
  if (!ws) return;
  const png = await QRCode.toBuffer(row.code, {
    type: 'png',
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 320,
  });
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'private, max-age=300');
  res.send(png);
}));

module.exports = router;
