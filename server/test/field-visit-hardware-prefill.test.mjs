// Ref 43 (+ Ref 31): the field-tech Completion Form pre-fills its four technical
// inputs from the device's already-captured hardware info. This proves the data
// path the frontend depends on:
//
//   1. GET /api/devices (the VisitFlow device picker) delivers
//      manufacturer / model / mac_address / serial_number / sim_provider /
//      sim_network_status to the caller verbatim - nothing strips them the way
//      device_token is deliberately stripped.
//   2. A technician's manual override of a pre-filled field is still saved by
//      PATCH /api/workspaces/:id/field-visits/:visitId (fields stay editable).
//
// In-memory sqlite + the real routers, mounted as server.js mounts them
// (/api/devices: requireAuth + resolveTenancy; /api/workspaces: requireAuth,
// per-handler canLogFieldVisit gate).

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
process.env.JWT_SECRET = "test-secret-hw-prefill";

const Database = require("better-sqlite3");
const db = new Database(":memory:");
db.function("UNIX_TIMESTAMP", () => Math.floor(Date.now() / 1000));

db.exec(`
  CREATE TABLE users (
    id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT DEFAULT '',
    password_hash TEXT, auth_provider TEXT NOT NULL DEFAULT 'local', avatar_url TEXT,
    role TEXT NOT NULL DEFAULT 'user', plan_id TEXT DEFAULT 'free', email_alerts INTEGER DEFAULT 1,
    must_change_password INTEGER NOT NULL DEFAULT 0, phone TEXT UNIQUE, last_login INTEGER
  );
  CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_user_id TEXT NOT NULL);
  CREATE TABLE organization_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT, organization_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL
  );
  CREATE TABLE workspaces (
    id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, name TEXT NOT NULL, updated_at INTEGER DEFAULT 0
  );
  CREATE TABLE workspace_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL
  );
  CREATE TABLE devices (
    id TEXT PRIMARY KEY, workspace_id TEXT, user_id TEXT, name TEXT DEFAULT 'Unnamed',
    status TEXT, sort_order INTEGER DEFAULT 0, created_at INTEGER DEFAULT 0,
    playlist_id TEXT, layout_id TEXT,
    device_token TEXT,
    manufacturer TEXT, model TEXT, display_size_inches REAL, mac_address TEXT,
    serial_number TEXT, sim_iccid TEXT, sim_provider TEXT, sim_network_status TEXT,
    hardware_captured_at INTEGER
  );
  CREATE TABLE playlist_items (id TEXT PRIMARY KEY, playlist_id TEXT, zone_id TEXT);
  CREATE TABLE layout_zones (id TEXT PRIMARY KEY, layout_id TEXT, name TEXT, sort_order INTEGER DEFAULT 0);
  CREATE TABLE device_telemetry (
    id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL,
    battery_level INTEGER, battery_charging INTEGER DEFAULT 0,
    storage_free_mb INTEGER, storage_total_mb INTEGER, ram_free_mb INTEGER, ram_total_mb INTEGER,
    cpu_usage REAL, wifi_ssid TEXT, wifi_rssi INTEGER, uptime_seconds INTEGER,
    latitude REAL, longitude REAL, reported_at INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE screenshots (id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT, filepath TEXT, captured_at INTEGER);
  CREATE TABLE field_visits (
    id TEXT PRIMARY KEY, device_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
    technician_user_id TEXT, client_visit_uuid TEXT UNIQUE,
    visit_type TEXT NOT NULL, serial_number TEXT, mac_address TEXT, device_model TEXT,
    sim_network_info TEXT, device_status TEXT, remarks TEXT, technical_metrics TEXT,
    status TEXT NOT NULL DEFAULT 'in_progress',
    created_at INTEGER NOT NULL DEFAULT 0, completed_at INTEGER
  );
  CREATE TABLE field_visit_photos (
    id TEXT PRIMARY KEY, visit_id TEXT NOT NULL, filepath TEXT NOT NULL,
    latitude REAL, longitude REAL, gps_accuracy_meters REAL, photo_category TEXT, place_name TEXT,
    captured_at INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, device_id TEXT, action TEXT,
    details TEXT, ip_address TEXT, workspace_id TEXT, created_at INTEGER DEFAULT 0
  );
`);

// Redirect the shared db module to this in-memory handle before any router loads.
const dbModulePath = require.resolve("../db/database");
require.cache[dbModulePath] = { id: dbModulePath, filename: dbModulePath, loaded: true, exports: { db } };

const express = require("express");
const { generateToken, requireAuth } = require("../middleware/auth");
const { resolveTenancy } = require("../lib/tenancy");

// --- fixtures -----------------------------------------------------------------
db.prepare("INSERT INTO users (id,email,role,phone) VALUES ('u-tech','tech@t.test','user','+15551230000')").run();
db.prepare("INSERT INTO organizations (id,name,owner_user_id) VALUES ('org-a','Org A','u-tech')").run();
// org-wide field_technician: no workspace membership anywhere.
db.prepare("INSERT INTO organization_members (organization_id,user_id,role) VALUES ('org-a','u-tech','field_technician')").run();
db.prepare("INSERT INTO workspaces (id,organization_id,name) VALUES ('ws-a','org-a','Store A')").run();

// dev-full: a Device-Owner-enrolled device that captured everything, including
// the privileged MAC + serial.
db.prepare(`INSERT INTO devices
  (id, workspace_id, name, status, device_token, manufacturer, model, display_size_inches,
   mac_address, serial_number, sim_iccid, sim_provider, sim_network_status, hardware_captured_at)
  VALUES ('dev-full','ws-a','Front Window','online','SECRET-WS-TOKEN','Samsung','SM-T500', 10.4,
   'A1:B2:C3:D4:E5:F6', 'R52T900ABCD', '8991000012345678901', 'Airtel', 'READY', 111)`).run();

// dev-blocked: MAC + serial blocked (no Device Owner), no cellular radio at all.
db.prepare(`INSERT INTO devices
  (id, workspace_id, name, status, device_token, manufacturer, model, display_size_inches,
   mac_address, serial_number, sim_iccid, sim_provider, sim_network_status, hardware_captured_at)
  VALUES ('dev-blocked','ws-a','Back Room','offline','SECRET-2','Lenovo','TB-X306F', 10.1,
   'unavailable (requires Device Owner)', 'unavailable (requires Device Owner)',
   'no SIM hardware', 'no SIM hardware', 'NO_TELEPHONY', 222)`).run();

const u = db.prepare("SELECT id,email,role FROM users WHERE id = 'u-tech'").get();
const TOKEN = generateToken(u, "ws-a"); // technician already switched into ws-a

const app = express();
app.use(express.json());
app.use("/api/devices", requireAuth, resolveTenancy, require("../routes/devices"));
app.use("/api/workspaces", requireAuth, require("../routes/workspaces"));
app.use((err, req, res, _next) => { res.status(500).json({ error: err.message, stack: err.stack }); });
const server = app.listen(0);
let base;
test.before(async () => {
  await new Promise((r) => (server.listening ? r() : server.once("listening", r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); db.close(); });

const call = (method, p, body) =>
  fetch(base + p, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

// ============================================================================

test("GET /api/devices delivers every hardware field the Completion Form pre-fills - and never device_token", async () => {
  const res = await call("GET", "/api/devices");
  assert.equal(res.status, 200);
  const list = await res.json();
  const full = list.find((d) => d.id === "dev-full");
  const blocked = list.find((d) => d.id === "dev-blocked");
  assert.ok(full && blocked, "both seeded devices came back");

  // The six fields hardwarePrefill() reads, passed straight through:
  assert.equal(full.manufacturer, "Samsung");
  assert.equal(full.model, "SM-T500");
  assert.equal(full.mac_address, "A1:B2:C3:D4:E5:F6");
  assert.equal(full.serial_number, "R52T900ABCD");
  assert.equal(full.sim_provider, "Airtel");
  assert.equal(full.sim_network_status, "READY");

  // Markers preserved verbatim - the server does not transform them; the
  // frontend (hardwarePrefill) is what blanks them out.
  assert.equal(blocked.mac_address, "unavailable (requires Device Owner)");
  assert.equal(blocked.serial_number, "unavailable (requires Device Owner)");
  assert.equal(blocked.sim_provider, "no SIM hardware");
  assert.equal(blocked.sim_network_status, "NO_TELEPHONY");

  // The one field that IS deliberately stripped stays stripped.
  assert.equal("device_token" in full, false, "device_token must never leave the server");
  assert.equal("device_token" in blocked, false);
});

test("a technician's manual override of a pre-filled field is saved on PATCH (fields stay editable)", async () => {
  // Start a visit against dev-full (whose captured serial is only the 'unavailable'
  // marker - exactly the case where the tech reads the real serial off a sticker).
  const started = await call("POST", "/api/workspaces/ws-a/field-visits", {
    device_id: "dev-full",
    visit_type: "Routine check",
    client_visit_uuid: "hw-prefill-" + Date.now(),
  });
  assert.equal(started.status, 201);
  const visit = await started.json();

  // The form would pre-fill mac_address from the device but leave serial_number
  // empty. The technician keeps the pre-filled MAC, hand-types the serial, and
  // corrects the model.
  const patched = await call("PATCH", `/api/workspaces/ws-a/field-visits/${visit.id}`, {
    mac_address: "A1:B2:C3:D4:E5:F6", // unchanged pre-fill
    serial_number: "SN-STICKER-9931", // hand-typed - was blank
    device_model: "Samsung SM-T500 (Wi-Fi)", // corrected override
    sim_network_info: "Airtel · SIM ready",
    device_status: "Working",
    status: "completed",
  });
  assert.equal(patched.status, 200);
  const done = await patched.json();
  assert.equal(done.serial_number, "SN-STICKER-9931");
  assert.equal(done.mac_address, "A1:B2:C3:D4:E5:F6");
  assert.equal(done.device_model, "Samsung SM-T500 (Wi-Fi)");
  assert.equal(done.sim_network_info, "Airtel · SIM ready");
  assert.equal(done.status, "completed");

  // Persisted, not just echoed.
  const row = db.prepare("SELECT serial_number, device_model FROM field_visits WHERE id = ?").get(visit.id);
  assert.equal(row.serial_number, "SN-STICKER-9931");
  assert.equal(row.device_model, "Samsung SM-T500 (Wi-Fi)");
});
