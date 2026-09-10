// Ref 43 (+ Ref 31): the pure mapping that turns a GET /api/devices row into
// default values for the four technical inputs on the field-tech Completion
// Form. Covers the exact marker strings the Android side (DeviceInfo.kt
// getHardwareInfo) emits for fields it can't read in software.

import test from "node:test";
import assert from "node:assert/strict";

import { realHw, hardwarePrefill } from "../../frontend/field-tech-src/src/lib/hardware-prefill.js";

test("realHw keeps genuine values, drops null / blank / every honest marker", () => {
  assert.equal(realHw("SN-48210-A"), "SN-48210-A");
  assert.equal(realHw("  AA:BB:CC:DD:EE:FF  "), "AA:BB:CC:DD:EE:FF");

  assert.equal(realHw(null), "");
  assert.equal(realHw(undefined), "");
  assert.equal(realHw(""), "");
  assert.equal(realHw("   "), "");

  // markers straight out of telemetry/DeviceInfo.kt
  assert.equal(realHw("unavailable"), "");
  assert.equal(realHw("unavailable (requires Device Owner)"), "");
  assert.equal(realHw("no SIM"), "");
  assert.equal(realHw("no SIM hardware"), "");
  assert.equal(realHw("NO_TELEPHONY"), "");
  assert.equal(realHw("unknown"), ""); // Build.MANUFACTURER/MODEL fallback

  // "unknown" only as a whole word - a real model literally named "Unknown X" stays
  assert.equal(realHw("Unknown Device X"), "Unknown Device X");
});

test("hardwarePrefill: a fully-captured device pre-fills all four inputs", () => {
  const device = {
    manufacturer: "Samsung",
    model: "SM-T500",
    mac_address: "A1:B2:C3:D4:E5:F6",
    serial_number: "R52T900ABCD",
    sim_provider: "Airtel",
    sim_network_status: "READY",
  };
  assert.deepEqual(hardwarePrefill(device), {
    serial_number: "R52T900ABCD",
    mac_address: "A1:B2:C3:D4:E5:F6",
    device_model: "Samsung SM-T500",
    sim_network_info: "Airtel · SIM ready",
  });
});

test("hardwarePrefill: a non-Device-Owner tablet with no SIM leaves the blocked inputs empty", () => {
  // Exactly what a regular (non-DPC) Android build reports: make/model fine,
  // MAC + serial blocked, no cellular radio at all.
  const device = {
    manufacturer: "Lenovo",
    model: "TB-X306F",
    mac_address: "unavailable (requires Device Owner)",
    serial_number: "unavailable (requires Device Owner)",
    sim_provider: "no SIM hardware",
    sim_network_status: "NO_TELEPHONY",
  };
  assert.deepEqual(hardwarePrefill(device), {
    serial_number: "",
    mac_address: "",
    device_model: "Lenovo TB-X306F",
    sim_network_info: "",
  });
});

test("hardwarePrefill: partial data - carrier known, SIM not READY -> just the carrier", () => {
  assert.equal(
    hardwarePrefill({ sim_provider: "Vodafone Idea", sim_network_status: "ABSENT" }).sim_network_info,
    "Vodafone Idea",
  );
});

test("hardwarePrefill: an old APK that never sent a hardware block (all NULL) pre-fills nothing", () => {
  const device = { id: "d1", name: "Lobby", manufacturer: null, model: null, mac_address: null, serial_number: null, sim_provider: null, sim_network_status: null };
  assert.deepEqual(hardwarePrefill(device), {
    serial_number: "", mac_address: "", device_model: "", sim_network_info: "",
  });
});

test("hardwarePrefill: missing / non-object device is safe", () => {
  const empty = { serial_number: "", mac_address: "", device_model: "", sim_network_info: "" };
  assert.deepEqual(hardwarePrefill(undefined), empty);
  assert.deepEqual(hardwarePrefill(null), empty);
  assert.deepEqual(hardwarePrefill("nope"), empty);
});

test("hardwarePrefill: manufacturer 'unknown' is dropped but a real model still fills the input", () => {
  assert.equal(hardwarePrefill({ manufacturer: "unknown", model: "BeamBox 3" }).device_model, "BeamBox 3");
});
