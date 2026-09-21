'use strict';

// Ref 74 Stage 2: builds a parameterized SQL query for the ad-hoc custom
// report builder from a user's { fields, filters, dateRange } selection.
//
// Security model:
//  - Every field id (in `fields` AND in `filters`) is resolved through
//    report-fields.js's getField(id) BEFORE anything is added to the SQL
//    string. An id that isn't in the registry is rejected outright. The SQL
//    that ends up in the query (`f.column`, the SELECT alias) always comes
//    from the registry object, never from the raw string the caller sent -
//    so even though a caller "names" a column, they can only ever select
//    one of a fixed, hard-coded set of expressions.
//  - Every filter VALUE is bound as a `?` placeholder and passed down
//    db.prepare(sql).all(...params) - never string-interpolated. Matches the
//    parameterization already used everywhere else in this codebase (see
//    routes/reports.js's own start/end/device_id filters).
//  - Workspace scope is enforced with the SAME helper every other
//    workspace-scoped route uses (lib/workspace-scope.js's
//    getWorkspaceDeviceFilter), applied to the SAME anchor alias (`d` for
//    `devices`) it was written for - not a new, parallel scoping mechanism.
//  - At most one "detail" domain (uptime / sla / proof_of_play - each
//    many-rows-per-device) may be active per request. Two would require
//    joining two many-side tables off the same device row, which cross-joins
//    their rows and silently multiplies/corrupts counts and durations. This
//    is enforced BEFORE any SQL is built, across both `fields` and `filters`
//    combined (a filter-only reference to a second detail domain is refused
//    the same as a selected-column one).

const { getField, DETAIL_DOMAINS, DOMAIN_DATE_FIELD } = require('./report-fields');
const { getWorkspaceDeviceFilter } = require('./workspace-scope');

class ReportQueryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReportQueryError';
    this.statusCode = 400;
  }
}

const JOIN_SQL = {
  // Scoped on device_id alone - the outer WHERE's workspace filter on `d`
  // already confines which devices (and therefore which joined rows) are
  // reachable.
  uptime: ' LEFT JOIN device_usage_daily du ON du.device_id = d.id',
  // Extra `oh.workspace_id = d.workspace_id` is defense-in-depth: outage_history
  // carries its own workspace_id (see schema.sql), so a hypothetical
  // inconsistent row (device_id pointing cross-workspace) still can't surface.
  sla: ' LEFT JOIN outage_history oh ON oh.device_id = d.id AND oh.workspace_id = d.workspace_id',
  proof_of_play: ' LEFT JOIN play_logs pl ON pl.device_id = d.id',
};

// Operators allowed per field type - keeps e.g. LIKE off numeric/date/boolean
// columns and BETWEEN's two-value shape only where it makes sense.
const OPERATORS_BY_TYPE = {
  string: ['eq', 'neq', 'contains'],
  number: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between'],
  date: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between'],
  boolean: ['eq', 'neq'],
};

const OPERATOR_SQL = {
  eq: '=',
  neq: '!=',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
};

// Resolves a raw filter/dateRange value into the param value actually bound
// for `field`. Epoch fields (BIGINT unix-seconds columns) accept an
// ISO/'YYYY-MM-DD' string and convert it; boolean fields accept true/false/
// 1/0/'true'/'false'; everything else passes through as-is (still bound as a
// parameter, never interpolated).
function coerceValue(field, rawValue) {
  if (field.epoch) {
    const ms = new Date(rawValue).getTime();
    if (Number.isNaN(ms)) {
      throw new ReportQueryError(`invalid date value for field "${field.id}": ${JSON.stringify(rawValue)}`);
    }
    return Math.floor(ms / 1000);
  }
  if (field.type === 'boolean') {
    return rawValue === true || rawValue === 1 || rawValue === '1' || rawValue === 'true' ? 1 : 0;
  }
  return rawValue;
}

function resolveField(id, kind) {
  const field = getField(id);
  if (!field) throw new ReportQueryError(`unknown ${kind} field "${id}"`);
  return field;
}

// Determines which single detail domain (if any) a set of field defs touches,
// throwing if more than one many-rows-per-device domain is referenced.
function activeDetailDomain(fieldDefs) {
  const domains = new Set(fieldDefs.map((f) => f.domain).filter((d) => DETAIL_DOMAINS.has(d)));
  if (domains.size > 1) {
    throw new ReportQueryError(
      `cannot combine fields from multiple detail domains in one report (${[...domains].join(', ')}) - ` +
        'these are many-rows-per-device and would cross-join; run separate reports for each',
    );
  }
  return domains.size === 1 ? [...domains][0] : null;
}

// Builds { sql, params, headers, fieldIds } for the given selection, scoped to
// req's resolved workspace. `limit` caps rows returned (callers pass a small
// number for preview, a larger capped number for export).
function buildCustomReportQuery({ fields, filters, dateRange } = {}, req, { limit } = {}) {
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new ReportQueryError('at least one field is required');
  }
  if (fields.length > 25) {
    throw new ReportQueryError('too many fields selected');
  }

  const fieldDefs = fields.map((id) => resolveField(id, 'output'));

  const filterList = Array.isArray(filters) ? filters : [];
  if (filterList.length > 10) {
    throw new ReportQueryError('too many filters');
  }
  const filterDefs = filterList.map((flt) => {
    if (!flt || typeof flt !== 'object') throw new ReportQueryError('invalid filter entry');
    const field = resolveField(flt.fieldId, 'filter');
    const allowedOps = OPERATORS_BY_TYPE[field.type] || [];
    if (!allowedOps.includes(flt.operator)) {
      throw new ReportQueryError(`operator "${flt.operator}" is not allowed on field "${field.id}" (type ${field.type})`);
    }
    return { field, operator: flt.operator, value: flt.value };
  });

  // Enforce the single-detail-domain rule across BOTH selected fields and
  // filter fields - a filter referencing a second detail domain must be
  // rejected too, not just a selected output column.
  const detailDomain = activeDetailDomain([...fieldDefs, ...filterDefs.map((f) => f.field)]);

  const scope = getWorkspaceDeviceFilter(req);

  const selectList = fieldDefs.map((f) => `${f.column} AS \`${f.id}\``).join(', ');
  let sql = `SELECT ${selectList} FROM devices d`;
  if (detailDomain) sql += JOIN_SQL[detailDomain];
  sql += ' WHERE 1=1' + scope.sql;
  const params = [...scope.params];

  for (const flt of filterDefs) {
    if (flt.operator === 'between') {
      if (!Array.isArray(flt.value) || flt.value.length !== 2) {
        throw new ReportQueryError(`filter on "${flt.field.id}" needs a [from, to] value for "between"`);
      }
      sql += ` AND ${flt.field.column} BETWEEN ? AND ?`;
      params.push(coerceValue(flt.field, flt.value[0]), coerceValue(flt.field, flt.value[1]));
    } else if (flt.operator === 'contains') {
      sql += ` AND ${flt.field.column} LIKE ?`;
      params.push(`%${String(flt.value)}%`);
    } else {
      sql += ` AND ${flt.field.column} ${OPERATOR_SQL[flt.operator]} ?`;
      params.push(coerceValue(flt.field, flt.value));
    }
  }

  // Top-level dateRange convenience: binds to the active domain's natural
  // date column (devices.created_at when no detail domain is in play).
  if (dateRange && (dateRange.start || dateRange.end)) {
    const dateField = getField(DOMAIN_DATE_FIELD[detailDomain || 'device']);
    if (dateRange.start) {
      sql += ` AND ${dateField.column} >= ?`;
      params.push(coerceValue(dateField, dateRange.start));
    }
    if (dateRange.end) {
      const endValue = dateField.epoch ? `${dateRange.end}T23:59:59` : dateRange.end;
      sql += ` AND ${dateField.column} <= ?`;
      params.push(coerceValue(dateField, endValue));
    }
  }

  sql += ' ORDER BY d.name ASC';
  if (limit) {
    sql += ' LIMIT ?';
    params.push(limit);
  }

  return { sql, params, headers: fieldDefs.map((f) => f.label), fieldIds: fieldDefs.map((f) => f.id) };
}

module.exports = { buildCustomReportQuery, ReportQueryError };
