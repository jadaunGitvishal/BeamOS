'use strict';

// Ref 28: Extensibility & integrations - the OOTB connector for PMI's data
// platform (Snowflake / Databricks / dbt / Atlan). A separate, unrelated item
// from the earlier Android offline-resilience Ref 28 work; the PMI tracking
// sheet reuses the number.
//
// On every tick, for every workspace and every export domain (device, uptime,
// sla, proof_of_play, tickets, sim_inventory), lands the rows for the
// [watermark, now) window as ONE gzipped NDJSON object at
//   s3://<bucket>/<prefix><domain>/workspace_id=<id>/dt=<YYYY-MM-DD>/<ts>.ndjson.gz
// (key built by lib/data-platform-export.js's exportObjectKey). See
// docs/data-platform-integration.md for how each platform consumes it.
//
// Follows report-digest.js's watermark pattern: the sweep runs on setInterval and
// an app_settings watermark (UNIX_TIMESTAMP-stamped key/value) makes it idempotent
// and restart-safe. The watermark is kept per workspace AND per domain -
//   data_platform_export_through:<workspace_id>:<domain>   (epoch seconds)
// - and is advanced only after that domain's S3 write succeeds, so a failed write
// is retried with the same window on the next tick (nothing skipped), and a
// domain that did land is not re-exported because a sibling failed. An empty
// window writes no object (no hourly empty files) but still advances.
// The first export for a workspace has no watermark and backfills from epoch 0.
//
// Resilience matches scheduler.js / report-digest.js: every workspace is wrapped
// in its own try/catch - one workspace's S3 or query failure is logged, recorded
// as that workspace's last error (data_platform_export_last_error:<workspace_id>),
// and the sweep moves on. runDataPlatformExport never throws.

const { db: defaultDb } = require('../db/database');
const config = require('../config');
const { buildExportBatches, putBatch, EXPORT_DOMAINS } = require('../lib/data-platform-export');

const WATERMARK_PREFIX = 'data_platform_export_through';
const LAST_ERROR_PREFIX = 'data_platform_export_last_error';

function watermarkKey(workspaceId, domain) {
  return `${WATERMARK_PREFIX}:${workspaceId}:${domain}`;
}
function lastErrorKey(workspaceId) {
  return `${LAST_ERROR_PREFIX}:${workspaceId}`;
}

// ---- settings watermark ---------------------------------------------------

async function getSetting(db, key) {
  const row = await db.prepare('SELECT value FROM app_settings WHERE `key` = ?').get(key);
  return row ? row.value : null;
}
async function setSetting(db, key, value) {
  await db
    .prepare(
      'INSERT INTO app_settings (`key`, value, updated_at) VALUES (?, ?, UNIX_TIMESTAMP()) ' +
        'ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)',
    )
    .run(key, String(value));
}
async function deleteSetting(db, key) {
  await db.prepare('DELETE FROM app_settings WHERE `key` = ?').run(key);
}

// ---- S3 client ------------------------------------------------------------

// Adapts the AWS SDK v3 client to the { putObject(params) } shape
// lib/data-platform-export.js takes. Required lazily so an instance with the
// feature off never loads the SDK. forcePathStyle when a custom endpoint is set:
// MinIO needs it, R2 accepts it, AWS itself (no endpoint) keeps virtual-hosted.
function createS3Client(cfg = config.dataPlatformExport) {
  const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
  const client = new S3Client({
    region: cfg.region,
    ...(cfg.endpoint ? { endpoint: cfg.endpoint, forcePathStyle: true } : {}),
    ...(cfg.accessKeyId && cfg.secretAccessKey
      ? { credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey } }
      : {}),
  });
  return { putObject: (params) => client.send(new PutObjectCommand(params)) };
}

let s3Client = null;
function getS3Client() {
  if (!s3Client) s3Client = createS3Client();
  return s3Client;
}
// Test seam: swap in a fake { putObject } (and restore with null).
function __setS3Client(client) {
  s3Client = client;
}

// ---- core ---------------------------------------------------------------

// Workspaces currently mid-export. A run-now landing while the interval is
// exporting the same workspace would otherwise read the same watermarks and
// write the same window twice.
const inFlight = new Set();

async function exportWorkspace(db, s3, ws, { bucket, prefix, nowSec }) {
  const windows = {};
  for (const domain of EXPORT_DOMAINS) {
    const through = await getSetting(db, watermarkKey(ws.id, domain));
    const from = through == null ? 0 : Number(through);
    if (from < nowSec) windows[domain] = { from, to: nowSec };
  }

  const batches = await buildExportBatches(db, { workspaceId: ws.id }, windows);
  const written = [];
  let failure = null;

  for (const batch of batches) {
    try {
      if (batch.rows.length) {
        written.push({
          domain: batch.domain,
          ...(await putBatch(s3, { bucket, prefix, workspaceId: ws.id, batch, toEpoch: nowSec })),
        });
      }
      // Only reached once the object is durably in the bucket (or there was
      // nothing to write) - a thrown putObject leaves this domain's window open.
      await setSetting(db, watermarkKey(ws.id, batch.domain), nowSec);
    } catch (e) {
      console.error(`[data-platform-export] workspace ${ws.id} domain ${batch.domain} failed: ${e.message}`);
      failure = failure || { at: nowSec, domain: batch.domain, message: e.message };
    }
  }

  if (failure) {
    await setSetting(db, lastErrorKey(ws.id), JSON.stringify(failure));
  } else {
    await deleteSetting(db, lastErrorKey(ws.id));
  }
  return { workspace_id: ws.id, written, error: failure ? failure.message : null };
}

// Testable core. Pass a db handle, an S3 client ({ putObject }), and options:
//   bucket, prefix  - default config.dataPlatformExport
//   now             - fixed time (ms or Date) for tests
//   workspaceIds    - restrict to these workspaces (run-now uses [id])
// Never throws: per-workspace failures are logged + recorded and the sweep
// continues; an outer failure (e.g. the workspaces SELECT) is logged and
// returned as { error }.
async function runDataPlatformExport(db = defaultDb, s3 = null, opts = {}) {
  const cfg = config.dataPlatformExport;
  const bucket = opts.bucket || cfg.bucket;
  const prefix = opts.prefix != null ? opts.prefix : cfg.prefix;
  const nowSec = Math.floor((opts.now ? new Date(opts.now).getTime() : Date.now()) / 1000);
  const results = [];

  try {
    if (!bucket) throw new Error('DATA_PLATFORM_S3_BUCKET is not set');
    const client = s3 || getS3Client();

    let workspaces;
    if (opts.workspaceIds) {
      workspaces = [];
      for (const wsId of opts.workspaceIds) {
        const ws = await db.prepare('SELECT id, name FROM workspaces WHERE id = ?').get(wsId);
        if (ws) workspaces.push(ws);
      }
    } else {
      workspaces = await db.prepare('SELECT id, name FROM workspaces').all();
    }

    for (const ws of workspaces) {
      if (inFlight.has(ws.id)) {
        results.push({ workspace_id: ws.id, written: [], skipped: 'already running' });
        continue;
      }
      inFlight.add(ws.id);
      try {
        results.push(await exportWorkspace(db, client, ws, { bucket, prefix, nowSec }));
      } catch (e) {
        console.error(`[data-platform-export] workspace ${ws.id} failed: ${e.stack || e.message}`);
        const failure = { at: nowSec, domain: null, message: e.message };
        await setSetting(db, lastErrorKey(ws.id), JSON.stringify(failure)).catch(() => {});
        results.push({ workspace_id: ws.id, written: [], error: e.message });
      } finally {
        inFlight.delete(ws.id);
      }
    }
  } catch (e) {
    console.error(`[data-platform-export] run failed: ${e.stack || e.message}`);
    return { ran: false, error: e.message, results };
  }

  const objects = results.reduce((n, r) => n + r.written.length, 0);
  const failed = results.filter((r) => r.error).length;
  console.log(
    `[data-platform-export] tick: ${objects} object(s) written across ${results.length} workspace(s)` +
      (failed ? `, ${failed} workspace(s) with errors` : ''),
  );
  return { ran: true, results };
}

// Per-domain watermarks + the last recorded error for one workspace - the
// operational view of the export (served to workspace admins).
async function getExportStatus(db, workspaceId) {
  const cfg = config.dataPlatformExport;
  const domains = [];
  for (const domain of EXPORT_DOMAINS) {
    const through = await getSetting(db, watermarkKey(workspaceId, domain));
    const n = through == null ? null : Number(through);
    domains.push({
      domain,
      exported_through: n,
      exported_through_iso: n == null ? null : new Date(n * 1000).toISOString(),
    });
  }
  const errRaw = await getSetting(db, lastErrorKey(workspaceId));
  let lastError = null;
  if (errRaw) {
    try {
      lastError = JSON.parse(errRaw);
    } catch (_) {
      lastError = { message: errRaw };
    }
  }
  return {
    enabled: cfg.enabled,
    interval_min: cfg.intervalMin,
    location: cfg.bucket ? `s3://${cfg.bucket}/${cfg.prefix || ''}<domain>/workspace_id=${workspaceId}/` : null,
    domains,
    last_error: lastError,
  };
}

function startDataPlatformExport() {
  const cfg = config.dataPlatformExport;
  if (!cfg.enabled) return; // server.js only calls this when enabled; belt and braces.
  const interval = cfg.intervalMin * 60 * 1000;
  setInterval(() => {
    // runDataPlatformExport never throws; keep the guard as a backstop.
    runDataPlatformExport().catch((e) => console.error(`[data-platform-export] tick failed: ${e.stack || e.message}`));
  }, interval);
  console.log(
    `Data-platform export service started (every ${cfg.intervalMin} min -> s3://${cfg.bucket}/${cfg.prefix})`,
  );
}

module.exports = {
  startDataPlatformExport,
  runDataPlatformExport,
  getExportStatus,
  createS3Client,
  watermarkKey,
  lastErrorKey,
  __setS3Client,
  WATERMARK_PREFIX,
};
