// Ref 48 Stage B (redesign): the Pending Installations dashboard page.
//
// Part 1 — the pure bucketing / filter helpers in
// frontend/dashboard-src/src/lib/pending-installations.js.
//
// Part 2 — the real PendingInstallationsView.jsx, bundled on the fly with the
// esbuild Vite already ships and rendered client-side under jsdom (same harness
// as dashboard-reconciliation-view.test.mjs). The session / toast / API / clock
// hooks are swapped for stubs that read a per-test fixture off globalThis;
// react, react-router-dom and recharts stay external so they resolve to
// server/node_modules. No server code, no database, no live API.

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

import {
  isExpiringSoon,
  expiryBuckets,
  expiredAgeBuckets,
  parsePendingType,
  filterPending,
} from "../../frontend/dashboard-src/src/lib/pending-installations.js";

const require = createRequire(import.meta.url);
const viteRequire = createRequire(require.resolve("vite"));
const esbuild = require(viteRequire.resolve("esbuild"));

const DAY = 86400;
const labels = (r) => r.buckets.map((b) => b.label);
const values = (r) => r.buckets.map((b) => b.value);

// ─── Part 1: helpers ─────────────────────────────────────────────────────────

describe("isExpiringSoon", () => {
  test("7 or fewer days with a known expiry; null never counts", () => {
    assert.equal(isExpiringSoon({ days_until_expiry: 1 }), true);
    assert.equal(isExpiringSoon({ days_until_expiry: 7 }), true);
    assert.equal(isExpiringSoon({ days_until_expiry: 8 }), false);
    assert.equal(isExpiringSoon({ days_until_expiry: null }), false);
    assert.equal(isExpiringSoon({}), false);
  });
});

describe("expiryBuckets", () => {
  test("empty / missing list -> all-zero buckets", () => {
    for (const list of [[], null, undefined]) {
      const r = expiryBuckets(list);
      assert.deepEqual(labels(r), ["≤7d", "8–14d", "15d+"]);
      assert.deepEqual(values(r), [0, 0, 0]);
      assert.equal(r.unknown, 0);
    }
  });

  test("exact boundaries 7/8 and 14/15", () => {
    const r = expiryBuckets([1, 7, 8, 14, 15, 29].map((d) => ({ days_until_expiry: d })));
    assert.deepEqual(values(r), [2, 2, 2]);
  });

  test("null / missing days_until_expiry -> unknown, not bucketed", () => {
    const r = expiryBuckets([{ days_until_expiry: null }, {}, { days_until_expiry: 10 }]);
    assert.deepEqual(values(r), [0, 1, 0]);
    assert.equal(r.unknown, 2);
  });
});

describe("expiredAgeBuckets", () => {
  const now = 1_800_000_000;
  const expiredAgo = (d) => ({ expires_at: now - d * DAY });

  test("empty / missing list -> all-zero buckets", () => {
    for (const list of [[], null, undefined]) {
      const r = expiredAgeBuckets(list, now);
      assert.deepEqual(labels(r), ["<7d", "7–29d", "30–89d", "90d+"]);
      assert.deepEqual(values(r), [0, 0, 0, 0]);
      assert.equal(r.unknown, 0);
    }
  });

  test("exact boundaries 6/7, 29/30, 89/90", () => {
    const r = expiredAgeBuckets([0, 6, 7, 29, 30, 89, 90, 400].map(expiredAgo), now);
    assert.deepEqual(values(r), [2, 2, 2, 2]);
  });

  test("partial days floor (6.99 days is still <7d)", () => {
    const r = expiredAgeBuckets([{ expires_at: now - 7 * DAY + 1 }], now);
    assert.deepEqual(values(r), [1, 0, 0, 0]);
  });

  test("null expires_at -> unknown", () => {
    const r = expiredAgeBuckets([{ expires_at: null }, {}, expiredAgo(45)], now);
    assert.deepEqual(values(r), [0, 0, 1, 0]);
    assert.equal(r.unknown, 2);
  });
});

describe("parsePendingType / filterPending", () => {
  const data = {
    pending: [
      { code_id: 1, code: "ABC-123", planned_device_name: "Lobby Screen" },
      { code_id: 2, code: "XYZ-999", planned_device_name: null },
    ],
    abandoned: [{ code_id: 3, code: "OLD-111", planned_device_name: "Cafe Menu" }],
  };

  test("unknown ?type= values fall back to all", () => {
    assert.equal(parsePendingType("pending"), "pending");
    assert.equal(parsePendingType("abandoned"), "abandoned");
    for (const v of ["bogus", "PENDING", "", null, undefined]) assert.equal(parsePendingType(v), "");
    const r = filterPending(data, { type: "bogus" });
    assert.equal(r.pending.length, 2);
    assert.equal(r.abandoned.length, 1);
  });

  test("type narrows to one list", () => {
    assert.deepEqual(filterPending(data, { type: "pending" }).abandoned, []);
    assert.deepEqual(filterPending(data, { type: "abandoned" }).pending, []);
  });

  test("search matches the code OR the planned device name, case-insensitive", () => {
    assert.deepEqual(filterPending(data, { q: "abc" }).pending.map((c) => c.code_id), [1]);
    assert.deepEqual(filterPending(data, { q: "LOBBY" }).pending.map((c) => c.code_id), [1]);
    assert.deepEqual(filterPending(data, { q: "cafe" }).abandoned.map((c) => c.code_id), [3]);
    assert.deepEqual(filterPending(data, { q: "xyz" }).pending.map((c) => c.code_id), [2]); // unnamed, by code
    assert.deepEqual(filterPending(data, { q: "nothing" }), { pending: [], abandoned: [] });
  });
});

// ─── Part 2: rendered view ───────────────────────────────────────────────────

const VIEW_SRC = fileURLToPath(
  new URL("../../frontend/dashboard-src/src/views/PendingInstallationsView.jsx", import.meta.url),
);

const HOOK_STUBS = {
  useSession: `export function useSession() { return { me: globalThis.__pend.me }; }`,
  useToast: `export function useToast() { return { toast: (m) => globalThis.__pend.toasts.push(m) }; }`,
  useClock: `export function useClock() { return "12:00"; }`,
  useApi: `export function useApi(fetcher, opts) {
    globalThis.__pend.apiCalls.push(opts);
    return { data: globalThis.__pend.data, error: globalThis.__pend.error || null };
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
  const tmp = fileURLToPath(new URL(`beamos-pending-installations-view-${process.pid}.mjs`, pathToFileURL(cacheDir)));
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
    grace_days: 3,
    code_count: 10,
    frequency_days: 7,
    last_report_date: "2027-01-01",
    next_report_date: "2027-01-08",
    overdue: false,
    counts: { pending: 0, abandoned: 0, total: 0 },
    pending: [],
    abandoned: [],
    ...over,
  };
}
const code = (id, c, name, over) => ({
  code_id: id,
  code: c,
  planned_device_name: name,
  created_by: "u1",
  created_at: NOW - 10 * DAY,
  expires_at: NOW + 20 * DAY,
  days_pending: 10,
  days_until_expiry: 20,
  ...over,
});
const PENDING = [
  code(1, "ABC-123", "Lobby Screen", { expires_at: NOW + 5 * DAY, days_until_expiry: 5 }),
  code(2, "XYZ-999", null, { days_until_expiry: 20 }),
];
const ABANDONED = [code(3, "OLD-111", "Cafe Menu", { created_at: NOW - 40 * DAY, expires_at: NOW - 10 * DAY, days_until_expiry: -10 })];
const FINDINGS = payload({ counts: { pending: 2, abandoned: 1, total: 3 }, pending: PENDING, abandoned: ABANDONED });

let lastLocation = null;
function LocationProbe() {
  lastLocation = useLocation();
  return null;
}

async function mount(data, { path = "/pending-installations", admin = false } = {}) {
  globalThis.__pend = {
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
            path: "/pending-installations",
            element: React.createElement(React.Fragment, null, React.createElement(View), React.createElement(LocationProbe)),
          }),
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
const codes = (host) => [...host.querySelectorAll("tbody tr td:first-child .mono")].map((s) => s.textContent);
const kpi = (host, label) =>
  [...host.querySelectorAll(".kpi")].find((k) => k.querySelector(".k")?.textContent === label);
const filterButton = (host, label) =>
  [...host.querySelectorAll('[aria-label="Filter by code status"] button')].find((b) => b.textContent === label);
async function click(el) {
  await act(async () => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
}

describe("PendingInstallationsView (rendered)", () => {
  test("all clear: KPIs + Registration codes share only, existing message, no filter bar", async () => {
    const { host, unmount } = await mount(payload());
    const t = text(host);
    assert.match(t, /All clear — every registration code this workspace generated has been activated or handled\./);
    assert.ok(h2s(host).includes("Registration codes"));
    assert.ok(!h2s(host).some((h) => /days until expiry|time since expiry/.test(h)));
    assert.equal(host.querySelector('[aria-label="Filter by code status"]'), null);
    await unmount();
  });

  test("no codes: existing code_count === 0 message, no charts", async () => {
    const { host, unmount } = await mount(payload({ code_count: 0 }));
    assert.match(
      text(host),
      /This workspace hasn’t generated any registration codes — devices here are paired directly\. Nothing to follow up\./,
    );
    assert.ok(!h2s(host).includes("Registration codes"));
    assert.doesNotMatch(text(host), /NaN|Infinity/);
    await unmount();
  });

  test("Expiring KPI with zero pending: shows 0, no bar, no divide-by-zero", async () => {
    const { host, unmount } = await mount(
      payload({ counts: { pending: 0, abandoned: 1, total: 1 }, abandoned: ABANDONED }),
    );
    const k = kpi(host, "Expiring within 7 days");
    assert.equal(k.querySelector(".v").textContent, "0");
    assert.equal(k.querySelector(".kpi-bar"), null);
    assert.doesNotMatch(text(k), /NaN|Infinity/);
    await unmount();
  });

  test("findings: KPIs, 'Other' share label, tags; expiring highlight is the tag, not the column colour", async () => {
    const { host, unmount } = await mount(FINDINGS);
    assert.equal(kpi(host, "Pending").querySelector(".v").textContent, "2");
    assert.match(text(kpi(host, "Pending")), /code cut over 3d ago, not activated/);
    assert.equal(kpi(host, "Expiring within 7 days").querySelector(".v").textContent, "1 of 2");
    assert.equal(kpi(host, "Abandoned").querySelector(".v").textContent, "1");
    assert.match(text(host), /Activated, within grace or other/);
    assert.match(text(host), /7 codes/); // 10 - 3 = 7 "other"
    assert.ok(h2s(host).includes("Pending codes by days until expiry"));
    assert.ok(h2s(host).includes("Abandoned codes by time since expiry"));

    assert.equal(host.querySelectorAll(".tag.p-warn").length, 2, "pending tags");
    const red = [...host.querySelectorAll(".tag.p-bad")].map((t) => t.textContent);
    assert.deepEqual(red.sort(), ["abandoned", "expires in 5d"]);
    // First table = Pending; its last column is "Days until expiry".
    const expiryCells = [...host.querySelector("table").querySelectorAll("tbody tr td:last-child")];
    assert.equal(expiryCells.length, 2);
    assert.ok(expiryCells.every((td) => !td.style.color), "no amber column highlight");
    assert.match(text(host), /\(unnamed\)/);
    assert.equal(host.querySelector("tr.click"), null, "rows are not clickable");
    await unmount();
  });

  test("filter narrows only the tables; KPIs and charts unchanged", async () => {
    const { host, unmount } = await mount(FINDINGS);
    await click(filterButton(host, "Abandoned"));
    assert.equal(new URLSearchParams(lastLocation.search).get("type"), "abandoned");
    assert.ok(!h2s(host).includes("Pending"), "pending table hidden");
    assert.deepEqual(codes(host), ["OLD-111"]);
    assert.equal(kpi(host, "Pending").querySelector(".v").textContent, "2");
    assert.ok(h2s(host).includes("Pending codes by days until expiry"));
    await click(filterButton(host, "All"));
    assert.equal(new URLSearchParams(lastLocation.search).get("type"), null);
    assert.equal(codes(host).length, 3);
    await unmount();
  });

  test("?q= matches by code and by device name; no match shows 'No codes match.'", async () => {
    let m = await mount(FINDINGS, { path: "/pending-installations?q=xyz" });
    assert.deepEqual(codes(m.host), ["XYZ-999"]);
    assert.match(text(m.host), /No codes match\./);
    await m.unmount();
    m = await mount(FINDINGS, { path: "/pending-installations?q=cafe" });
    assert.deepEqual(codes(m.host), ["OLD-111"]);
    await m.unmount();
  });

  test("unknown ?type= falls back to All", async () => {
    const { host, unmount } = await mount(FINDINGS, { path: "/pending-installations?type=bogus" });
    assert.equal(filterButton(host, "All").className, "on");
    assert.equal(codes(host).length, 3);
    await unmount();
  });

  test("chart empty states use neutral wording; table keeps its message", async () => {
    let m = await mount(payload({ counts: { pending: 0, abandoned: 1, total: 1 }, abandoned: ABANDONED }));
    assert.match(text(m.host), /No pending codes\./);
    assert.match(text(m.host), /No pending codes — every recent code has been activated\./);
    await m.unmount();
    m = await mount(payload({ counts: { pending: 2, abandoned: 0, total: 2 }, pending: PENDING }));
    assert.match(text(m.host), /No abandoned codes\./);
    assert.match(text(m.host), /No abandoned codes — nothing has expired unclaimed\./);
    await m.unmount();
  });

  test("overdue -> Next report 'Due now'", async () => {
    const { host, unmount } = await mount(payload({ overdue: true }));
    assert.equal(kpi(host, "Next report").querySelector(".v").textContent, "Due now");
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
      return { ok: true, status: 200, json: async () => ({ frequency_days: 14 }) };
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

      for (const bad of ["0", "366"]) {
        await setVal(bad);
        await submit();
      }
      assert.equal(calls.length, 0);
      assert.deepEqual(globalThis.__pend.toasts, [
        "Enter a whole number of days between 1 and 365",
        "Enter a whole number of days between 1 and 365",
      ]);

      const before = globalThis.__pend.apiCalls.at(-1).deps[1];
      await setVal("14");
      await submit();
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "/api/admin/pending-installation-frequency");
      assert.equal(calls[0].init.method, "PUT");
      assert.equal(calls[0].init.headers.Authorization, "Bearer tok123");
      assert.deepEqual(JSON.parse(calls[0].init.body), { frequency_days: 14 });
      assert.equal(globalThis.__pend.toasts.at(-1), "Pending-installation report now emails every 14 days");
      assert.equal(input.value, "", "draft cleared");
      const last = globalThis.__pend.apiCalls.at(-1);
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
