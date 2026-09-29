'use strict';

// Ref 28 (Extensibility & integrations - Snowflake / Databricks / dbt / Atlan):
// builds the per-workspace export batches that services/data-platform-export.js
// lands in an S3-compatible object store as gzipped newline-delimited JSON.
//
// NOTE on the number: this is a separate, unrelated Ref 28 from the earlier
// Android offline-resilience Ref 28 work - the PMI tracking sheet reuses the
// ID for this server-side data-platform integration item. Neither is renamed.
//
// Nothing here writes new SQL for data BeamOS already knows how to query:
//   - device / uptime / sla / proof_of_play go through Ref 74's
//     buildCustomReportQuery (lib/report-query-builder.js), selecting every
//     registry field of the domain (lib/report-fields.js) - so the export is
//     workspace-scoped by the same getWorkspaceDeviceFilter every report uses,
//     and a field added to the registry flows into the export automatically.
//   - tickets reuse lib/ticket-query.js's TICKET_SELECT + ticketRow (the shape
//     GET /api/workspaces/:id/tickets and the Ref 73 token API return).
//   - sim_inventory reuses lib/sim-query.js's SIM_SELECT + simRow (the shape
//     GET /api/sim-inventory returns).
//
// Windowing (all epoch seconds, [from, to) half-open, per domain):
//   - device:        full snapshot of the workspace's devices every export
//                    (1:1 per device, no event time - downstream keeps the
//                    latest file, or history of snapshots, as it prefers).
//   - uptime:        whole UTC days d with ymd(from) <= d < ymd(to). A day's
//                    device_usage_daily row is still accruing until the day
//                    ends, so each day is exported exactly once, after it's over.
//   - sla:           outages whose ended_at falls in the window (outage_history
//                    rows only exist once an outage has completed).
//   - proof_of_play: plays whose started_at falls in the window.
//   - tickets / sim_inventory: rows whose updated_at falls in the window - a
//                    change log; downstream dedupes on `id`, latest updated_at.
//
// The S3 client is injected (anything with putObject(params) -> Promise), so
// this module never requires the AWS SDK and is unit-testable with a fake.

const zlib = require('zlib');
const { buildCustomReportQuery } = require('./report-query-builder');
const { publicFieldList } = require('./report-fields');
const { TICKET_SELECT, ticketRow } = require('./ticket-query');
const { SIM_SELECT, simRow } = require('./sim-query');

const REPORT_DOMAINS = ['device', 'uptime', 'sla', 'proof_of_play'];
const EXPORT_DOMAINS = [...REPORT_DOMAINS, 'tickets', 'sim_inventory'];

// ---- formatting --------------------------------------------------------------

// One JSON object per line, trailing newline - the ingestion format Snowflake's
// COPY INTO (TYPE = JSON), Databricks Auto Loader (cloudFiles.format = json)
// and dbt external sources all read natively. Empty input -> empty string.
function formatNdjson(rows) {
  if (!rows || !rows.length) return '';
  return rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

// ---- date helpers (UTC) ------------------------------------------------------

function ymd(epochSec) {
  return new Date(epochSec * 1000).toISOString().slice(0, 10);
}
function iso(epochSec) {
  return new Date(epochSec * 1000).toISOString();
}
function prevDay(dayStr) {
  return ymd(Date.parse(dayStr + 'T00:00:00Z') / 1000 - 86400);
}

// ---- batch builders ----------------------------------------------------------

// Every registry field of `domain`, led by the device identity columns so a
// detail row can be joined back to its device downstream.
function domainFieldIds(domain) {
  const own = publicFieldList().filter((f) => f.domain === domain).map((f) => f.id);
  return domain === 'device' ? own : ['device_id', 'device_name', ...own];
}

// Selection passed to buildCustomReportQuery for one report domain's window,
// or null when the window can't contain any rows (e.g. uptime before a day
// boundary has passed).
function reportSelection(domain, { from, to }) {
  const fields = domainFieldIds(domain);
  switch (domain) {
    case 'device':
      return { fields };
    case 'uptime': {
      const start = ymd(from);
      const end = prevDay(ymd(to)); // last COMPLETE day before `to`
      if (end < start) return null;
      return { fields, dateRange: { start, end } };
    }
    case 'sla':
      return {
        fields,
        filters: [
          { fieldId: 'sla_outage_ended_at', operator: 'gte', value: iso(from) },
          { fieldId: 'sla_outage_ended_at', operator: 'lt', value: iso(to) },
        ],
      };
    case 'proof_of_play':
      return {
        fields,
        filters: [
          { fieldId: 'pop_started_at', operator: 'gte', value: iso(from) },
          { fieldId: 'pop_started_at', operator: 'lt', value: iso(to) },
        ],
      };
    default:
      throw new Error(`not a report domain: ${domain}`);
  }
}

async function buildReportBatch(db, scope, domain, window) {
  const selection = reportSelection(domain, window);
  const fieldIds = domainFieldIds(domain);
  if (!selection) return { domain, headers: fieldIds, rows: [] };
  const { sql, params } = buildCustomReportQuery(selection, scope);
  const rows = await db.prepare(sql).all(...params);
  // Stamp workspace_id on every row: the device-anchored report fields don't
  // carry it, and a warehouse table unioned across workspaces needs it.
  return {
    domain,
    headers: ['workspace_id', ...fieldIds],
    rows: rows.map((r) => ({ workspace_id: scope.workspaceId, ...r })),
  };
}

async function buildTicketBatch(db, scope, { from, to }) {
  const rows = await db
    .prepare(`${TICKET_SELECT} WHERE t.workspace_id = ? AND t.updated_at >= ? AND t.updated_at < ? ORDER BY t.updated_at ASC`)
    .all(scope.workspaceId, from, to);
  const out = rows.map((t) => ticketRow(t, to));
  return { domain: 'tickets', headers: out.length ? Object.keys(out[0]) : [], rows: out };
}

async function buildSimBatch(db, scope, { from, to }) {
  const rows = await db
    .prepare(`${SIM_SELECT} WHERE s.workspace_id = ? AND s.updated_at >= ? AND s.updated_at < ? ORDER BY s.updated_at ASC`)
    .all(scope.workspaceId, from, to);
  const out = rows.map(simRow);
  return { domain: 'sim_inventory', headers: out.length ? Object.keys(out[0]) : [], rows: out };
}

function buildDomainBatch(db, scope, domain, window) {
  if (REPORT_DOMAINS.includes(domain)) return buildReportBatch(db, scope, domain, window);
  if (domain === 'tickets') return buildTicketBatch(db, scope, window);
  if (domain === 'sim_inventory') return buildSimBatch(db, scope, window);
  throw new Error(`unknown export domain: ${domain}`);
}

// Pulls every export domain for one workspace.
//   scope   - req-like { workspaceId } (what getWorkspaceDeviceFilter reads)
//   windows - either one { from, to } applied to every domain, or a per-domain
//             map { [domain]: { from, to } } (the service passes the latter,
//             since each domain has its own watermark). Domains missing from a
//             per-domain map are skipped.
// Returns [{ domain, headers, rows }, ...] in EXPORT_DOMAINS order.
async function buildExportBatches(db, scope, windows) {
  if (!scope || !scope.workspaceId) throw new Error('buildExportBatches requires a workspaceId scope');
  const single = windows && typeof windows.from === 'number' && typeof windows.to === 'number';
  const batches = [];
  for (const domain of EXPORT_DOMAINS) {
    const window = single ? windows : windows && windows[domain];
    if (!window) continue;
    batches.push(await buildDomainBatch(db, scope, domain, window));
  }
  return batches;
}

// ---- landing -----------------------------------------------------------------

// <prefix>/<domain>/workspace_id=<id>/dt=<YYYY-MM-DD>/<ts>.ndjson.gz - Hive-style
// partition segments, which Databricks Auto Loader turns into columns and
// Snowflake can read from METADATA$FILENAME. dt/ts are the window END (UTC).
function exportObjectKey(prefix, domain, workspaceId, toEpoch) {
  let p = String(prefix || '').replace(/^\/+/, '');
  if (p && !p.endsWith('/')) p += '/';
  return `${p}${domain}/workspace_id=${workspaceId}/dt=${ymd(toEpoch)}/${toEpoch}.ndjson.gz`;
}

// Gzips a batch's NDJSON and writes it through the injected client. Returns
// { key, rows, bytes }. No ContentEncoding header on purpose: the object IS a
// .gz file (Snowflake/Databricks detect it by extension / COMPRESSION = GZIP);
// Content-Encoding: gzip would make some HTTP clients transparently inflate it.
async function putBatch(s3, { bucket, prefix, workspaceId, batch, toEpoch }) {
  if (!s3 || typeof s3.putObject !== 'function') throw new Error('an S3 client with putObject(params) is required');
  const key = exportObjectKey(prefix, batch.domain, workspaceId, toEpoch);
  const body = zlib.gzipSync(Buffer.from(formatNdjson(batch.rows), 'utf8'));
  await s3.putObject({ Bucket: bucket, Key: key, Body: body, ContentType: 'application/gzip' });
  return { key, rows: batch.rows.length, bytes: body.length };
}

module.exports = {
  formatNdjson,
  buildExportBatches,
  buildDomainBatch,
  domainFieldIds,
  exportObjectKey,
  putBatch,
  EXPORT_DOMAINS,
};
