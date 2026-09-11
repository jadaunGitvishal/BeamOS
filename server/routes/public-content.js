'use strict';

// Public content file/thumbnail serving. Extracted from server.js (pure code motion,
// #Ref45-stage1 follow-up — no logic change) so this exact real module can be required
// both by server.js and by in-process tests (test/helpers/inprocess-app.js), instead of
// a test duplicating this logic and risking drift.
//
// MUST be mounted BEFORE the authenticated /api/content router (config/api-surface.js's
// PUBLIC_ROUTERS -> routes/content.js) at the EXACT SAME point server.js mounted this
// code inline — Express dispatches to the first matching registration for an exact path,
// so mounting this after the /api/content router would make it unreachable (shadowed by
// routes/content.js's own, non-proxying /:id/thumbnail and /:id/file handlers instead of
// the other way around, which is the correct/original behavior).

const express = require('express');
const router = express.Router();
const path = require('path');
const config = require('../config');
const { asyncHandler } = require('../lib/async-handler');

// A logged-in user who can access the content's workspace may view its file /
// thumbnail even when it isn't referenced by a playlist/widget yet (e.g. the
// content library showing a just-uploaded, not-yet-assigned item). <img> can't
// send an Authorization header, so the dashboard fetches these with the Bearer
// token; this verifies it and checks workspace membership. Anonymous players
// (no token) still fall back to the playlist/widget reference gate. (#39)
async function requesterCanAccessContent(req, content) {
  try {
    const m = (req.headers.authorization || '').match(/^Bearer (.+)$/);
    if (!m) return false;
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(m[1], config.jwtSecret, {
      algorithms: ['HS256'],
    });
    if (!decoded || !decoded.id) return false;
    if (decoded.role === 'platform_admin') return true;
    const { db } = require('../db/database');
    return !!(await db
      .prepare(
        'SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
      )
      .get(content.workspace_id, decoded.id));
  } catch {
    return false;
  }
}

// Public content file serving (must be BEFORE protected routes)
router.get(
  '/api/content/:id/file',
  asyncHandler(async (req, res) => {
    const { db } = require('../db/database');
    const content = await db
      .prepare('SELECT * FROM content WHERE id = ?')
      .get(req.params.id);
    if (!content) return res.status(404).json({ error: 'Content not found' });
    if (!content.filepath)
      return res.status(404).json({ error: 'No file (remote URL content)' });
    const inPlaylist = await db
      .prepare('SELECT id FROM playlist_items WHERE content_id = ? LIMIT 1')
      .get(req.params.id);
    // Scope widget lookup to widgets in the content's workspace — prevents a user
    // in another workspace from unlocking this content by creating a widget that
    // references the UUID. Phase 2.2d: keyed off content.workspace_id (was user_id).
    // Perf note: LIKE scan on widgets.config is O(n) per request. Fine at current scale
    // (<100 widgets); revisit with a content_widget_refs join table if this grows.
    const inWidget = inPlaylist
      ? null
      : await db
          .prepare(
            'SELECT id FROM widgets WHERE workspace_id = ? AND config LIKE ? LIMIT 1',
          )
          .get(content.workspace_id, `%/api/content/${req.params.id}/%`);
    if (
      !inPlaylist &&
      !inWidget &&
      !(await requesterCanAccessContent(req, content))
    )
      return res
        .status(403)
        .json({ error: 'Content not assigned to any playlist or widget' });
    const safePath = path.resolve(
      config.contentDir,
      path.basename(content.filepath),
    );
    if (!safePath.startsWith(path.resolve(config.contentDir)))
      return res.status(403).json({ error: 'Invalid path' });
    res.sendFile(safePath);
  }),
);

// Proxy a remote thumbnail (e.g. YouTube's img.youtube.com/.../hqdefault.jpg, which
// content.js stores as thumbnail_path) server-side, SAME-ORIGIN, so the dashboard CSP
// img-src is unaffected. Never throws into the process: any upstream/network failure
// becomes a clean 404/502. Restricted to image/* responses (modest SSRF hardening; the
// URL is server-set at ingest, not caller-supplied). Thumbnails are small, so buffering
// is fine and avoids partial-stream error handling.
async function proxyRemoteThumbnail(url, res) {
  try {
    const upstream = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
    });
    if (upstream.status === 404)
      return res.status(404).json({ error: 'Thumbnail not found' });
    if (!upstream.ok)
      return res.status(502).json({ error: 'Thumbnail upstream error' });
    const ct = upstream.headers.get('content-type') || 'image/jpeg';
    if (!/^image\//i.test(ct))
      return res
        .status(502)
        .json({ error: 'Thumbnail upstream is not an image' });
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.set('Content-Type', ct);
    res.set('Cache-Control', 'public, max-age=86400');
    return res.send(buf);
  } catch (e) {
    return res.status(502).json({ error: 'Thumbnail fetch failed' });
  }
}

// Public thumbnail serving (must be BEFORE protected routes)
router.get(
  '/api/content/:id/thumbnail',
  asyncHandler(async (req, res) => {
    const { db } = require('../db/database');
    const content = await db
      .prepare('SELECT * FROM content WHERE id = ?')
      .get(req.params.id);
    if (!content || !content.thumbnail_path)
      return res.status(404).json({ error: 'Thumbnail not found' });
    // Security: gate the same way as /file - only serve when the content is
    // referenced by a playlist or by a widget IN THE CONTENT'S WORKSPACE. Without
    // this, any anonymous caller holding a content UUID could pull any tenant's
    // thumbnail (the /file route already had this check; the thumbnail route did not).
    const inPlaylist = await db
      .prepare('SELECT id FROM playlist_items WHERE content_id = ? LIMIT 1')
      .get(req.params.id);
    const inWidget = inPlaylist
      ? null
      : await db
          .prepare(
            'SELECT id FROM widgets WHERE workspace_id = ? AND config LIKE ? LIMIT 1',
          )
          .get(content.workspace_id, `%/api/content/${req.params.id}/%`);
    if (
      !inPlaylist &&
      !inWidget &&
      !(await requesterCanAccessContent(req, content))
    )
      return res
        .status(403)
        .json({ error: 'Content not assigned to any playlist or widget' });
    // YouTube (and any future remote-sourced) content stores thumbnail_path as a remote
    // http(s) URL, not a local file. Proxy it instead of resolving it to a local path that
    // doesn't exist (contentDir/hqdefault.jpg -> ENOENT spam). Local thumbnails are
    // unchanged. Access gating above already ran identically for both branches.
    if (/^https?:\/\//i.test(content.thumbnail_path))
      return proxyRemoteThumbnail(content.thumbnail_path, res);
    const safePath = path.resolve(
      config.contentDir,
      path.basename(content.thumbnail_path),
    );
    if (!safePath.startsWith(path.resolve(config.contentDir)))
      return res.status(403).json({ error: 'Invalid path' });
    res.sendFile(safePath);
  }),
);

module.exports = router;
