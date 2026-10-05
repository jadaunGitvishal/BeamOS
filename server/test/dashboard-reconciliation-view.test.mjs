// Ref 49 Stage B (redesign): the Reconciliation dashboard page.
//
// Part 1 — the pure bucketing / filter helpers in
// frontend/dashboard-src/src/lib/reconciliation.js.
//
// Part 2 — the real ReconciliationView.jsx, bundled on the fly with the esbuild
// Vite already ships (same approach as completion-form-prefill.test.mjs) and
// rendered client-side under jsdom so the filter buttons and the admin form can
// be clicked. The session / toast / API / clock hooks are swapped for stubs that
// read a per-test fixture off globalThis; react, react-router-dom and recharts
// stay external so they resolve to server/node_modules.

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

import {
  staleBuckets,
  ghostAgeBuckets,
  parseReconType,
  filterRecon,
} from "../../frontend/dashboard-src/src/lib/reconciliation.js";

const require = createRequire(import.meta.url);
const viteRequire = createRequire(require.resolve("vite"));
const esbuild = require(viteRequire.resolve("esbuild"));

const DAY = 86400;
const labels = (r) => r.buckets.map((b) => b.label);
const values = (r) => r.buckets.map((b) => b.value);

// ─── Part 1: helpers ─────────────────────────────────────────────────────────

describe("staleBuckets", () => {
  test("empty / missing list -> all-zero buckets, no unknowns", () => {
    for (const list of [[], null, undefined]) {
      const r = staleBuckets(list, 14);
      assert.deepEqual(labels(r), ["14–29d", "30–89d", "90d+"]);
      assert.deepEqual(values(r), [0, 0, 0]);
      assert.equal(r.unknown, 0);
    }
  });

  test("exact range boundaries for N < 30", () => {
    const days = [14, 29, 30, 89, 90, 400];
    const r = staleBuckets(days.map((d) => ({ days_since_heartbeat: d })), 14);
    assert.deepEqual(values(r), [2, 2, 2]);
  });

  test("null / missing days are counted as unknown, not bucketed", () => {
    const r = staleBuckets([{ days_since_heartbeat: null }, {}, { days_since_heartbeat: 45 }], 14);
    assert.deepEqual(values(r), [0, 1, 0]);
    assert.equal(r.unknown, 2);
  });

  test("N = 29 -> single-day first range, no overlap", () => {
    const r = staleBuckets([{ days_since_heartbeat: 29 }, { days_since_heartbeat: 30 }], 29);
    assert.deepEqual(labels(r), ["29d", "30–89d", "90d+"]);
    assert.deepEqual(values(r), [1, 1, 0]);
  });

  test("30 <= N < 90 drops the 30–89 range and starts at N", () => {
    const r = staleBuckets([30, 45, 89, 90].map((d) => ({ days_since_heartbeat: d })), 30);
    assert.deepEqual(labels(r), ["30–89d", "90d+"]);
    assert.deepEqual(values(r), [3, 1]);
    assert.deepEqual(labels(staleBuckets([], 60)), ["60–89d", "90d+"]);
  });

  test("N >= 90 -> one open range", () => {
    const r = staleBuckets([{ days_since_heartbeat: 90 }, { days_since_heartbeat: 120 }], 90);
    assert.deepEqual(labels(r), ["90d+"]);
    assert.deepEqual(values(r), [2]);
    assert.deepEqual(labels(staleBuckets([], 120)), ["120d+"]);
  });

  test("a value below N is clamped into the first range rather than dropped", () => {
    const r = staleBuckets([{ days_since_heartbeat: 3 }], 14);
    assert.deepEqual(values(r), [1, 0, 0]);
  });
});

describe("ghostAgeBuckets", () => {
  const now = 1_800_000_000;
  const ago = (d) => ({ registered_at: now - d * DAY });

  test("empty / missing list -> all-zero buckets", () => {
    for (const list of [[], null, undefined]) {
      const r = ghostAgeBuckets(list, now);
      assert.deepEqual(labels(r), ["<7d", "7–29d", "30–89d", "90d+"]);
      assert.deepEqual(values(r), [0, 0, 0, 0]);
      assert.equal(r.unknown, 0);
    }
  });

  test("exact boundaries: 6/7, 29/30, 89/90 days", () => {
    const r = ghostAgeBuckets([0, 6, 7, 29, 30, 89, 90, 365].map(ago), now);
    assert.deepEqual(values(r), [2, 2, 2, 2]);
  });

  test("partial days floor (6.99 days is still <7d)", () => {
    const r = ghostAgeBuckets([{ registered_at: now - 7 * DAY + 1 }], now);
    assert.deepEqual(values(r), [1, 0, 0, 0]);
  });

  test("null registered_at -> unknown; a future date counts as 0 days", () => {
    const r = ghostAgeBuckets([{ registered_at: null }, {}, { registered_at: now + DAY }], now);
    assert.deepEqual(values(r), [1, 0, 0, 0]);
    assert.equal(r.unknown, 2);
  });
});

describe("parseReconType / filterRecon", () => {
  const data = {
    ghosts: [
      { device_id: "g1", name: "Lobby Screen" },
      { device_id: "g2-unnamed", name: null },
    ],
    stale: [{ device_id: "s1", name: "Cafe Menu" }],
  };

  test("unknown ?type= values fall back to all", () => {
    assert.equal(parseReconType("ghost"), "ghost");
    assert.equal(parseReconType("stale"), "stale");
    for (const v of ["bogus", "GHOST", "", null, undefined]) assert.equal(parseReconType(v), "");
    const r = filterRecon(data, { type: "bogus" });
    assert.equal(r.ghosts.length, 2);
    assert.equal(r.stale.length, 1);
  });

  test("type narrows to one list", () => {
    assert.deepEqual(filterRecon(data, { type: "ghost" }).stale, []);
    assert.deepEqual(filterRecon(data, { type: "stale" }).ghosts, []);
  });

  test("search is case-insensitive on name, falling back to device_id", () => {
    assert.deepEqual(filterRecon(data, { q: "LOBBY" }).ghosts.map((d) => d.device_id), ["g1"]);
    assert.deepEqual(filterRecon(data, { q: "unnamed" }).ghosts.map((d) => d.device_id), ["g2-unnamed"]);
    assert.deepEqual(filterRecon(data, { q: "nothing" }), { ghosts: [], stale: [] });
  });
});

// ─── Part 2: rendered view ───────────────────────────────────────────────────

const VIEW_SRC = fileURLToPath(
  new URL("../../frontend/dashboard-src/src/views/ReconciliationView.jsx", import.meta.url),
);

const HOOK_STUBS = {
  useSession: `export function useSession() { return { me: globalThis.__recon.me }; }`,
  useToast: `export function useToast() { return { toast: (m) => globalThis.__recon.toasts.push(m) }; }`,
  useClock: `export function useClock() { return "12:00"; }`,
  useApi: `export function useApi(fetcher, opts) {
    globalThis.__recon.apiCalls.push(opts);
    return { data: globalThis.__recon.data, error: globalThis.__recon.error || null };
  }`,
};

let View, React, act, createRoot, MemoryRouter, Routes, Route, useLocation;
let dom;
const consoleErrors = [];

test.before(async () => {
  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
  const w = dom.window;
  Object.assign(globalThis, {
    window: w,
    document: w.document,
    localStorage: w.localStorage,
    HTMLElement: w.HTMLElement,
    Node: w.Node,
    Event: w.Event,
    MouseEvent: w.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(globalThis, "navigator", { value: w.navigator, configurable: true });
  // recharts' ResponsiveContainer needs ResizeObserver; jsdom has none.
  globalThis.ResizeObserver = w.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };

  const out = await esbuild.build({
    entryPoints: [VIEW_SRC],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    jsx: "automatic",
    external: ["react", "react/jsx-runtime", "react-dom", "react-dom/client", "react-router-dom", "recharts"],
    plugins: [
      {
        name: "stub-hooks",
        setup(b) {
          b.onResolve({ filter: /hooks\/(useApi|useSession|useToast|useClock)$/ }, (a) => ({
            path: a.path.split("/").pop(),
            namespace: "stub",
          }));
          b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({ contents: HOOK_STUBS[a.path], loader: "js" }));
        },
      },
    ],
  });
  // Written under server/node_modules/.cache/ (gitignored) because the bundle's
  // bare imports (react, react-router-dom, recharts) resolve from the file's own
  // location — here, server/node_modules — and it's outside test/, so
  // node --test never picks it up.
  const cacheDir = fileURLToPath(new URL("../node_modules/.cache/", import.meta.url));
  fs.mkdirSync(cacheDir, { recursive: true });
  const tmp = fileURLToPath(new URL(`beamos-reconciliation-view-${process.pid}.mjs`, pathToFileURL(cacheDir)));
  fs.writeFileSync(tmp, out.outputFiles[0].text);
  try {
    ({ default: View } = await import(pathToFileURL(tmp).href + "?" + Date.now()));
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  React = (await import("react")).default;
  ({ act } = await import("react"));
  ({ createRoot } = await import("react-dom/client"));
  ({ MemoryRouter, Routes, Route, useLocation } = await import("react-router-dom"));

  const origError = console.error;
  console.error = (...args) => {
    consoleErrors.push(args.map(String).join(" "));
    origError(...args);
  };
});

// pretendToBeVisual runs a rAF loop that otherwise keeps node --test alive.
test.after(() => dom?.window.close());

const NOW = 1_800_000_000;
function payload(over = {}) {
  return {
    generated_at: NOW,
    stale_after_days: 14,
    device_count: 10,
    frequency_days: 7,
    last_report_date: "2027-01-01",
    next_report_date: "2027-01-08",
    overdue: false,
    counts: { ghost: 0, stale: 0, total: 0 },
    ghosts: [],
    stale: [],
    ...over,
  };
}
const FINDINGS = payload({
  counts: { ghost: 2, stale: 1, total: 3 },
  ghosts: [
    { device_id: "g1", name: "Lobby Screen", registered_at: NOW - 3 * DAY, last_heartbeat: null },
    { device_id: "g2", name: "Back Office", registered_at: NOW - 40 * DAY, last_heartbeat: null },
  ],
  stale: [{ device_id: "s1", name: "Cafe Menu", registered_at: NOW - 200 * DAY, last_heartbeat: NOW - 20 * DAY, days_since_heartbeat: 20 }],
});

let lastLocation = null;
function LocationProbe() {
  lastLocation = useLocation();
  return null;
}

async function mount(data, { path = "/reconciliation", admin = false } = {}) {
  globalThis.__recon = {
    data,
    me: { current_workspace_id: "ws1", current_workspace: { name: "Acme" }, is_platform_admin: admin },
    toasts: [],
    apiCalls: [],
  };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      React.createElement(
        MemoryRouter,
        { initialEntries: [path] },
        React.createElement(
          Routes,
          null,
          React.createElement(Route, {
            path: "/reconciliation",
            element: React.createElement(React.Fragment, null, React.createElement(View), React.createElement(LocationProbe)),
          }),
          React.createElement(Route, { path: "/device/:id", element: React.createElement(LocationProbe) }),
        ),
      ),
    );
  });
  const unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  return { host, unmount };
}

const text = (el) => el.textContent.replace(/\s+/g, " ");
const h2s = (host) => [...host.querySelectorAll("h2")].map((h) => h.textContent);
const rowNames = (host) => [...host.querySelectorAll("tbody tr td:first-child")].map((td) => td.textContent);
const button = (host, label) => [...host.querySelectorAll("button")].find((b) => b.textContent === label);
async function click(el) {
  await act(async () => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
}

describe("ReconciliationView (rendered)", () => {
  test("all clear: KPIs + Fleet reconciliation only, no bucket charts, existing message", async () => {
    const { host, unmount } = await mount(payload());
    const t = text(host);
    assert.match(t, /All clear — every device is accounted for and has reported recently\./);
    assert.match(t, /Accounted for/);
    assert.match(t, /10 of 10/);
    assert.match(t, /reported within 14 days/);
    assert.doesNotMatch(t, /online now/i);
    assert.ok(h2s(host).includes("Fleet reconciliation"));
    assert.ok(!h2s(host).some((h) => /by days silent|since registration/.test(h)));
    assert.equal(host.querySelector(".seg"), null, "no filter bar when nothing is flagged");
    await unmount();
  });

  test("no devices: no charts, existing no-devices message, no divide-by-zero", async () => {
    const { host, unmount } = await mount(payload({ device_count: 0 }));
    const t = text(host);
    assert.match(t, /No devices registered in this workspace yet — nothing to reconcile\./);
    assert.match(t, /no devices registered yet/);
    assert.doesNotMatch(t, /NaN|Infinity/);
    assert.ok(!h2s(host).includes("Fleet reconciliation"));
    await unmount();
  });

  test("findings: KPIs and charts from full data; filter + search narrow only the tables", async () => {
    const { host, unmount } = await mount(FINDINGS);
    const t = text(host);
    assert.match(t, /7 of 10/);
    assert.ok(h2s(host).includes("Stale devices by days silent"));
    assert.ok(h2s(host).includes("Ghost devices by time since registration"));
    assert.deepEqual(rowNames(host).map((n) => n.replace(/\s*(ghost|stale)$/, "")), ["Lobby Screen", "Back Office", "Cafe Menu"]);
    assert.equal(host.querySelectorAll(".tag.p-bad").length, 2);
    assert.equal(host.querySelectorAll(".tag.p-warn").length, 1);

    await click(button(host, "Ghost"));
    assert.equal(new URLSearchParams(lastLocation.search).get("type"), "ghost");
    assert.ok(!h2s(host).includes("Stale devices"), "stale table hidden");
    assert.equal(rowNames(host).length, 2);
    // KPIs + charts unchanged by the filter
    assert.match(text(host), /7 of 10/);
    assert.ok(h2s(host).includes("Stale devices by days silent"));

    await click(button(host, "All"));
    assert.equal(new URLSearchParams(lastLocation.search).get("type"), null);
    await unmount();
  });

  test("search from ?q= narrows rows; no match shows 'No devices match.'", async () => {
    let m = await mount(FINDINGS, { path: "/reconciliation?q=lobby" });
    assert.equal(rowNames(m.host).length, 1);
    assert.match(text(m.host), /No devices match\./); // stale table has no match
    assert.match(text(m.host), /7 of 10/);
    await m.unmount();
  });

  test("unknown ?type= falls back to All", async () => {
    const { host, unmount } = await mount(FINDINGS, { path: "/reconciliation?type=bogus" });
    assert.ok(h2s(host).includes("Ghost devices"));
    assert.ok(h2s(host).includes("Stale devices"));
    assert.equal(rowNames(host).length, 3);
    assert.equal(button(host, "All").className, "on");
    await unmount();
  });

  test("rows link to /device/:id (ghost rows included)", async () => {
    const { host, unmount } = await mount(FINDINGS);
    await click(host.querySelector("tbody tr.click"));
    assert.equal(lastLocation.pathname, "/device/g1");
    await unmount();
  });

  test("one empty list: its chart shows the empty state instead of axes", async () => {
    const { host, unmount } = await mount(
      payload({ counts: { ghost: 0, stale: 1, total: 1 }, stale: FINDINGS.stale }),
    );
    assert.match(text(host), /No ghost devices — every registered device has reported at least once\./);
    assert.ok(h2s(host).includes("Ghost devices by time since registration"));
    await unmount();
  });

  test("overdue -> Next report 'Due now'", async () => {
    const { host, unmount } = await mount(payload({ overdue: true }));
    assert.match(text(host), /Due now/);
    await unmount();
  });

  test("non-admin sees the schedule read-only", async () => {
    const { host, unmount } = await mount(payload());
    assert.match(text(host), /Runs every 7 days\./);
    assert.equal(host.querySelector("form"), null);
    await unmount();
  });

  test("admin form: validates 1–365, PUTs frequency_days, toasts, refetches", async () => {
    const calls = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ frequency_days: 30 }) };
    };
    localStorage.setItem("token", "tok123");
    try {
      const { host, unmount } = await mount(payload(), { admin: true });
      const input = host.querySelector('form input[type="number"]');
      const form = host.querySelector("form");
      const setVal = async (v) => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        await act(async () => {
          setter.call(input, v);
          input.dispatchEvent(new window.Event("input", { bubbles: true }));
        });
      };
      const submit = () => act(async () => form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));

      await setVal("400");
      await submit();
      assert.equal(calls.length, 0);
      assert.deepEqual(globalThis.__recon.toasts, ["Enter a whole number of days between 1 and 365"]);

      const before = globalThis.__recon.apiCalls.at(-1).deps[1];
      await setVal("30");
      await submit();
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "/api/admin/reconciliation-frequency");
      assert.equal(calls[0].init.method, "PUT");
      assert.equal(calls[0].init.headers.Authorization, "Bearer tok123");
      assert.deepEqual(JSON.parse(calls[0].init.body), { frequency_days: 30 });
      assert.equal(globalThis.__recon.toasts.at(-1), "Reconciliation report now emails every 30 days");
      assert.equal(input.value, "", "draft cleared");
      const last = globalThis.__recon.apiCalls.at(-1);
      assert.equal(last.pollMs, 60000);
      assert.equal(last.deps[0], "ws1");
      assert.equal(last.deps[1], before + 1, "refreshKey bumped -> refetch");
      await unmount();
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("no console errors or React key warnings across all renders", () => {
    const bad = consoleErrors.filter((e) => /unique "key"|Warning:|Error/.test(e));
    assert.deepEqual(bad, []);
  });
});
