'use strict';

// Ref 28 (Extensibility & integrations - separate from the Android offline-
// resilience Ref 28): the S3-compatible data-platform export connector.
//
// In-process against the real MySQL (same pattern as report-digest.test.js):
// seeds one org with two disposable workspaces, a device each, and play_logs /
// device_usage_daily / outage_history / tickets / sim_inventory rows on a FIXED
// timeline (T0), then:
//   - unit-tests formatNdjson + exportObjectKey
//   - drives buildExportBatches directly (every domain, windowing, workspace
//     isolation, the reused ticketRow / simRow shapes)
//   - drives the sweep (runDataPlatformExport) with a fake S3 client that
//     records putObject calls, asserting the key layout, gzip, that a watermark
//     only advances after a successful write, that one workspace's S3 failure
//     doesn't stop the sweep for the other, and the run-now overlap guard.
// The sweep is always restricted to this file's two workspaces (workspaceIds),
// so it never touches other rows in the shared test database.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const { db } = require('../db/database');
const lib = require('../lib/data-platform-export');
const svc = require('../services/data-platform-export');

const RID = 'DPE-' + crypto.randomBytes(4).toString('hex');
const id = (s) => `${RID}-${s}`;

// 2026-06-10 12:00:00 UTC
const T0 = Date.UTC(2026, 5, 10, 12) / 1000;
const WS1 = id('ws1');
const WS2 = id('ws2');
const D1 = id('d1');
const D2 = id('d2');

before(async () => {
  await db.prepare('INSERT INTO users (id, email, name) VALUES (?, ?, ?)').run(id('u-owner'), `${RID}-owner@test.local`, 'Owner');
  await db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run(id('org'), `${RID} Org`, id('u-owner'));
  await db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run(WS1, id('org'), `${RID} WS One`);
  await db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run(WS2, id('org'), `${RID} WS Two`);
  await db.prepare('INSERT INTO devices (id, workspace_id, name, status) VALUES (?, ?, ?, ?)').run(D1, WS1, `${RID} Device 1`, 'online');
  await db.prepare('INSERT INTO devices (id, workspace_id, name, status) VALUES (?, ?, ?, ?)').run(D2, WS2, `${RID} Device 2`, 'offline');

  const play = (dev, at, name) =>
    db.prepare('INSERT INTO play_logs (device_id, content_name, started_at, ended_at, duration_sec, completed) VALUES (?, ?, ?, ?, ?, 1)')
      .run(dev, name, at, at + 30, 30);
  await play(D1, T0 - 3600, 'Promo "A"\nline two'); // quote + newline: must stay one NDJSON line
  await play(D1, T0 - 1800, 'Promo B');
  await play(D1, T0 + 1800, 'Promo C'); // after T0 - lands in a LATER window only
  await play(D2, T0 - 3600, 'WS2 Promo');

  // uptime: 06-09 is a complete day before T0; 06-10 (T0's own day) is still accruing.
  const usage = (dev, day, secs) =>
    db.prepare('INSERT INTO device_usage_daily (device_id, day, online_seconds) VALUES (?, ?, ?)').run(dev, day, secs);
  await usage(D1, '2026-06-09', 43200);
  await usage(D1, '2026-06-10', 3600);

  await db
    .prepare('INSERT INTO outage_history (device_id, workspace_id, started_at, ended_at, duration_seconds, likely_cause) VALUES (?, ?, ?, ?, ?, ?)')
    .run(D1, WS1, T0 - 1200, T0 - 600, 600, 'power');

  await db
    .prepare("INSERT INTO tickets (id, workspace_id, device_id, title, created_at, updated_at) VALUES (?, ?, ?, 'Screen dark', ?, ?)")
    .run(id('t1'), WS1, D1, T0 - 200, T0 - 100);
  await db
    .prepare("INSERT INTO sim_inventory (id, workspace_id, iccid, carrier, status, created_at, updated_at) VALUES (?, ?, ?, 'Vodafone', 'in_stock', ?, ?)")
    .run(id('s1'), WS1, `${RID}-iccid-1`, T0 - 200, T0 - 100);
});

after(async () => {
  await db.prepare('DELETE FROM app_settings WHERE `key` LIKE ?').run(`data_platform_export_%:${RID}-%`);
  await db.prepare('DELETE FROM tickets WHERE workspace_id IN (?, ?)').run(WS1, WS2);
  await db.prepare('DELETE FROM sim_inventory WHERE workspace_id IN (?, ?)').run(WS1, WS2);
  await db.prepare('DELETE FROM outage_history WHERE device_id IN (?, ?)').run(D1, D2);
  await db.prepare('DELETE FROM play_logs WHERE device_id IN (?, ?)').run(D1, D2);
  await db.prepare('DELETE FROM device_usage_daily WHERE device_id IN (?, ?)').run(D1, D2);
  await db.prepare('DELETE FROM devices WHERE id IN (?, ?)').run(D1, D2);
  await db.prepare('DELETE FROM organizations WHERE id = ?').run(id('org')); // cascades workspaces
  await db.prepare('DELETE FROM users WHERE id LIKE ?').run(RID + '-%');
  await db.close();
});

// Fake S3: records every putObject; `failWhen(params)` returning true throws
// instead (simulating a rejected write), and nothing is recorded for it.
function fakeS3(failWhen = () => false) {
  const puts = [];
  const failed = [];
  return {
    puts,
    failed,
    async putObject(params) {
      if (failWhen(params)) {
        failed.push(params.Key);
        throw new Error('simulated S3 AccessDenied');
      }
      puts.push(params);
      return { ETag: '"fake"' };
    },
  };
}

const gunzipLines = (body) => zlib.gunzipSync(body).toString('utf8').trim().split('\n').map((l) => JSON.parse(l));
const watermark = async (ws, domain) => {
  const r = await db.prepare('SELECT value FROM app_settings WHERE `key` = ?').get(svc.watermarkKey(ws, domain));
  return r ? Number(r.value) : null;
};
const lastError = async (ws) => {
  const r = await db.prepare('SELECT value FROM app_settings WHERE `key` = ?').get(svc.lastErrorKey(ws));
  return r ? JSON.parse(r.value) : null;
};
const byDomain = (batches) => Object.fromEntries(batches.map((b) => [b.domain, b]));

// ---- formatNdjson / exportObjectKey ------------------------------------------

test('formatNdjson: one JSON object per line, trailing newline, embedded newlines escaped', () => {
  assert.equal(lib.formatNdjson([]), '');
  assert.equal(lib.formatNdjson(null), '');
  const out = lib.formatNdjson([{ a: 1, s: 'x\ny "q"' }, { a: 2, s: null }]);
  assert.ok(out.endsWith('\n'));
  const lines = out.split('\n').filter(Boolean);
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]), { a: 1, s: 'x\ny "q"' });
  assert.deepEqual(JSON.parse(lines[1]), { a: 2, s: null });
});

test('exportObjectKey: <prefix><domain>/workspace_id=<id>/dt=<day>/<ts>.ndjson.gz, prefix normalized', () => {
  const expected = `beamos/proof_of_play/workspace_id=ws-1/dt=2026-06-10/${T0}.ndjson.gz`;
  assert.equal(lib.exportObjectKey('beamos/', 'proof_of_play', 'ws-1', T0), expected);
  assert.equal(lib.exportObjectKey('beamos', 'proof_of_play', 'ws-1', T0), expected);
  assert.equal(lib.exportObjectKey('/beamos/', 'proof_of_play', 'ws-1', T0), expected);
  assert.equal(lib.exportObjectKey('', 'tickets', 'ws-1', T0), `tickets/workspace_id=ws-1/dt=2026-06-10/${T0}.ndjson.gz`);
});

// ---- buildExportBatches ----------------------------------------------------------

test('buildExportBatches: every domain, windowed, workspace-scoped, in the {domain, headers, rows} shape', async () => {
  const batches = await lib.buildExportBatches(db, { workspaceId: WS1 }, { from: T0 - 2 * 86400, to: T0 });
  assert.deepEqual(batches.map((b) => b.domain), lib.EXPORT_DOMAINS);
  for (const b of batches) {
    assert.ok(Array.isArray(b.headers) && Array.isArray(b.rows), `${b.domain} has headers + rows`);
  }
  const b = byDomain(batches);

  // device: snapshot, only this workspace's device, workspace_id stamped
  assert.equal(b.device.rows.length, 1);
  assert.equal(b.device.rows[0].device_id, D1);
  assert.equal(b.device.rows[0].workspace_id, WS1);
  assert.equal(b.device.headers[0], 'workspace_id');
  assert.ok(b.device.headers.includes('device_status'));

  // proof_of_play: [from, to) - the T0+1800 play is excluded; D2's play (other workspace) never appears
  assert.equal(b.proof_of_play.rows.length, 2);
  assert.deepEqual(b.proof_of_play.rows.map((r) => r.pop_content_name).sort(), ['Promo "A"\nline two', 'Promo B']);
  for (const r of b.proof_of_play.rows) {
    assert.equal(r.device_id, D1);
    assert.equal(r.workspace_id, WS1);
    assert.ok(r.pop_started_at >= T0 - 2 * 86400 && r.pop_started_at < T0);
  }

  // uptime: only COMPLETE days before `to` (06-09), not T0's still-accruing day (06-10)
  assert.deepEqual(b.uptime.rows.map((r) => r.uptime_day), ['2026-06-09']);
  assert.equal(b.uptime.rows[0].uptime_online_seconds, 43200);

  // sla: outage completed inside the window
  assert.equal(b.sla.rows.length, 1);
  assert.equal(b.sla.rows[0].sla_outage_ended_at, T0 - 600);
  assert.equal(b.sla.rows[0].sla_outage_cause, 'power');

  // tickets: the ticketRow shape (same as GET /api/workspaces/:id/tickets)
  assert.equal(b.tickets.rows.length, 1);
  assert.equal(b.tickets.rows[0].id, id('t1'));
  assert.equal(b.tickets.rows[0].device_name, `${RID} Device 1`);
  assert.ok('response_status' in b.tickets.rows[0] && 'sla_due_at' in b.tickets.rows[0]);

  // sim_inventory: the simRow shape (same as GET /api/sim-inventory)
  assert.equal(b.sim_inventory.rows.length, 1);
  assert.equal(b.sim_inventory.rows[0].iccid, `${RID}-iccid-1`);
  assert.equal(b.sim_inventory.rows[0].carrier, 'Vodafone');
  assert.ok('assigned_device_name' in b.sim_inventory.rows[0]);
});

test('buildExportBatches: other workspace sees only its own rows', async () => {
  const b = byDomain(await lib.buildExportBatches(db, { workspaceId: WS2 }, { from: 0, to: T0 }));
  assert.deepEqual(b.device.rows.map((r) => r.device_id), [D2]);
  assert.deepEqual(b.proof_of_play.rows.map((r) => r.pop_content_name), ['WS2 Promo']);
  assert.equal(b.tickets.rows.length, 0);
  assert.equal(b.sim_inventory.rows.length, 0);
  assert.equal(b.sla.rows.length, 0);
});

test('buildExportBatches: per-domain window map; missing domains skipped; uptime window inside one day is empty', async () => {
  const batches = await lib.buildExportBatches(db, { workspaceId: WS1 }, {
    proof_of_play: { from: T0, to: T0 + 3600 },
    uptime: { from: T0, to: T0 + 3600 }, // same UTC day -> no complete day yet
  });
  assert.deepEqual(batches.map((x) => x.domain), ['uptime', 'proof_of_play']);
  const b = byDomain(batches);
  assert.deepEqual(b.proof_of_play.rows.map((r) => r.pop_content_name), ['Promo C']);
  assert.equal(b.uptime.rows.length, 0);
});

test('buildExportBatches: refuses to run without a workspace scope', async () => {
  await assert.rejects(() => lib.buildExportBatches(db, {}, { from: 0, to: T0 }), /workspaceId/);
});

// ---- sweep (fake S3) -------------------------------------------------------------

test('sweep: writes gzipped NDJSON per domain per workspace with the documented key layout, then advances watermarks', async () => {
  const s3 = fakeS3();
  const res = await svc.runDataPlatformExport(db, s3, { bucket: 'lake', prefix: 'beamos/', now: T0 * 1000, workspaceIds: [WS1, WS2] });
  assert.equal(res.ran, true);

  const ws1Keys = s3.puts.filter((p) => p.Key.includes(`workspace_id=${WS1}/`)).map((p) => p.Key).sort();
  assert.deepEqual(
    ws1Keys,
    lib.EXPORT_DOMAINS.map((d) => `beamos/${d}/workspace_id=${WS1}/dt=2026-06-10/${T0}.ndjson.gz`).sort(),
    'one object per domain (all six have rows for WS1)',
  );
  // WS2 only has a device + a play - no empty objects written for its empty domains
  const ws2Keys = s3.puts.filter((p) => p.Key.includes(`workspace_id=${WS2}/`)).map((p) => p.Key.split('/')[1]).sort();
  assert.deepEqual(ws2Keys, ['device', 'proof_of_play']);

  for (const p of s3.puts) {
    assert.equal(p.Bucket, 'lake');
    assert.equal(p.ContentType, 'application/gzip');
    assert.equal(p.Body[0], 0x1f);
    assert.equal(p.Body[1], 0x8b, 'gzip magic bytes');
  }
  const pop = s3.puts.find((p) => p.Key.startsWith(`beamos/proof_of_play/workspace_id=${WS1}/`));
  const lines = gunzipLines(pop.Body);
  assert.equal(lines.length, 2);
  assert.ok(lines.some((l) => l.pop_content_name === 'Promo "A"\nline two'));

  for (const d of lib.EXPORT_DOMAINS) {
    assert.equal(await watermark(WS1, d), T0, `WS1 ${d} watermark advanced`);
    assert.equal(await watermark(WS2, d), T0, `WS2 ${d} watermark advanced (empty window still advances)`);
  }
  assert.equal(await lastError(WS1), null);
});

test('sweep: one workspace failing its S3 write does not stop the other, and its watermark does not advance', async () => {
  const T1 = T0 + 7200;
  const s3 = fakeS3((p) => p.Key.includes(`workspace_id=${WS1}/`));
  const res = await svc.runDataPlatformExport(db, s3, { bucket: 'lake', prefix: 'beamos/', now: T1 * 1000, workspaceIds: [WS1, WS2] });
  assert.equal(res.ran, true, 'sweep itself did not throw');

  // WS1 attempted device (snapshot) + proof_of_play (the T0+1800 play) - both rejected
  assert.equal(s3.failed.length, 2);
  assert.equal(await watermark(WS1, 'proof_of_play'), T0, 'failed write -> watermark held back');
  assert.equal(await watermark(WS1, 'device'), T0);
  // domains with nothing to write in (T0, T1] still advance
  assert.equal(await watermark(WS1, 'tickets'), T1);
  const err = await lastError(WS1);
  assert.ok(err && /simulated S3/.test(err.message), 'last error recorded for WS1');
  assert.equal(res.results.find((r) => r.workspace_id === WS1).error, 'simulated S3 AccessDenied');

  // WS2 (processed AFTER WS1 failed) still exported and advanced
  assert.ok(s3.puts.some((p) => p.Key === `beamos/device/workspace_id=${WS2}/dt=2026-06-10/${T1}.ndjson.gz`));
  assert.equal(await watermark(WS2, 'device'), T1);
  assert.equal(await lastError(WS2), null);

  // Next tick with S3 healthy: WS1's held-back window is exported (nothing lost), error cleared
  const T2 = T1 + 60;
  const s3ok = fakeS3();
  await svc.runDataPlatformExport(db, s3ok, { bucket: 'lake', prefix: 'beamos/', now: T2 * 1000, workspaceIds: [WS1] });
  const pop = s3ok.puts.find((p) => p.Key.startsWith(`beamos/proof_of_play/workspace_id=${WS1}/`));
  assert.ok(pop, 'retried proof_of_play window written');
  assert.deepEqual(gunzipLines(pop.Body).map((l) => l.pop_content_name), ['Promo C']);
  assert.equal(await watermark(WS1, 'proof_of_play'), T2);
  assert.equal(await lastError(WS1), null, 'last error cleared after a clean run');
});

test('sweep: never throws when unconfigured (no bucket) - reports the error instead', async () => {
  const res = await svc.runDataPlatformExport(db, fakeS3(), { bucket: '', now: T0 * 1000, workspaceIds: [WS1] });
  assert.equal(res.ran, false);
  assert.match(res.error, /DATA_PLATFORM_S3_BUCKET/);
});

test('sweep: a second run for a workspace already mid-export is skipped, not doubled', async () => {
  let release;
  let entered;
  const inPut = new Promise((r) => { entered = r; });
  const slow = {
    puts: [],
    async putObject(p) {
      entered();
      await new Promise((r) => { release = r; });
      this.puts.push(p);
    },
  };
  const T3 = T0 + 86400; // new day -> the device snapshot at least has a row to write
  const first = svc.runDataPlatformExport(db, slow, { bucket: 'lake', now: T3 * 1000, workspaceIds: [WS2] });
  await inPut;
  const second = await svc.runDataPlatformExport(db, fakeS3(), { bucket: 'lake', now: T3 * 1000, workspaceIds: [WS2] });
  assert.equal(second.results[0].skipped, 'already running');
  release();
  const firstRes = await first;
  assert.equal(firstRes.results[0].error, null);
});

test('getExportStatus: per-domain watermarks + last error for the workspace', async () => {
  const st = await svc.getExportStatus(db, WS1);
  assert.equal(typeof st.enabled, 'boolean');
  assert.deepEqual(st.domains.map((d) => d.domain), lib.EXPORT_DOMAINS);
  const pop = st.domains.find((d) => d.domain === 'proof_of_play');
  assert.equal(typeof pop.exported_through, 'number');
  assert.equal(pop.exported_through_iso, new Date(pop.exported_through * 1000).toISOString());
  assert.equal(st.last_error, null);
});
