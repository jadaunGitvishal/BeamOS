const { db } = require('../db/database');
const config = require('../config');
const proxyaddr = require('proxy-addr');
const { trustedProxies } = require('../config/cloudflareIps');
const { appendEntry, appendInTx, pruneChain } = require('../lib/activity-chain');

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

// The same resolution for a Socket.IO connection: its handshake request stands in for
// req, with req.ip worked out the way Express's 'trust proxy' setting (server.js) does.
function getSocketClientIp(socket) {
  const req = socket?.request;
  const fallback = socket?.handshake?.address || null;
  if (!req || !req.socket) return fallback;
  let ip = fallback;
  try { ip = proxyaddr(req, isTrustedPeer); } catch { /* keep the handshake address */ }
  return getClientIp({ headers: req.headers, socket: req.socket, ip });
}

// Phase 2.2 writer-leak fix: activity_log rows now stamp workspace_id so
// tenant-scoped queries don't miss new events. Callers pass the workspace
// when known; the middleware below sources it from resolveTenancy. When
// workspaceId is null but a device_id is provided, fall back to the device's
// workspace - matches the backfill rule for consistency.
//
// Most callers don't await it (the response goes out first), so every write is tracked
// in pendingWrites until it settles; graceful shutdown waits for them via drainActivity
// before closing the pool, instead of losing recent rows on every restart.
//
// Arguments: (userId, action, details, deviceId, ipAddress, workspaceId, organizationId).
// Resolves true when the row was written, false when it wasn't (the error is logged);
// never rejects.
const pendingWrites = new Set();
let writesWritten = 0;
let writesFailed = 0;

function logActivity(...args) {
  const p = writeActivity(...args)
    .then((ok) => {
      if (ok) writesWritten++;
      else writesFailed++;
      return ok;
    })
    .finally(() => pendingWrites.delete(p));
  pendingWrites.add(p);
  return p;
}

// For changes that must not go unrecorded silently (revocations, removals): awaits the
// audit write and, if it failed, prints one fixed, greppable line naming the action,
// the actor and the target - ids only, never details or secrets. The change itself is
// not undone. `target` is whatever identifies the changed object (user / token / device
// id). Resolves to logActivity's true/false.
async function auditOrWarn({ userId = null, action, details = null, target = null, deviceId = null, ipAddress = null, workspaceId = null, organizationId = null }) {
  const ok = await logActivity(userId, action, details, deviceId, ipAddress, workspaceId, organizationId);
  if (!ok) console.error(`[audit] NOT AUDITED: action=${action} actor=${userId ?? 'none'} target=${target ?? 'none'}`);
  return ok;
}

// Thrown by auditInTx when the audit row can't be written. It propagates out of the
// caller's transaction (rolling the change back) to the error handler, which answers with
// its status and message (server.js: err.status / err.expose).
class AuditUnavailableError extends Error {
  constructor(cause) {
    super('Change not applied: audit unavailable');
    this.name = 'AuditUnavailableError';
    this.status = 503;
    this.expose = true;
    this.code = 'AUDIT_UNAVAILABLE';
    if (cause) this.cause = cause;
  }
}

// ============================================================================
//  auditInTx - the audit row for an access grant or a credential issuance, written
//  in the SAME transaction as the change: they commit together or roll back together.
//  On any failure it throws AuditUnavailableError, so the change is not applied and
//  the request fails with 503 AUDIT_UNAVAILABLE.
//
//  RULES for every caller:
//   1. Call it as the transaction's LAST statement before COMMIT. It locks the single
//      activity_log_chain row, which every audit write in the process waits on, so it
//      must be taken last and held only for the commit. Lock order everywhere:
//        app_locks -> target users rows -> member / target rows -> chain row.
//   2. NEVER await logActivity / auditOrWarn inside a transaction after auditInTx.
//      They write on another connection, which would wait on THIS transaction's chain
//      lock - for up to innodb_lock_wait_timeout (50s) - while holding a pool slot.
//   3. Wrap the audited transaction in db.retryOnDeadlock. Retrying is safe: the
//      audit row rolls back with the change.
//
//  Not tracked by pendingWrites / drainActivity: the write finishes with the
//  transaction (if the pool closes mid-transaction, both are rolled back).
// ============================================================================
async function auditInTx(tx, { userId = null, action, details = null, deviceId = null, ipAddress = null, workspaceId = null, organizationId = null } = {}) {
  try {
    let ws = workspaceId || null;
    if (!ws && deviceId) {
      const d = await tx.prepare('SELECT workspace_id FROM devices WHERE id = ?').get(deviceId);
      ws = d?.workspace_id || null;
    }
    return await appendInTx(tx, {
      user_id: userId || null,
      device_id: deviceId || null,
      action,
      details: details || null,
      ip_address: ipAddress || null,
      workspace_id: ws,
      organization_id: organizationId || null,
    });
  } catch (e) {
    // A deadlock victim is rethrown as-is so the caller's db.retryOnDeadlock retries the
    // whole transaction (change + audit); everything else means the audit is unavailable.
    if (e && e.code === 'ER_LOCK_DEADLOCK') throw e;
    console.error(`[audit] in-transaction write failed: action=${action} actor=${userId ?? 'none'}: ${e.message}`);
    throw new AuditUnavailableError(e);
  }
}

// Waits until no audit write is pending, or timeoutMs has passed. Writes started while
// waiting are waited for too. Returns { drained, failed, timedOut, remaining }: drained =
// writes that settled meanwhile (failed of them hit an error, already logged by
// writeActivity), remaining = still pending when it returned.
async function drainActivity(timeoutMs = 10000) {
  const written0 = writesWritten;
  const failed0 = writesFailed;
  const deadline = Date.now() + timeoutMs;
  let timer;
  try {
    while (pendingWrites.size > 0) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      await Promise.race([
        Promise.allSettled([...pendingWrites]),
        new Promise((r) => { timer = setTimeout(r, left); }),
      ]);
      clearTimeout(timer);
    }
  } finally {
    clearTimeout(timer);
  }
  const failed = writesFailed - failed0;
  const remaining = pendingWrites.size;
  return { drained: writesWritten - written0 + failed, failed, timedOut: remaining > 0, remaining };
}

// Resolves true when the row was written, false on an error (logged, never thrown).
// organizationId fills activity_log.organization_id. Like workspace_id it is stored but
// NOT covered by the hash chain (lib/activity-chain.js:30-35: an org deletion nulls it),
// so it is not tamper-evident - org-level rows also name the org in `details`.
async function writeActivity(userId, action, details = null, deviceId = null, ipAddress = null, workspaceId = null, organizationId = null) {
  try {
    let ws = workspaceId || null;
    if (!ws && deviceId) {
      const d = await db.prepare('SELECT workspace_id FROM devices WHERE id = ?').get(deviceId);
      ws = d?.workspace_id || null;
    }
    // Ref 17: every audit row goes through the chained, concurrency-safe writer.
    // Phase 1C: a deadlock victim is retried (the write is its own transaction, so a retry
    // can't double it). Without this, a row lost to a deadlock - e.g. with an org /
    // workspace cascade delete, which locks activity_log while it clears the ids - was
    // only logged; for a demotion's awaited row that meant "[audit] NOT AUDITED".
    const append = () => appendEntry(db, {
      user_id: userId || null,
      device_id: deviceId || null,
      action,
      details: details || null,
      ip_address: ipAddress || null,
      workspace_id: ws,
      organization_id: organizationId || null,
    });
    await (db.retryOnDeadlock ? db.retryOnDeadlock(append) : append());
    return true;
  } catch (e) {
    console.error('Activity log error:', e.message);
    return false;
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
// ≥365 per RFP compliance) without breaking the hash chain: lib/activity-chain.js
// pruneChain removes the id-ordered block before the first row still inside the
// window (cutoff = now - N days; a row exactly N days old is inside), records the
// checkpoint and chains an audit:pruned entry by `actingUserId`, all in one
// transaction. Returns { pruned, anchor_id, cutoff } ({ pruned: 0, cutoff } when
// nothing was old enough). Only ever invoked by the manual admin action
// DELETE /api/activity/prune; no scheduler or background sweep calls this.
async function pruneActivityLog(actingUserId = null) {
  const now = Math.floor(Date.now() / 1000);
  return pruneChain(db, {
    cutoffEpoch: now - config.auditLogRetentionDays * 86400,
    now,
    userId: actingUserId,
  });
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

module.exports = { logActivity, auditOrWarn, auditInTx, AuditUnavailableError, drainActivity, getActivity, pruneActivityLog, activityLogger, auditRead, getClientIp, getSocketClientIp };
