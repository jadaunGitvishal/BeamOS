'use strict';

// Ref 74 Stage 1: hard-coded field registry for the ad-hoc custom report
// builder. Every field's `column` is a FIXED SQL expression written into this
// file - never derived from user input. report-query-builder.js looks fields
// up by id (getField) and only ever emits the `column`/`id` values that came
// back out of this registry, so a request can never cause an arbitrary
// identifier to reach a query - same shape as routes/devices.js's
// ALLOWED_FIELDS (PUT /api/devices/:id), scaled from one table's five columns
// to a multi-table field catalog.
//
// v1 domains (Ref 74 stage 1): device info, uptime, SLA (outage history),
// proof-of-play. 'device' is 1:1 with the anchor `devices d` row and can
// combine with any other domain; the other three are many-rows-per-device
// ("detail" domains), and report-query-builder.js refuses to combine two of
// them in one request (see DETAIL_DOMAINS below) - joining two many-side
// tables off the same device would cross-join their rows and silently
// duplicate/corrupt counts and durations.

const FIELDS = [
  // --- device: devices d, 1:1 with the anchor row, always safe to combine --
  { id: 'device_id', label: 'Device ID', domain: 'device', type: 'string', column: 'd.id' },
  { id: 'device_name', label: 'Device Name', domain: 'device', type: 'string', column: 'd.name' },
  { id: 'device_status', label: 'Status', domain: 'device', type: 'string', column: 'd.status' },
  { id: 'device_blocked', label: 'Blocked', domain: 'device', type: 'boolean', column: 'd.blocked' },
  { id: 'device_manufacturer', label: 'Manufacturer', domain: 'device', type: 'string', column: 'd.manufacturer' },
  { id: 'device_model', label: 'Model', domain: 'device', type: 'string', column: 'd.model' },
  { id: 'device_android_version', label: 'Android Version', domain: 'device', type: 'string', column: 'd.android_version' },
  { id: 'device_app_version', label: 'App Version', domain: 'device', type: 'string', column: 'd.app_version' },
  { id: 'device_installed_at', label: 'Installed Date', domain: 'device', type: 'string', column: 'd.installed_at' },
  { id: 'device_warranty_expiry', label: 'Warranty Expiry', domain: 'device', type: 'string', column: 'd.warranty_expiry_date' },
  { id: 'device_created_at', label: 'Device Created', domain: 'device', type: 'date', epoch: true, column: 'd.created_at' },
  { id: 'device_last_heartbeat', label: 'Last Heartbeat', domain: 'device', type: 'date', epoch: true, column: 'd.last_heartbeat' },

  // --- uptime: device_usage_daily, one row per device per day --------------
  { id: 'uptime_day', label: 'Day', domain: 'uptime', type: 'string', column: 'du.day' },
  { id: 'uptime_online_seconds', label: 'Online Seconds', domain: 'uptime', type: 'number', column: 'du.online_seconds' },
  { id: 'uptime_pct', label: 'Uptime %', domain: 'uptime', type: 'number', column: 'ROUND(du.online_seconds * 100.0 / 86400, 1)' },

  // --- sla: outage_history, one row per COMPLETED outage --------------------
  { id: 'sla_outage_started_at', label: 'Outage Start', domain: 'sla', type: 'date', epoch: true, column: 'oh.started_at' },
  { id: 'sla_outage_ended_at', label: 'Outage End', domain: 'sla', type: 'date', epoch: true, column: 'oh.ended_at' },
  { id: 'sla_outage_duration_seconds', label: 'Outage Duration (sec)', domain: 'sla', type: 'number', column: 'oh.duration_seconds' },
  { id: 'sla_outage_cause', label: 'Likely Cause', domain: 'sla', type: 'string', column: 'oh.likely_cause' },

  // --- proof_of_play: play_logs, one row per play event ---------------------
  { id: 'pop_content_name', label: 'Content', domain: 'proof_of_play', type: 'string', column: 'pl.content_name' },
  { id: 'pop_started_at', label: 'Play Started', domain: 'proof_of_play', type: 'date', epoch: true, column: 'pl.started_at' },
  { id: 'pop_ended_at', label: 'Play Ended', domain: 'proof_of_play', type: 'date', epoch: true, column: 'pl.ended_at' },
  { id: 'pop_duration_sec', label: 'Duration (sec)', domain: 'proof_of_play', type: 'number', column: 'pl.duration_sec' },
  { id: 'pop_completed', label: 'Completed', domain: 'proof_of_play', type: 'boolean', column: 'pl.completed' },
  { id: 'pop_trigger_type', label: 'Trigger Type', domain: 'proof_of_play', type: 'string', column: 'pl.trigger_type' },
];

const FIELDS_BY_ID = new Map(FIELDS.map((f) => [f.id, f]));

// Domains that are many-rows-per-device (as opposed to 'device', which is 1:1).
const DETAIL_DOMAINS = new Set(['uptime', 'sla', 'proof_of_play']);

// The natural date column the top-level `dateRange` convenience filter binds
// to, per active detail domain ('device_created_at' when none is selected).
const DOMAIN_DATE_FIELD = {
  device: 'device_created_at',
  uptime: 'uptime_day',
  sla: 'sla_outage_started_at',
  proof_of_play: 'pop_started_at',
};

const DOMAIN_LABELS = {
  device: 'Device info',
  uptime: 'Uptime',
  sla: 'SLA status',
  proof_of_play: 'Proof-of-play',
};

function getField(id) {
  return FIELDS_BY_ID.get(id) || null;
}

// Public, frontend-safe shape: id/label/domain/type only. Never `column` -
// the raw SQL expression stays server-side.
function publicFieldList() {
  return FIELDS.map(({ id, label, domain, type }) => ({ id, label, domain, type }));
}

module.exports = {
  getField,
  publicFieldList,
  DETAIL_DOMAINS,
  DOMAIN_DATE_FIELD,
  DOMAIN_LABELS,
};
