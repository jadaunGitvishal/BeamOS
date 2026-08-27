const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const { PLATFORM_ROLES, ELEVATED_ROLES } = require('../middleware/auth');
const { asyncHandler } = require('../lib/async-handler');
// Phase 2.2h: workspace-aware access. Templates (is_template=1) are the
// platform-shared pair (NULL user_id, NULL workspace_id) and are visible
// everywhere, writable only by platform_admin.
const { accessContext } = require('../lib/tenancy');
const { toCsvRow } = require('../lib/csv');
const { renderXlsx, renderPdf } = require('../lib/report-export');

function formatTimestamp(epochSeconds) {
  if (epochSeconds === null || epochSeconds === undefined) return '';
  return new Date(epochSeconds * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

// Mirrors the other export routes' EXPORT_ROW_CAP rationale - GET / has no
// LIMIT, this is just a safety net against a pathological workspace.
const EXPORT_ROW_CAP = 5000;

// List layouts in the caller's current workspace plus all templates.
// Phase 2.2h: workspace-scoped. Templates (is_template=1) remain visible to
// everyone; cross-workspace owned-layout visibility comes from switch-workspace.
router.get('/', asyncHandler(async (req, res) => {
  const showTemplates = req.query.templates === 'true';

  let layouts;
  if (showTemplates) {
    layouts = await db.prepare('SELECT * FROM layouts WHERE is_template = 1 ORDER BY template_category, name').all();
  } else if (!req.workspaceId) {
    // No workspace context -> only templates are visible.
    layouts = await db.prepare('SELECT * FROM layouts WHERE is_template = 1 ORDER BY template_category, name').all();
  } else {
    layouts = await db.prepare(
      'SELECT * FROM layouts WHERE (workspace_id = ? OR is_template = 1) ORDER BY is_template DESC, created_at DESC'
    ).all(req.workspaceId);
  }

  // Attach zones to each layout
  const zonesStmt = db.prepare('SELECT * FROM layout_zones WHERE layout_id = ? ORDER BY sort_order');
  for (const l of layouts) { l.zones = await zonesStmt.all(l.id); }

  res.json(layouts);
}));

// GET /export?format=csv|xlsx|pdf - mirrors GET /'s exact scoping, including
// its 3-way branch: ?templates=true (or no workspace context) -> templates
// only; otherwise workspace_id = ? OR is_template = 1. Zone data is
// summarized as a count (Zone Count column) rather than exported row-by-row -
// the full zones array is nested detail data, not summary table data, and
// doesn't fit a flat export row.
router.get('/export', asyncHandler(async (req, res) => {
  const showTemplates = req.query.templates === 'true';

  let layouts;
  if (showTemplates || !req.workspaceId) {
    layouts = await db.prepare(`
      SELECT l.*, COUNT(z.id) as zone_count
      FROM layouts l
      LEFT JOIN layout_zones z ON z.layout_id = l.id
      WHERE l.is_template = 1
      GROUP BY l.id
      ORDER BY l.template_category, l.name
      LIMIT ?
    `).all(EXPORT_ROW_CAP);
  } else {
    layouts = await db.prepare(`
      SELECT l.*, COUNT(z.id) as zone_count
      FROM layouts l
      LEFT JOIN layout_zones z ON z.layout_id = l.id
      WHERE (l.workspace_id = ? OR l.is_template = 1)
      GROUP BY l.id
      ORDER BY l.is_template DESC, l.created_at DESC
      LIMIT ?
    `).all(req.workspaceId, EXPORT_ROW_CAP);
  }

  const format = ['csv', 'xlsx', 'pdf'].includes(req.query.format) ? req.query.format : 'csv';

  const headers = ['Name', 'Template Category', 'Zone Count', 'Is Template', 'Created At (UTC)'];
  const dataRows = layouts.map((l) => [
    l.name,
    l.is_template ? (l.template_category || '') : '',
    l.zone_count,
    l.is_template ? 'Yes' : 'No',
    formatTimestamp(l.created_at),
  ]);

  const date = new Date().toISOString().slice(0, 10);
  const filenameBase = `layouts-${date}`;

  if (format === 'xlsx') {
    const buffer = await renderXlsx('Layouts', headers, dataRows);
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', `attachment; filename="${filenameBase}.xlsx"`);
    res.send(buffer);
    return;
  }

  if (format === 'pdf') {
    const buffer = await renderPdf('Layouts', headers, dataRows);
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="${filenameBase}.pdf"`);
    res.send(buffer);
    return;
  }

  const header = toCsvRow(headers);
  const csvRows = dataRows.map((row) => toCsvRow(row));
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${filenameBase}.csv"`);
  res.send('﻿' + [header, ...csvRows].join('\r\n'));
}));

// Phase 2.2h: workspace-aware access. Mirrors content/widget/kiosk helpers.
// Templates (is_template=1) are readable by anyone authenticated; writable
// only by platform_admin (kept layered with the existing L78/L94 guards).
async function checkLayoutRead(req, res) {
  const layout = await db.prepare('SELECT * FROM layouts WHERE id = ?').get(req.params.id);
  if (!layout) { res.status(404).json({ error: 'Layout not found' }); return null; }
  if (layout.is_template) return layout;
  if (!layout.workspace_id) {
    // Owned row with no workspace - treat as inaccessible (shouldn't exist post-migration).
    res.status(403).json({ error: 'Layout not assigned to a workspace' }); return null;
  }
  const ws = await db.prepare('SELECT * FROM workspaces WHERE id = ?').get(layout.workspace_id);
  const ctx = ws && await accessContext(req.user.id, req.user.role, ws);
  if (!ctx) { res.status(403).json({ error: 'Access denied' }); return null; }
  return layout;
}

async function checkLayoutWrite(req, res) {
  const layout = await db.prepare('SELECT * FROM layouts WHERE id = ?').get(req.params.id);
  if (!layout) { res.status(404).json({ error: 'Layout not found' }); return null; }
  if (layout.is_template) {
    // Templates: only platform_admin may write. Existing L78/L94 also check
    // is_template explicitly with the same intent; this is the layered gate.
    if (!PLATFORM_ROLES.includes(req.user.role)) {
      res.status(403).json({ error: 'Platform admin required to modify templates' }); return null;
    }
    return layout;
  }
  if (!layout.workspace_id) {
    res.status(403).json({ error: 'Layout not assigned to a workspace' }); return null;
  }
  const ws = await db.prepare('SELECT * FROM workspaces WHERE id = ?').get(layout.workspace_id);
  const ctx = ws && await accessContext(req.user.id, req.user.role, ws);
  if (!ctx) { res.status(403).json({ error: 'Access denied' }); return null; }
  if (!ctx.actingAs && ctx.workspaceRole === 'workspace_viewer') {
    res.status(403).json({ error: 'Read-only access' }); return null;
  }
  return layout;
}

// Get layout with zones
router.get('/:id', asyncHandler(async (req, res) => {
  const layout = await checkLayoutRead(req, res);
  if (!layout) return;

  layout.zones = await db.prepare('SELECT * FROM layout_zones WHERE layout_id = ? ORDER BY sort_order').all(layout.id);
  res.json(layout);
}));

// Create layout in the caller's current workspace.
router.post('/', asyncHandler(async (req, res) => {
  if (!req.workspaceId) return res.status(403).json({ error: 'No workspace context. Switch to a workspace before creating layouts.' });
  const { name, width, height, zones } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });

  const id = uuidv4();
  await db.prepare('INSERT INTO layouts (id, user_id, workspace_id, name, width, height) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, req.user.id, req.workspaceId, name, width || 1920, height || 1080);

  // Create zones if provided
  if (zones && Array.isArray(zones)) {
    const stmt = db.prepare(`
      INSERT INTO layout_zones (id, layout_id, name, x_percent, y_percent, width_percent, height_percent, z_index, zone_type, fit_mode, background_color, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (let i = 0; i < zones.length; i++) {
      const z = zones[i];
      await stmt.run(uuidv4(), id, z.name || `Zone ${i + 1}`, z.x_percent || 0, z.y_percent || 0,
        z.width_percent || 100, z.height_percent || 100, z.z_index || 0,
        z.zone_type || 'content', z.fit_mode || 'contain', z.background_color || '#000000', i);
    }
  }

  const layout = await db.prepare('SELECT * FROM layouts WHERE id = ?').get(id);
  layout.zones = await db.prepare('SELECT * FROM layout_zones WHERE layout_id = ? ORDER BY sort_order').all(id);
  res.status(201).json(layout);
}));

// Update layout
router.put('/:id', asyncHandler(async (req, res) => {
  const layout = await checkLayoutWrite(req, res);
  if (!layout) return;
  if (layout.is_template && !PLATFORM_ROLES.includes(req.user.role)) return res.status(403).json({ error: 'Cannot edit templates' });

  const { name, width, height, zones } = req.body;
  const txn = db.transaction(async (tx) => {
    if (name) await tx.prepare('UPDATE layouts SET name = ?, updated_at = UNIX_TIMESTAMP() WHERE id = ?').run(name, req.params.id);
    if (width) await tx.prepare('UPDATE layouts SET width = ? WHERE id = ?').run(width, req.params.id);
    if (height) await tx.prepare('UPDATE layouts SET height = ? WHERE id = ?').run(height, req.params.id);

    // Atomic zone replace: the editor sends the FULL desired set, so the layout
    // ends up with EXACTLY those zones - no accumulation from a per-zone
    // delete/add loop. Reuse each zone's id when supplied so device->zone
    // assignments survive an edit (a fresh uuid per save would orphan them).
    if (Array.isArray(zones)) {
      await tx.prepare('DELETE FROM layout_zones WHERE layout_id = ?').run(req.params.id);
      const stmt = tx.prepare(`
        INSERT INTO layout_zones (id, layout_id, name, x_percent, y_percent, width_percent, height_percent, z_index, zone_type, fit_mode, background_color, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (let i = 0; i < zones.length; i++) {
        const z = zones[i];
        await stmt.run(z.id || uuidv4(), req.params.id, z.name || `Zone ${i + 1}`,
          z.x_percent || 0, z.y_percent || 0, z.width_percent || 100, z.height_percent || 100,
          z.z_index || 0, z.zone_type || 'content', z.fit_mode || 'contain',
          z.background_color || '#000000', i);
      }
      await tx.prepare('UPDATE layouts SET updated_at = UNIX_TIMESTAMP() WHERE id = ?').run(req.params.id);
    }
  });
  await txn();

  const updated = await db.prepare('SELECT * FROM layouts WHERE id = ?').get(req.params.id);
  updated.zones = await db.prepare('SELECT * FROM layout_zones WHERE layout_id = ? ORDER BY sort_order').all(req.params.id);
  res.json(updated);
}));

// Delete layout
router.delete('/:id', asyncHandler(async (req, res) => {
  const layout = await checkLayoutWrite(req, res);
  if (!layout) return;
  if (layout.is_template && !PLATFORM_ROLES.includes(req.user.role)) return res.status(403).json({ error: 'Cannot delete templates' });

  await db.prepare('DELETE FROM layouts WHERE id = ?').run(req.params.id);
  res.json({ success: true });
}));

// Add zone to layout. Phase 2.2h: tightened to write-access; workspace_viewer
// can read the layout via GET but cannot add zones.
router.post('/:id/zones', asyncHandler(async (req, res) => {
  const layout = await checkLayoutWrite(req, res);
  if (!layout) return;

  const { name, x_percent, y_percent, width_percent, height_percent, z_index, zone_type, fit_mode, background_color } = req.body;
  const maxRow = await db.prepare('SELECT MAX(sort_order) as m FROM layout_zones WHERE layout_id = ?').get(req.params.id);
  const maxOrder = maxRow.m || 0;

  const id = uuidv4();
  await db.prepare(`
    INSERT INTO layout_zones (id, layout_id, name, x_percent, y_percent, width_percent, height_percent, z_index, zone_type, fit_mode, background_color, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.params.id, name || 'New Zone', x_percent || 0, y_percent || 0,
    width_percent || 50, height_percent || 50, z_index || 0,
    zone_type || 'content', fit_mode || 'contain', background_color || '#000000', maxOrder + 1);

  await db.prepare("UPDATE layouts SET updated_at = UNIX_TIMESTAMP() WHERE id = ?").run(req.params.id);

  const zone = await db.prepare('SELECT * FROM layout_zones WHERE id = ?').get(id);
  res.status(201).json(zone);
}));

// Update zone
router.put('/:id/zones/:zoneId', asyncHandler(async (req, res) => {
  const layout = await checkLayoutWrite(req, res);
  if (!layout) return;
  const zone = await db.prepare('SELECT * FROM layout_zones WHERE id = ? AND layout_id = ?').get(req.params.zoneId, req.params.id);
  if (!zone) return res.status(404).json({ error: 'Zone not found' });

  const fields = ['name', 'x_percent', 'y_percent', 'width_percent', 'height_percent', 'z_index', 'zone_type', 'fit_mode', 'background_color', 'sort_order'];
  const updates = [];
  const values = [];
  fields.forEach(f => {
    if (req.body[f] !== undefined) { updates.push(`${f} = ?`); values.push(req.body[f]); }
  });

  if (updates.length > 0) {
    values.push(req.params.zoneId);
    await db.prepare(`UPDATE layout_zones SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    await db.prepare("UPDATE layouts SET updated_at = UNIX_TIMESTAMP() WHERE id = ?").run(req.params.id);
  }

  const updated = await db.prepare('SELECT * FROM layout_zones WHERE id = ?').get(req.params.zoneId);
  res.json(updated);
}));

// Delete zone
router.delete('/:id/zones/:zoneId', asyncHandler(async (req, res) => {
  const layout = await checkLayoutWrite(req, res);
  if (!layout) return;
  await db.prepare('DELETE FROM layout_zones WHERE id = ? AND layout_id = ?').run(req.params.zoneId, req.params.id);
  await db.prepare("UPDATE layouts SET updated_at = UNIX_TIMESTAMP() WHERE id = ?").run(req.params.id);
  res.json({ success: true });
}));

// Duplicate layout (for using templates). Source needs read-access only;
// destination lands in the caller's current workspace.
router.post('/:id/duplicate', asyncHandler(async (req, res) => {
  if (!req.workspaceId) return res.status(403).json({ error: 'No workspace context. Switch to a workspace before duplicating a layout.' });
  const source = await checkLayoutRead(req, res);
  if (!source) return;

  const newId = uuidv4();
  const name = req.body.name || `${source.name} (Copy)`;

  await db.prepare('INSERT INTO layouts (id, user_id, workspace_id, name, width, height) VALUES (?, ?, ?, ?, ?, ?)')
    .run(newId, req.user.id, req.workspaceId, name, source.width, source.height);

  // Copy zones, keeping an old->new zone-id map. The copy gets fresh zone ids, so any
  // playlist_items still pointing at the SOURCE zones would be orphaned if a device is
  // moved onto this copy. We return the map (zone_id_map) so a follow-up remap can run.
  // NOTE for review: we intentionally do NOT auto-rewrite playlist_items.zone_id here —
  // the source layout's own assignments must keep pointing at the source. A safe remap is
  // a scoped op ("migrate playlist P from layout A to its copy B"), best done explicitly;
  // see find-orphan-zone-items.js + the player fallback, which already de-risk the runtime.
  const zones = await db.prepare('SELECT * FROM layout_zones WHERE layout_id = ?').all(req.params.id);
  const stmt = db.prepare(`
    INSERT INTO layout_zones (id, layout_id, name, x_percent, y_percent, width_percent, height_percent, z_index, zone_type, fit_mode, background_color, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const zone_id_map = {};
  for (const z of zones) {
    const nz = uuidv4();
    zone_id_map[z.id] = nz;
    await stmt.run(nz, newId, z.name, z.x_percent, z.y_percent, z.width_percent, z.height_percent,
      z.z_index, z.zone_type, z.fit_mode, z.background_color, z.sort_order);
  }

  const layout = await db.prepare('SELECT * FROM layouts WHERE id = ?').get(newId);
  layout.zones = await db.prepare('SELECT * FROM layout_zones WHERE layout_id = ? ORDER BY sort_order').all(newId);
  res.status(201).json({ ...layout, zone_id_map });
}));

// Assign layout to device.
// Phase 2.2h: closes a pre-existing cross-tenant leak. Today the route only
// gated by device-ownership and didn't verify the layout_id at all, so any
// caller with write access to a device could assign another workspace's
// layout to it - the player would then render foreign zones/dimensions.
//
// New rules:
//   1. Caller must have write access to the DEVICE's workspace.
//   2. The layout must be either a template (is_template=1) or live in the
//      same workspace as the device.
router.put('/device/:deviceId', asyncHandler(async (req, res) => {
  const device = await db.prepare('SELECT user_id, workspace_id FROM devices WHERE id = ?').get(req.params.deviceId);
  if (!device) return res.status(404).json({ error: 'Device not found' });
  if (!device.workspace_id) return res.status(403).json({ error: 'Device not assigned to a workspace' });

  const deviceWs = await db.prepare('SELECT * FROM workspaces WHERE id = ?').get(device.workspace_id);
  const ctx = deviceWs && await accessContext(req.user.id, req.user.role, deviceWs);
  if (!ctx) return res.status(403).json({ error: 'Access denied' });
  if (!ctx.actingAs && ctx.workspaceRole === 'workspace_viewer') {
    return res.status(403).json({ error: 'Read-only access' });
  }

  const { layout_id } = req.body;
  if (layout_id) {
    const layout = await db.prepare('SELECT is_template, workspace_id FROM layouts WHERE id = ?').get(layout_id);
    if (!layout) return res.status(400).json({ error: 'Invalid layout_id' });
    // Layout must be a template, or live in the device's workspace.
    if (!layout.is_template && layout.workspace_id !== device.workspace_id) {
      return res.status(403).json({ error: 'Layout is not in this device\'s workspace and is not a template' });
    }
  }

  await db.prepare("UPDATE devices SET layout_id = ?, updated_at = UNIX_TIMESTAMP() WHERE id = ?")
    .run(layout_id || null, req.params.deviceId);
  res.json({ success: true });
}));

module.exports = router;
