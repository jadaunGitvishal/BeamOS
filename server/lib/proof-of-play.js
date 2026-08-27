'use strict';

// Proof-of-play "/summary" aggregation, extracted from routes/reports.js so the HTTP
// route AND the scheduled report digest (services/report-digest.js, Ref 46) run the
// exact same queries instead of two copies drifting apart.
//
// `scopeSql` is an already-built fragment like
//   " AND device_id IN (SELECT id FROM devices WHERE workspace_id = ?)"
// (or "" for no scope); `scopeParams` are its bindings. The caller owns tenancy scoping.

const { db } = require('../db/database');

async function getProofOfPlaySummary({ scopeSql = '', scopeParams = [], startEpoch, endEpoch }) {
  const params = [startEpoch, endEpoch, ...scopeParams];

  const overall = await db
    .prepare(
      `
    SELECT COUNT(*) as total_plays,
           COALESCE(SUM(duration_sec), 0) as total_duration_sec,
           COUNT(DISTINCT content_id) as unique_content,
           COUNT(DISTINCT device_id) as unique_devices,
           AVG(duration_sec) as avg_duration_sec
    FROM play_logs
    WHERE started_at >= ? AND started_at <= ? ${scopeSql}
  `,
    )
    .get(...params);

  const byContent = await db
    .prepare(
      `
    SELECT content_id, content_name, COUNT(*) as plays,
           COALESCE(SUM(duration_sec), 0) as total_seconds,
           SUM(completed) as completed_plays
    FROM play_logs
    WHERE started_at >= ? AND started_at <= ? ${scopeSql}
    GROUP BY content_id, content_name
    ORDER BY plays DESC LIMIT 50
  `,
    )
    .all(...params);

  const byDevice = await db
    .prepare(
      `
    SELECT pl.device_id, d.name as device_name, COUNT(*) as plays,
           COALESCE(SUM(pl.duration_sec), 0) as total_seconds
    FROM play_logs pl
    JOIN devices d ON pl.device_id = d.id
    WHERE pl.started_at >= ? AND pl.started_at <= ? ${scopeSql}
    GROUP BY pl.device_id
    ORDER BY plays DESC
  `,
    )
    .all(...params);

  const byHour = await db
    .prepare(
      `
    SELECT HOUR(FROM_UNIXTIME(started_at)) as hour,
           COUNT(*) as plays
    FROM play_logs
    WHERE started_at >= ? AND started_at <= ? ${scopeSql}
    GROUP BY hour ORDER BY hour
  `,
    )
    .all(...params);

  const byDay = await db
    .prepare(
      `
    SELECT DATE_FORMAT(FROM_UNIXTIME(started_at), '%Y-%m-%d') as day, COUNT(*) as plays,
           COALESCE(SUM(duration_sec), 0) as total_seconds
    FROM play_logs
    WHERE started_at >= ? AND started_at <= ? ${scopeSql}
    GROUP BY day ORDER BY day
  `,
    )
    .all(...params);

  return {
    period: {
      start: new Date(startEpoch * 1000).toISOString(),
      end: new Date(endEpoch * 1000).toISOString(),
    },
    overall: {
      total_plays: overall.total_plays,
      total_hours: Math.round((overall.total_duration_sec / 3600) * 10) / 10,
      unique_content: overall.unique_content,
      unique_devices: overall.unique_devices,
      avg_duration_sec: Math.round(overall.avg_duration_sec || 0),
    },
    by_content: byContent,
    by_device: byDevice,
    by_hour: byHour,
    by_day: byDay,
  };
}

module.exports = { getProofOfPlaySummary };
