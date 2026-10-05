// Issues dashboard page redesign.
//
// Part 1 — the pure helpers in frontend/dashboard-src/src/lib/issues.js.
//
// Part 2 — the real IssuesView.jsx, bundled on the fly with the esbuild Vite
// already ships and rendered client-side under jsdom (same harness as
// dashboard-reconciliation-view.test.mjs). The session / period / API hooks are
// swapped for stubs that read a per-test fixture off globalThis; react,
// react-router-dom and recharts stay external so they resolve to
// server/node_modules. Date.now is pinned so the 24h boundaries are stable.
// No server code, no database, no live API.

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

import {
  shortFingerprint,
  perDevice,
  isActive,
  lastSeenBuckets,
  topIssues,
  parseIssueStatus,
  parseIssueSort,
  filterIssues,
  sortIssues,
} from "../../frontend/dashboard-src/src/lib/issues.js";

const require = createRequire(import.meta.url);
const viteRequire = createRequire(require.resolve("vite"));
const esbuild = require(viteRequire.resolve("esbuild"));

const NOW = 1_800_000_000; // epoch seconds
const H = 3600;
const D = 86400;
const issue = (fp, devices, occ, ago) => ({
  error_fingerprint: fp,
  affected_devices: devices,
  occurrence_count: occ,
  last_seen: ago === null ? null : NOW - ago,
});
const fps = (list) => list.map((i) => i.error_fingerprint);

// ─── Part 1: helpers ─────────────────────────────────────────────────────────

describe("shortFingerprint", () => {
  test("short values unchanged; long ones middle-ellipsised to max; empty -> —", () => {
    assert.equal(shortFingerprint("a1b2c3d4e5f6a7b8"), "a1b2c3d4e5f6a7b8"); // exactly 16
    const long = "0123456789abcdefghijklmnopqrstuvwxyz";
    const s = shortFingerprint(long);
    assert.equal(s.length, 16);
    assert.ok(s.startsWith("0123456789a") && s.endsWith("xyz") && s.includes("…"));
    assert.equal(shortFingerprint(long, 12).length, 12);
    for (const v of ["", null, undefined]) assert.equal(shortFingerprint(v), "—");
  });
});

describe("perDevice", () => {
  test("occurrences ÷ devices; null when devices is 0 or missing", () => {
    assert.equal(perDevice({ occurrence_count: 9, affected_devices: 2 }), 4.5);
    assert.equal(perDevice({ occurrence_count: 9, affected_devices: 0 }), null);
    assert.equal(perDevice({ occurrence_count: 9 }), null);
  });
});

describe("isActive / lastSeenBuckets", () => {
  test("active means strictly under 24h; exactly 24h is not active", () => {
    assert.equal(isActive(issue("a", 1, 1, D - 1), NOW), true);
    assert.equal(isActive(issue("a", 1, 1, D), NOW), false);
    assert.equal(isActive(issue("a", 1, 1, null), NOW), false);
  });

  test("boundaries just under / exactly 1h, 24h and 7d", () => {
    const ages = [0, H - 1, H, D - 1, D, 7 * D - 1, 7 * D, 30 * D];
    const r = lastSeenBuckets(ages.map((a, i) => issue(`f${i}`, 1, 1, a)), NOW);
    assert.deepEqual(r.buckets.map((b) => b.label), ["<1h", "1–24h", "1–7d", "7d+"]);
    assert.deepEqual(r.buckets.map((b) => b.value), [2, 2, 2, 2]);
    assert.equal(r.unknown, 0);
  });

  test("future last_seen counts as <1h; null is unknown; empty list is all zero", () => {
    const r = lastSeenBuckets([issue("a", 1, 1, -60), issue("b", 1, 1, null)], NOW);
    assert.deepEqual(r.buckets.map((b) => b.value), [1, 0, 0, 0]);
    assert.equal(r.unknown, 1);
    assert.deepEqual(lastSeenBuckets([], NOW).buckets.map((b) => b.value), [0, 0, 0, 0]);
    assert.deepEqual(lastSeenBuckets(null, NOW).buckets.map((b) => b.value), [0, 0, 0, 0]);
  });
});

describe("parsing", () => {
  test("?status: only 'active', else All", () => {
    assert.equal(parseIssueStatus("active"), "active");
    for (const v of ["bogus", "ACTIVE", "", null, undefined]) assert.equal(parseIssueStatus(v), "");
  });
  test("?sort: known keys, else devices", () => {
    for (const k of ["devices", "occurrences", "per_device", "last_seen"]) assert.equal(parseIssueSort(k), k);
    for (const v of ["bogus", "", null, undefined]) assert.equal(parseIssueSort(v), "devices");
  });
});

describe("sortIssues — stable tie-break by fingerprint", () => {
  // API order deliberately scrambled within ties.
  const list = [
    issue("zeta", 5, 10, 100),
    issue("alpha", 5, 20, 50),
    issue("mid", 5, 10, 100),
    issue("nodev", 0, 30, null),
    issue("beta", 2, 20, 10),
  ];

  test("devices (default): desc, ties by fingerprint ascending", () => {
    assert.deepEqual(fps(sortIssues(list, "devices")), ["alpha", "mid", "zeta", "beta", "nodev"]);
    assert.deepEqual(fps(sortIssues(list, "bogus")), ["alpha", "mid", "zeta", "beta", "nodev"]);
  });
  test("occurrences: desc, ties by fingerprint", () => {
    assert.deepEqual(fps(sortIssues(list, "occurrences")), ["nodev", "alpha", "beta", "mid", "zeta"]);
  });
  test("per device: desc, '—' (0 devices) last, ties by fingerprint", () => {
    // beta 10, alpha 4, mid 2, zeta 2, nodev null
    assert.deepEqual(fps(sortIssues(list, "per_device")), ["beta", "alpha", "mid", "zeta", "nodev"]);
  });
  test("last seen: most recent first, null last, ties by fingerprint", () => {
    assert.deepEqual(fps(sortIssues(list, "last_seen")), ["beta", "alpha", "mid", "zeta", "nodev"]);
  });
  test("same result regardless of input order; input not mutated", () => {
    const copy = [...list];
    assert.deepEqual(fps(sortIssues([...list].reverse(), "devices")), fps(sortIssues(list, "devices")));
    assert.deepEqual(list, copy);
  });
});

describe("filterIssues / topIssues", () => {
  const list = [issue("ABCdef123", 3, 9, 100), issue("xyz789", 1, 1, 2 * D)];

  test("status active + case-insensitive fingerprint search", () => {
    assert.deepEqual(fps(filterIssues(list, { status: "active", nowSec: NOW })), ["ABCdef123"]);
    assert.deepEqual(fps(filterIssues(list, { q: "abcDEF", nowSec: NOW })), ["ABCdef123"]);
    assert.deepEqual(fps(filterIssues(list, { status: "bogus", nowSec: NOW })), ["ABCdef123", "xyz789"]);
    assert.deepEqual(filterIssues(list, { q: "nothing", nowSec: NOW }), []);
  });

  test("fewer than 8 groups -> all of them, devices order with fingerprint tie-break", () => {
    const t = topIssues([issue("b", 2, 1, 0), issue("a", 2, 1, 0), issue("c", 5, 1, 0)], 8);
    assert.deepEqual(t.map((r) => r.full), ["c", "a", "b"]);
    assert.deepEqual(t.map((r) => r.value), [5, 2, 2]);
  });

  test("caps at n, short unique labels, full fingerprint kept", () => {
    const many = Array.from({ length: 12 }, (_, i) => issue(`fp-${String(i).padStart(2, "0")}`, 12 - i, 1, 0));
    const t = topIssues(many, 8);
    assert.equal(t.length, 8);
    assert.equal(t[0].full, "fp-00");
    // two long fingerprints that shorten to the same label stay distinct
    const clash = topIssues([issue("aaaaaaaaaaaaXXXXzzz", 2, 1, 0), issue("aaaaaaaaaaaaYYYYzzz", 1, 1, 0)], 8);
    assert.equal(new Set(clash.map((r) => r.label)).size, 2);
    assert.ok(clash.every((r) => r.label.length <= 16));
  });
});

// ─── Part 2: rendered view ───────────────────────────────────────────────────

const VIEW_SRC = fileURLToPath(new URL("../../frontend/dashboard-src/src/views/IssuesView.jsx", import.meta.url));

const HOOK_STUBS = {
  useSession: `export function useSession() {
    return { me: globalThis.__iss.me, setIssueCount: (n) => globalThis.__iss.counts.push(n) };
  }`,
  usePeriod: `export function usePeriod() { return { period: globalThis.__iss.period }; }`,
  useApi: `export function useApi(fetcher, opts) {
    globalThis.__iss.apiCalls.push({ fetcher, opts });
    if (opts && opts.enabled === false) return { data: null, error: null };
    return { data: globalThis.__iss.data, error: globalThis.__iss.error || null };
  }`,
};

let View, React, act, createRoot, MemoryRouter, Routes, Route, useLocation;
let dom;
const consoleErrors = [];
const realDateNow = Date.now;

test.before(async () => {
  Date.now = () => NOW * 1000;
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
          b.onResolve({ filter: /hooks\/(useApi|useSession|usePeriod)$/ }, (a) => ({
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
  const tmp = fileURLToPath(new URL(`beamos-issues-view-${process.pid}.mjs`, pathToFileURL(cacheDir)));
  fs.writeFileSync(tmp, out.outputFiles[0].text);
  try {
    ({ default: View } = await import(pathToFileURL(tmp).href + "?" + realDateNow()));
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
test.after(() => {
  Date.now = realDateNow;
  dom?.window.close();
});

const ISSUES = [
  issue("zz-old-error", 4, 8, 3 * D), // 1–7d, not active
  issue("aa-hot-error", 4, 40, 10 * 60), // active, <1h
  issue("mm-mid-error", 2, 3, 5 * H), // active, 1–24h
  issue("nn-nodevice", 0, 6, 20 * D), // per device "—", 7d+
];

let lastLocation = null;
function LocationProbe() {
  lastLocation = useLocation();
  return null;
}

async function mount(data, { path = "/issues", admin = true, error = null, period = 7 } = {}) {
  globalThis.__iss = {
    data,
    error,
    period,
    me: { is_platform_admin: admin },
    counts: [],
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
            path: "/issues",
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
const rowFps = (host) => [...host.querySelectorAll("tbody tr td:first-child .mono")].map((s) => s.title);
const kpi = (host, label) => [...host.querySelectorAll(".kpi")].find((k) => k.querySelector(".k")?.textContent === label);
const btn = (host, group, label) =>
  [...host.querySelectorAll(`[aria-label="${group}"] button`)].find((b) => b.textContent === label);
async function click(el) {
  await act(async () => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
}

describe("IssuesView (rendered)", () => {
  test("non-admin: header + 'Platform admin required', API disabled, nothing fetched", async () => {
    const origFetch = globalThis.fetch;
    let fetched = 0;
    globalThis.fetch = async () => {
      fetched += 1;
      return { ok: true, status: 200, json: async () => [] };
    };
    try {
      const { host, unmount } = await mount(ISSUES, { admin: false });
      assert.equal(host.querySelector("h1").textContent, "Open issues");
      assert.match(text(host), /Platform admin required/);
      assert.match(text(host), /This view is restricted to platform administrators\./);
      const call = globalThis.__iss.apiCalls.at(-1).opts;
      assert.equal(call.enabled, false);
      assert.equal(call.pollMs, 60000);
      assert.deepEqual(call.deps, [7]);
      assert.equal(fetched, 0);
      assert.deepEqual(globalThis.__iss.counts, [], "nav count not set");
      assert.equal(host.querySelector("table"), null);
      await unmount();
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("request unchanged: same endpoint, start from the global period", async () => {
    const origFetch = globalThis.fetch;
    const urls = [];
    globalThis.fetch = async (url) => {
      urls.push(url);
      return { ok: true, status: 200, json: async () => [] };
    };
    try {
      const { unmount } = await mount(ISSUES, { period: 30 });
      const { fetcher, opts } = globalThis.__iss.apiCalls.at(-1);
      assert.equal(opts.enabled, true);
      assert.deepEqual(opts.deps, [30]);
      await fetcher({ signal: undefined });
      const expectedStart = new Date(NOW * 1000 - 30 * 86400000).toISOString();
      assert.equal(urls[0], `/api/dashboard/issues?start=${encodeURIComponent(expectedStart)}`);
      await unmount();
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("error state keeps the header", async () => {
    const { host, unmount } = await mount(null, { error: new Error("boom") });
    assert.equal(host.querySelector("h1").textContent, "Open issues");
    assert.match(text(host), /Something went wrong/);
    assert.match(text(host), /boom/);
    await unmount();
  });

  test("empty: exact message, no charts, no filter bar, nav count 0", async () => {
    const { host, unmount } = await mount([]);
    assert.match(text(host), /No grouped issues in this period\./);
    assert.equal(host.querySelector(".kpi"), null);
    assert.ok(!h2s(host).some((h) => /Most widespread issues|Issues by last seen/.test(h)));
    assert.equal(host.querySelector('[aria-label="Sort by"]'), null);
    assert.deepEqual(globalThis.__iss.counts, [0]);
    await unmount();
  });

  test("KPIs, charts, table; nav count = full length; no summed devices figure", async () => {
    const { host, unmount } = await mount(ISSUES);
    assert.deepEqual(globalThis.__iss.counts, [4]);
    assert.equal(kpi(host, "Error groups").querySelector(".v").textContent, "4");
    assert.match(text(kpi(host, "Error groups")), /in the last 7 days/);
    assert.equal(kpi(host, "Occurrences").querySelector(".v").textContent, "57");
    const widest = kpi(host, "Most widespread");
    assert.equal(widest.querySelector(".v").textContent, "4 devices");
    // tie on 4 devices broken by fingerprint -> aa-hot-error
    assert.equal(widest.querySelector(".s span").title, "aa-hot-error");
    assert.equal(kpi(host, "Active in last 24h").querySelector(".v").textContent, "2 of 4");
    assert.doesNotMatch(text(host), /devices affected/);
    assert.equal(host.querySelector(".stamp").textContent, "last 7 days");

    assert.ok(h2s(host).includes("Most widespread issues"));
    assert.ok(h2s(host).includes("Issues by last seen"));

    // default (devices) order with fingerprint tie-break
    assert.deepEqual(rowFps(host), ["aa-hot-error", "zz-old-error", "mm-mid-error", "nn-nodevice"]);
    assert.equal(host.querySelectorAll(".tag.p-warn").length, 2, "active tags");
    const nodevRow = [...host.querySelectorAll("tbody tr")].at(-1);
    assert.equal(nodevRow.children[3].textContent, "—");
    assert.equal([...host.querySelectorAll("tbody tr")][0].children[3].textContent, "10.0");
    assert.equal(host.querySelector("tr.click"), null);
    await unmount();
  });

  test("50 groups -> 'top 50 by affected devices; there may be more'", async () => {
    const fifty = Array.from({ length: 50 }, (_, i) => issue(`fp-${String(i).padStart(2, "0")}`, 1, 1, D * 2));
    const { host, unmount } = await mount(fifty);
    assert.match(text(kpi(host, "Error groups")), /top 50 by affected devices; there may be more/);
    assert.equal(kpi(host, "Active in last 24h").querySelector(".v").textContent, "0 of 50");
    await unmount();
  });

  test("sort buttons reorder the table and write ?sort=", async () => {
    const { host, unmount } = await mount(ISSUES);
    await click(btn(host, "Sort by", "Occurrences"));
    assert.equal(new URLSearchParams(lastLocation.search).get("sort"), "occurrences");
    assert.deepEqual(rowFps(host), ["aa-hot-error", "zz-old-error", "nn-nodevice", "mm-mid-error"]);
    await click(btn(host, "Sort by", "Per device"));
    assert.deepEqual(rowFps(host), ["aa-hot-error", "zz-old-error", "mm-mid-error", "nn-nodevice"]);
    await click(btn(host, "Sort by", "Last seen"));
    assert.deepEqual(rowFps(host), ["aa-hot-error", "mm-mid-error", "zz-old-error", "nn-nodevice"]);
    await click(btn(host, "Sort by", "Devices"));
    assert.equal(new URLSearchParams(lastLocation.search).get("sort"), null, "default drops the param");
    await unmount();
  });

  test("unknown ?sort / ?status fall back to Devices / All", async () => {
    const { host, unmount } = await mount(ISSUES, { path: "/issues?sort=bogus&status=bogus" });
    assert.equal(btn(host, "Sort by", "Devices").className, "on");
    assert.equal(btn(host, "Filter by activity", "All").className, "on");
    assert.equal(rowFps(host).length, 4);
    await unmount();
  });

  test("Active 24h filter narrows only the table; KPIs and charts unchanged", async () => {
    const { host, unmount } = await mount(ISSUES);
    await click(btn(host, "Filter by activity", "Active 24h"));
    assert.equal(new URLSearchParams(lastLocation.search).get("status"), "active");
    assert.deepEqual(rowFps(host), ["aa-hot-error", "mm-mid-error"]);
    assert.equal(kpi(host, "Error groups").querySelector(".v").textContent, "4");
    assert.equal(kpi(host, "Occurrences").querySelector(".v").textContent, "57");
    assert.ok(h2s(host).includes("Most widespread issues"));
    assert.deepEqual(globalThis.__iss.counts.at(-1), 4);
    await unmount();
  });

  test("?q= searches the fingerprint case-insensitively; no match -> 'No issues match.'", async () => {
    let m = await mount(ISSUES, { path: "/issues?q=MID" });
    assert.deepEqual(rowFps(m.host), ["mm-mid-error"]);
    assert.equal(kpi(m.host, "Error groups").querySelector(".v").textContent, "4");
    await m.unmount();
    m = await mount(ISSUES, { path: "/issues?q=nothing-like-this" });
    assert.match(text(m.host), /No issues match\./);
    await m.unmount();
  });

  test("no console errors or React key warnings across all renders", () => {
    const bad = consoleErrors.filter((e) => /unique "key"|Warning:|Error/.test(e));
    assert.deepEqual(bad, []);
  });
});
