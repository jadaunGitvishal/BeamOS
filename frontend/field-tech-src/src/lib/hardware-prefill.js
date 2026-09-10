// Ref 31 + Ref 43: the device reports its own hardware identity once at pairing
// time, and GET /api/devices carries it straight through to this app —
// manufacturer / model / mac_address / serial_number / sim_provider /
// sim_network_status are all present on each device row (only `device_token` is
// stripped server-side). This maps that row onto the four technical text inputs
// on the visit Completion Form so the technician confirms/corrects rather than
// types from memory.
//
// The Android side (telemetry/DeviceInfo.kt) never sends a blank: a field it
// can't read in software comes through as an honest marker string —
// "unavailable (requires Device Owner)" (serial / MAC on a non–Device-Owner
// device), "unavailable", "no SIM" / "no SIM hardware", "NO_TELEPHONY",
// "unknown". Those are NOT real data, so we treat them as absent and leave that
// specific input empty for the technician to fill in by hand (e.g. reading a
// serial off a sticker on the physical device).

const HW_MARKER = /^(unavailable|no sim|no_telephony|unknown$)/i;

// One captured value -> a real string, or "" when it's null / blank / a marker.
export function realHw(v) {
  if (v === null || v === undefined) return "";
  const s = String(v).trim();
  return !s || HW_MARKER.test(s) ? "" : s;
}

// A device row (from GET /api/devices) -> default values for the four technical
// inputs: { serial_number, mac_address, device_model, sim_network_info }.
// Every field is either a genuinely-captured value or "" (never a marker).
export function hardwarePrefill(device) {
  const empty = { serial_number: "", mac_address: "", device_model: "", sim_network_info: "" };
  if (!device || typeof device !== "object") return empty;

  const make = realHw(device.manufacturer);
  const model = realHw(device.model);
  const provider = realHw(device.sim_provider);
  const simStatus = realHw(device.sim_network_status);
  // sim_network_status also carries non-carrier states (ABSENT, UNKNOWN, …) that
  // aren't useful as "network info" — only surface it when a SIM is READY.
  const sim = [provider, /^ready$/i.test(simStatus) ? "SIM ready" : ""].filter(Boolean).join(" · ");

  return {
    serial_number: realHw(device.serial_number),
    mac_address: realHw(device.mac_address),
    device_model: [make, model].filter(Boolean).join(" "),
    sim_network_info: sim,
  };
}
