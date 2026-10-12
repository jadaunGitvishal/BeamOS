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
// Real MySQL test database (beamos_test via npm test) + the real routers mounted as
// server.js mounts them (startInProcessApp: /api/devices behind bearerAuth +
// resolveTenancy; /api/workspaces behind requireAuth, per-handler canLogFieldVisit
// gate). All rows are test-owned under a per-run prefix and removed afterwards.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { db, initDb } = require("../db/database");
const { generateToken } = require("../middleware/auth");
const { startInProcessApp } = require("./helpers/inprocess-app");

const P = "HW-" + crypto.randomBytes(4).toString("hex");
const id = (s) => `${P}-${s}`;
const U_TECH = id("u-tech"), ORG = id("org-a"), WS = id("ws-a"), DEV_FULL = id("dev-full"), DEV_BLOCKED = id("dev-blocked");

let app, TOKEN;

test.before(async () => {
  await initDb();
  app = await startInProcessApp({ only: ["/api/devices", "/api/workspaces"] });

  // --- fixtures ---------------------------------------------------------------
  await db.prepare("INSERT INTO users (id, email, role) VALUES (?, ?, 'user')").run(U_TECH, `${U_TECH.toLowerCase()}@t.test`);
  await db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (?, 'Org A', ?)").run(ORG, U_TECH);
  // org-wide field_technician: no workspace membership anywhere.
  await db.prepare("INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'field_technician')").run(ORG, U_TECH);
  await db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, 'Store A')").run(WS, ORG);

  // dev-full: a Device-Owner-enrolled device that captured everything, including
  // the privileged MAC + serial.
  await db.prepare(`INSERT INTO devices
    (id, workspace_id, name, status, device_token, manufacturer, model, display_size_inches,
     mac_address, serial_number, sim_iccid, sim_provider, sim_network_status, hardware_captured_at)
    VALUES (?, ?, 'Front Window', 'online', 'SECRET-WS-TOKEN', 'Samsung', 'SM-T500', 10.4,
     'A1:B2:C3:D4:E5:F6', 'R52T900ABCD', '8991000012345678901', 'Airtel', 'READY', 111)`).run(DEV_FULL, WS);

  // dev-blocked: MAC + serial blocked (no Device Owner), no cellular radio at all.
  await db.prepare(`INSERT INTO devices
    (id, workspace_id, name, status, device_token, manufacturer, model, display_size_inches,
     mac_address, serial_number, sim_iccid, sim_provider, sim_network_status, hardware_captured_at)
    VALUES (?, ?, 'Back Room', 'offline', 'SECRET-2', 'Lenovo', 'TB-X306F', 10.1,
     'unavailable (requires Device Owner)', 'unavailable (requires Device Owner)',
     'no SIM hardware', 'no SIM hardware', 'NO_TELEPHONY', 222)`).run(DEV_BLOCKED, WS);

  TOKEN = generateToken({ id: U_TECH, email: `${U_TECH.toLowerCase()}@t.test`, role: "user" }, WS); // technician already switched into the workspace
});

// Only this file's rows: its devices (cascading their field visits + photos), its org
// (cascading the workspace + membership), its user. Audit rows are kept (hash chain).
test.after(async () => {
  try {
    if (app) {
      await db.prepare("DELETE FROM devices WHERE id IN (?, ?)").run(DEV_FULL, DEV_BLOCKED);
      await db.prepare("DELETE FROM organizations WHERE id = ?").run(ORG);
      await db.prepare("DELETE FROM users WHERE id = ?").run(U_TECH);
    }
  } finally {
    if (app) await app.stop(); else await db.close();
  }
});

const call = (method, p, body) =>
  fetch(app.base + p, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

// ============================================================================

test("GET /api/devices delivers every hardware field the Completion Form pre-fills - and never device_token", async () => {
  const res = await call("GET", "/api/devices");
  assert.equal(res.status, 200);
  const list = await res.json();
  const full = list.find((d) => d.id === DEV_FULL);
  const blocked = list.find((d) => d.id === DEV_BLOCKED);
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
  const started = await call("POST", `/api/workspaces/${WS}/field-visits`, {
    device_id: DEV_FULL,
    visit_type: "Routine check",
    client_visit_uuid: `${P}-hw-prefill-${Date.now()}`,
  });
  assert.equal(started.status, 201);
  const visit = await started.json();

  // The form would pre-fill mac_address from the device but leave serial_number
  // empty. The technician keeps the pre-filled MAC, hand-types the serial, and
  // corrects the model.
  const patched = await call("PATCH", `/api/workspaces/${WS}/field-visits/${visit.id}`, {
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
  const row = await db.prepare("SELECT serial_number, device_model FROM field_visits WHERE id = ?").get(visit.id);
  assert.equal(row.serial_number, "SN-STICKER-9931");
  assert.equal(row.device_model, "Samsung SM-T500 (Wi-Fi)");
});
