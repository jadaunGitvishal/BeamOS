// Ref 43 (+ Ref 31): render the real field-tech CompletionForm.jsx and confirm
// that, given a device row from GET /api/devices, the four technical <input>s
// come up pre-filled with genuine hardware values and EMPTY for values that are
// only an "unavailable …" marker - and that none of them are read-only.
//
// The .jsx is bundled on the fly with the same esbuild Vite already uses, then
// server-rendered (react-dom/server) so we can inspect the initial DOM. React
// renders a controlled <input value=""> with no value attribute, and
// value="real" as value="real", which is exactly the distinction under test.

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

const require = createRequire(import.meta.url);
const viteRequire = createRequire(require.resolve("vite"));
const esbuild = require(viteRequire.resolve("esbuild"));

const SRC = fileURLToPath(new URL("../../frontend/field-tech-src/src/screens/CompletionForm.jsx", import.meta.url));

let CompletionForm, React, renderToStaticMarkup;

test.before(async () => {
  const out = await esbuild.build({
    entryPoints: [SRC],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    jsx: "automatic",
    // Keep React external so it resolves to server/node_modules at import time
    // (same copy react-dom/server uses).
    external: ["react", "react/jsx-runtime", "react-dom"],
  });
  // Written to server/ (not test/) so `node --test` never treats it as a test
  // file, and bare `react` imports inside the bundle still resolve to
  // server/node_modules.
  const tmp = fileURLToPath(new URL("../.tmp-completion-form.mjs", import.meta.url));
  const fs = require("node:fs");
  fs.writeFileSync(tmp, out.outputFiles[0].text);
  try {
    ({ default: CompletionForm } = await import(pathToFileURL(tmp).href + "?" + Date.now()));
    React = (await import("react")).default;
    ({ renderToStaticMarkup } = await import("react-dom/server"));
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

function render(device) {
  const html = renderToStaticMarkup(
    React.createElement(CompletionForm, {
      workspaceId: "ws-a",
      visitId: "v1",
      deviceName: "Front Window",
      device,
      telemetryCaptured: false,
      onCompleted() {},
      onSessionExpired() {},
    }),
  );
  const doc = new JSDOM(html).window.document;
  const input = (id) => doc.getElementById("f-" + id);
  return { doc, input };
}

test("a fully-captured Device-Owner device pre-fills all four technical inputs", () => {
  const { input } = render({
    manufacturer: "Samsung",
    model: "SM-T500",
    mac_address: "A1:B2:C3:D4:E5:F6",
    serial_number: "R52T900ABCD",
    sim_provider: "Airtel",
    sim_network_status: "READY",
  });
  assert.equal(input("serial_number").value, "R52T900ABCD");
  assert.equal(input("mac_address").value, "A1:B2:C3:D4:E5:F6");
  assert.equal(input("device_model").value, "Samsung SM-T500");
  assert.equal(input("sim_network_info").value, "Airtel · SIM ready");

  // none of them read-only / disabled
  for (const k of ["serial_number", "mac_address", "device_model", "sim_network_info"]) {
    assert.equal(input(k).hasAttribute("readonly"), false, `${k} not readonly`);
    assert.equal(input(k).hasAttribute("disabled"), false, `${k} not disabled`);
  }
});

test("markers ('unavailable …', 'no SIM hardware', 'NO_TELEPHONY') leave that input EMPTY, not a placeholder string", () => {
  const { input } = render({
    manufacturer: "Lenovo",
    model: "TB-X306F",
    mac_address: "unavailable (requires Device Owner)",
    serial_number: "unavailable (requires Device Owner)",
    sim_provider: "no SIM hardware",
    sim_network_status: "NO_TELEPHONY",
  });
  assert.equal(input("serial_number").value, "", "serial left blank for the tech to read off the sticker");
  assert.equal(input("mac_address").value, "");
  assert.equal(input("sim_network_info").value, "");
  // make/model are genuine, so that one IS pre-filled
  assert.equal(input("device_model").value, "Lenovo TB-X306F");

  // the confusing marker text must appear NOWHERE in the rendered markup
  const markup = render({
    mac_address: "unavailable (requires Device Owner)",
    serial_number: "unavailable (requires Device Owner)",
    sim_provider: "no SIM hardware",
    sim_network_status: "NO_TELEPHONY",
  }).doc.body.innerHTML;
  assert.ok(!/unavailable/i.test(markup), "no 'unavailable' marker text rendered anywhere");
  assert.ok(!/NO_TELEPHONY/.test(markup));
  assert.ok(!/no SIM/i.test(markup));
});

test("an old APK that never reported hardware (all null) pre-fills nothing and still renders", () => {
  const { input } = render({ id: "d1", name: "Lobby" });
  for (const k of ["serial_number", "mac_address", "device_model", "sim_network_info"]) {
    assert.equal(input(k).value, "");
  }
});

test("no device prop at all is safe (inputs render, empty)", () => {
  const { input } = render(undefined);
  assert.equal(input("serial_number").value, "");
  assert.equal(input("device_model").value, "");
});
