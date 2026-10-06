const { db } = require('../db/database');
const config = require('../config');
const proxyaddr = require('proxy-addr');
const { trustedProxies } = require('../config/cloudflareIps');
const { appendEntry } = require('../lib/activity-chain');

// Gate function: returns true when an immediate TCP peer is one we trust
// to populate forwarding headers (Cloudflare edges, loopback, link-local,
// unique-local). Mirrors what `app.set('trust proxy', trustedProxies)` does
// for X-Forwarded-For so that CF-Connecting-IP is held to the same standard.
const isTrustedPeer = proxyaddr.compile(trustedProxies);

// Resolve the real client IP for logging.
//
// Cloudflare always sets `CF-Connecting-IP` to the original client address
// when it proxies a request. We prefer that header — but only when the
// connection's immediate peer is a trusted CF/loopback address; otherwise
// any random visitor could spoof the header by hitting the origin directly.
//
// Falls back to req.ip (which Express resolves via the trust-proxy table)
// so local dev and any non-CF deployment keep working unchanged.
function getClientIp(req) {
  if (!req) return null;
  const cf = req.headers && req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.length > 0) {
    const peer = req.socket && req.socket.remoteAddress;
    if (peer && isTrustedPeer(peer, 0)) return cf;
  }
  return req.ip || null;
}

// Phase 2.2 writer-leak fix: activity_log rows now stamp workspace_id so
// tenant-scoped queries don't miss new events. Callers pass the workspace
// when known; the middleware below sources it from resolveTenancy. When
// workspaceId is null but a device_id is provided, fall back to the device's
// workspace - matches the backfill rule for consistency.
async function logActivity(userId, action, details = null, deviceId = null, ipAddress = null, workspaceId = null) {
  try {
    let ws = workspaceId || null;
    if (!ws && deviceId) {
      const d = await db.prepare('SELECT workspace_id FROM devices WHERE id = ?').get(deviceId);
      ws = d?.workspace_id || null;
    }
    // Ref 17: every audit row goes through the chained, concurrency-safe writer.
    await appendEntry(db, {
      user_id: userId || null,
      device_id: deviceId || null,
      action,
      details: details || null,
      ip_address: ipAddress || null,
      workspace_id: ws,
    });
  } catch (e) {
    console.error('Activity log error:', e.message);
  }
}

async function getActivity(options = {}) {
  const { userId, deviceId, limit = 50, offset = 0 } = options;
  // Audit rows keep user_id after the user is deleted (it is hashed - see
  // lib/user-deletion.js), so a row whose user no longer exists is labelled
  // 'Deleted user'; user_email is then NULL (no users row). Rows with no user
  // (system events) and rows for existing users are unchanged.
  let sql = `SELECT al.*,
      CASE WHEN al.user_id IS NOT NULL AND u.id IS NULL THEN 'Deleted user' ELSE u.name END as user_name,
      u.email as user_email
    FROM activity_log al LEFT JOIN users u ON al.user_id = u.id WHERE 1=1`;
  const params = [];

  if (userId) { sql += ' AND al.user_id = ?'; params.push(userId); }
  if (deviceId) { sql += ' AND al.device_id = ?'; params.push(deviceId); }

  sql += ' ORDER BY al.created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  return db.prepare(sql).all(...params);
}

// Prune activity_log rows past the retention window (config.auditLogRetentionDays,
// ≥365 per RFP compliance). Boundary: a row is deleted once it is strictly older
// than the window — a row exactly N days old is kept.
// Only ever invoked by the manual admin action DELETE /api/activity/prune; no
// scheduler or background sweep calls this.
async function pruneActivityLog() {
  await db
    .prepare("DELETE FROM activity_log WHERE created_at < UNIX_TIMESTAMP() - (? * 86400)")
    .run(config.auditLogRetentionDays);
}

// The audit-log path for a request: mount path + matched route PATTERN (e.g.
// /api/workspaces/:id/members/export), never the concrete URL, so ids and query
// strings stay out of `action`. Still populated when 'finish'/'close' fire.
function routePath(req) {
  return `${req.baseUrl || ''}${req.route?.path || req.path}`;
}

// Ref 20: format of a downloaded file - from the filename's extension, else
// from Content-Type.
const CONTENT_TYPE_FORMATS = {
  'text/csv': 'csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/pdf': 'pdf',
  'application/sql': 'sql',
  'application/json': 'json',
  'application/zip': 'zip',
};
function exportFormat(filename, contentType) {
  const ext = /\.([a-z0-9]{1,8})$/i.exec(filename || '');
  if (ext) return ext[1].toLowerCase();
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  return CONTENT_TYPE_FORMATS[type] || 'unknown';
}

// Ref 20: record a completed or aborted file download. Called from the 'close'
// listener activityLogger attaches to every request; only a successful response
// carrying `Content-Disposition: attachment` counts, so a refused export (403
// JSON) stays the ACCESS_DENIED entry alone. Details hold the file name, format,
// the query-parameter KEY names and the outcome - never query values, request
// bodies or response data.
function logExport(req, res, ip) {
  if (res.statusCode >= 400) return;
  const disposition = String(res.getHeader('Content-Disposition') || '');
  if (!/attachment/i.test(disposition)) return;
  const m = /filename\*?=(?:"([^"]*)"|([^;]*))/i.exec(disposition);
  const file = ((m && (m[1] ?? m[2])) || '').trim().slice(0, 200);
  const format = exportFormat(file, res.getHeader('Content-Type'));
  const filters = Object.keys(req.query || {}).map((k) => k.slice(0, 64)).sort().join(',');
  const outcome = res.writableFinished ? 'completed' : 'aborted';
  const details = `file=${file}, format=${format}, filters=[${filters}], outcome=${outcome}`;
  // device_id only from an explicit :deviceId param - a generic :id here is an
  // org/workspace/resource id, not a device.
  logActivity(req.user?.id || null, `EXPORT ${routePath(req)}`, details, req.params?.deviceId || null, ip, req.workspaceId || null).catch(() => {});
}

// Ref 20: per-route middleware for the fixed set of sensitive reads (audit log,
// user lists, membership rosters). Mount AFTER the route's auth/permission
// middleware. Logs on 'finish' - i.e. after the response has been written, so a
// READ of /verify-integrity can never be part of the chain that request walked -
// and only for status < 400 (refusals stay ACCESS_DENIED only). No details: no
// response data, no query values.
function auditRead(req, res, next) {
  const ip = getClientIp(req);
  res.once('finish', () => {
    if (res.statusCode >= 400) return;
    logActivity(req.user?.id || null, `READ ${routePath(req)}`, null, req.params?.deviceId || null, ip, req.workspaceId || null).catch(() => {});
  });
  next();
}

// Express middleware to auto-log API mutations + authorization failures.
// Fire-and-forget throughout: logActivity catches its own errors, and res.json()
// must stay synchronous (it's a monkey-patched override called by every route
// handler) - the write landing after the response is sent is fine, this is
// best-effort audit logging, not part of the request's correctness.
//
// Ref 20: also logs every file download (any method - POST /api/reports/custom/export
// is one) centrally via a single 'close' listener; see logExport above.
function activityLogger(req, res, next) {
  // IP captured now: by 'close' on an aborted download the socket is already
  // destroyed and req.ip is gone.
  const ip = getClientIp(req);
  res.once('close', () => logExport(req, res, ip));
  const originalJson = res.json.bind(res);
  res.json = function(data) {
    const isMutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
    const path = routePath(req);

    if (isMutation && res.statusCode < 400) {
      // Successful mutation — the audit trail of what changed.
      const deviceId = req.params?.id || req.params?.deviceId || req.body?.device_id;
      logActivity(req.user?.id, `${req.method} ${path}`, summarizeAction(req), deviceId, getClientIp(req), req.workspaceId || null).catch(() => {});
    } else if (res.statusCode === 403) {
      // Ref 17 (RFP: "authorization failures"): a denied request is a security
      // event in its own right. Record the ATTEMPT only - who, which route, from
      // where - plus the server's own refusal reason. Never the request body, so
      // no submitted values (credentials included) can land in the log.
      const reason = typeof data?.error === 'string' ? data.error.slice(0, 200) : null;
      logActivity(req.user?.id || null, `ACCESS_DENIED ${req.method} ${path}`, reason, req.params?.id || req.params?.deviceId || null, getClientIp(req), req.workspaceId || null).catch(() => {});
    }
    return originalJson(data);
  };
  next();
}

function summarizeAction(req) {
  const parts = [];
  if (req.body?.name) parts.push(`name: ${req.body.name}`);
  if (req.body?.filename) parts.push(`file: ${req.body.filename}`);
  if (req.body?.pairing_code) parts.push('device paired');
  if (req.body?.plan_id) parts.push(`plan: ${req.body.plan_id}`);
  if (req.file?.originalname) parts.push(`uploaded: ${req.file.originalname}`);
  return parts.join(', ') || null;
}

module.exports = { logActivity, getActivity, pruneActivityLog, activityLogger, auditRead, getClientIp };
