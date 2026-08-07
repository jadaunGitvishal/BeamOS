      /* ============ deterministic demo data ============ */
      function rng(s) {
        return function () {
          s |= 0;
          s = (s + 0x6d2b79f5) | 0;
          var t = Math.imul(s ^ (s >>> 15), 1 | s);
          t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
      }
      const R = rng(20260731);
      const pick = (a) => a[Math.floor(R() * a.length)];
      const gauss = (m, sd) => {
        let u = 1 - R(),
          v = R();
        return m + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
      };
      const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

      const OWNERS = {
        us: {
          label: "CXO1 platform",
          short: "CXO1",
          cls: "t-us",
          c: "#7C3AED",
        },
        net: {
          label: "Store network",
          short: "Customer IT",
          cls: "t-net",
          c: "#EA580C",
        },
        staff: {
          label: "Store staff",
          short: "Store staff",
          cls: "t-staff",
          c: "#DB2777",
        },
        dev: {
          label: "Screen hardware",
          short: "Hardware",
          cls: "t-dev",
          c: "#0F766E",
        },
        unk: {
          label: "Not established",
          short: "Unknown",
          cls: "t-unk",
          c: "#64748B",
        },
      };
      const CAUSES = [
        { o: "net", t: "Store internet dropped", w: 34 },
        { o: "staff", t: "Screen switched off early", w: 22 },
        { o: "staff", t: "Screen never switched on", w: 8 },
        { o: "dev", t: "Player rebooted repeatedly", w: 11 },
        { o: "dev", t: "Display not responding", w: 6 },
        { o: "us", t: "Video stalled part way", w: 9 },
        { o: "us", t: "Content never reached the screen", w: 5 },
        { o: "unk", t: "Cause not established", w: 5 },
      ];
      function drawCause() {
        const tot = CAUSES.reduce((s, c) => s + c.w, 0);
        let r = R() * tot;
        for (const c of CAUSES) {
          if ((r -= c.w) <= 0) return c;
        }
        return CAUSES[0];
      }

      const SITES = [
        "High Street",
        "City Centre",
        "Phoenix Mall",
        "Market Road",
        "Central Mall",
        "Main Bazaar",
        "Grand Plaza",
        "Metro Junction",
      ];
      const REGIONS = [
        {
          id: "north",
          name: "North",
          base: 96.1,
          cities: [
            "Delhi Karol Bagh",
            "Delhi Connaught Place",
            "Gurugram DLF Phase 2",
            "Gurugram Cyber Hub",
            "Noida Sector 18",
            "Ghaziabad Raj Nagar",
            "Faridabad",
            "Lajpat Nagar",
            "Rajouri Garden",
            "Chandigarh Sector 17",
            "Ludhiana Mall Road",
            "Amritsar Lawrence Road",
            "Jalandhar",
            "Jaipur MI Road",
            "Jodhpur",
            "Udaipur",
            "Lucknow Hazratganj",
            "Kanpur",
            "Varanasi",
            "Agra",
            "Meerut",
            "Dehradun Rajpur Road",
            "Shimla Mall",
            "Jammu",
          ],
        },
        {
          id: "west",
          name: "West",
          base: 95.4,
          cities: [
            "Mumbai Andheri East",
            "Mumbai Bandra Linking Road",
            "Mumbai Colaba",
            "Thane Ghodbunder",
            "Navi Mumbai Vashi",
            "Pune FC Road",
            "Pune Koregaon Park",
            "Nashik College Road",
            "Nagpur Sitabuldi",
            "Aurangabad",
            "Ahmedabad CG Road",
            "Ahmedabad Prahlad Nagar",
            "Surat Ring Road",
            "Vadodara Alkapuri",
            "Rajkot",
            "Bhavnagar",
            "Panaji",
            "Margao",
            "Kolhapur",
            "Solapur",
            "Jamnagar",
            "Anand",
            "Bhuj",
            "Vapi",
            "Nanded",
          ],
        },
        {
          id: "south",
          name: "South",
          base: 94.8,
          cities: [
            "Bengaluru Koramangala",
            "Bengaluru Indiranagar",
            "Bengaluru Whitefield",
            "Chennai T Nagar",
            "Chennai Anna Nagar",
            "Chennai Velachery",
            "Hyderabad Banjara Hills",
            "Hyderabad Kukatpally",
            "Kochi MG Road",
            "Thiruvananthapuram",
            "Kozhikode",
            "Thrissur",
            "Coimbatore RS Puram",
            "Madurai KK Nagar",
            "Salem",
            "Tiruchirappalli",
            "Mysuru Sayyaji Rao",
            "Mangaluru",
            "Hubballi",
            "Vijayawada MG Road",
            "Visakhapatnam",
            "Guntur",
            "Warangal",
            "Tirupati",
          ],
        },
        {
          id: "east",
          name: "East",
          base: 88.6,
          cities: [
            "Kolkata Park Street",
            "Kolkata Salt Lake",
            "Kolkata Gariahat",
            "Howrah AC Market",
            "Siliguri Hill Cart",
            "Durgapur",
            "Asansol",
            "Patna Boring Road",
            "Muzaffarpur",
            "Gaya",
            "Ranchi Main Road",
            "Jamshedpur Bistupur",
            "Dhanbad",
            "Bhubaneswar Saheed Nagar",
            "Cuttack",
            "Rourkela",
            "Guwahati GS Road",
            "Dibrugarh",
            "Silchar",
            "Agartala",
            "Shillong",
            "Imphal",
          ],
        },
        {
          id: "central",
          name: "Central",
          base: 91.2,
          cities: [
            "Indore Vijay Nagar",
            "Indore Palasia",
            "Bhopal MP Nagar",
            "Bhopal Arera",
            "Jabalpur Napier Town",
            "Gwalior City Centre",
            "Ujjain",
            "Sagar",
            "Raipur Pandri",
            "Bilaspur",
            "Durg",
            "Korba",
            "Rewa",
            "Satna",
            "Ratlam",
            "Dewas",
          ],
        },
      ];
      const SCRNAMES = [
        "Entrance",
        "Window display",
        "Till counter",
        "Rear wall",
        "Kids section",
        "Fitting area",
        "Aisle end",
        "Video wall",
      ];

      let SID = 0,
        STORES = [],
        SCREENS = [];
      REGIONS.forEach((rg) => {
        const per = Math.round(318 * (rg.cities.length / 111));
        for (let i = 0; i < per; i++) {
          const city = rg.cities[i % rg.cities.length];
          const nm = i < rg.cities.length ? city : city + " " + pick(SITES);
          const comp = clamp(gauss(rg.base, 7.4), 42, 100);
          const st = {
            id: "s" + ++SID,
            name: nm,
            region: rg.id,
            regionName: rg.name,
            comp: +comp.toFixed(1),
            screens: [],
            open: "10:00",
            close: "21:00",
          };
          const n = 2 + Math.floor(R() * 4);
          for (let k = 0; k < n; k++) {
            const bad = R() < (comp < 80 ? 0.42 : comp < 92 ? 0.15 : 0.045);
            const dim = !bad && R() < 0.05;
            const c = bad || dim ? drawCause() : null;
            const sc = {
              id: st.id + "-" + (k + 1),
              store: st.id,
              name: SCRNAMES[k % SCRNAMES.length],
              status: bad ? "off" : dim ? "degraded" : "on",
              platform: pick([
                "Android TV",
                "Android TV",
                "Android TV",
                "Fire TV",
                "Samsung Tizen",
                "BrightSign",
              ]),
              rssi: Math.round(gauss(bad ? -79 : -62, 8)),
              storage: +(1.5 + R() * 9).toFixed(1),
              app: pick(["2.4.1", "2.4.1", "2.4.1", "2.3.9"]),
              comp: +clamp(comp + gauss(0, 4), 35, 100).toFixed(1),
              cause: c,
              since: pick(["14:02", "09:41", "19:10", "02:18", "13:55"]),
            };
            st.screens.push(sc);
            SCREENS.push(sc);
          }
          STORES.push(st);
        }
      });
      const STORE = Object.fromEntries(STORES.map((s) => [s.id, s]));
      const TOTS = SCREENS.length,
        TOTST = STORES.length;
      const wComp = +(
        STORES.reduce((a, s) => a + s.comp * s.screens.length, 0) / TOTS
      ).toFixed(1);
      const onNow = SCREENS.filter((s) => s.status === "on").length;
      const belowT = STORES.filter((s) => s.comp < 95).length;

      /* per-period compliance profiles. Separate seed so the 7-day baseline above is unchanged.
   The estate improves over time, so 24h reads best and 30d worst. */
      const R2 = rng(20260801);
      const g2 = (m, sd) => {
        let u = 1 - R2(),
          v = R2();
        return m + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
      };
      STORES.forEach((st) => {
        const d1 = clamp(st.comp + g2(1.1, 2.5), 35, 100),
          d30 = clamp(st.comp + g2(-1.4, 1.9), 35, 100);
        st.cb = { 1: +d1.toFixed(1), 7: st.comp, 30: +d30.toFixed(1) };
        st.screens.forEach((sc) => {
          sc.cb = {
            1: +clamp(sc.comp + (d1 - st.comp) + g2(0, 1.1), 35, 100).toFixed(
              1,
            ),
            7: sc.comp,
            30: +clamp(sc.comp + (d30 - st.comp) + g2(0, 1.1), 35, 100).toFixed(
              1,
            ),
          };
        });
      });

      /* reporting period */
      const PROF = (k) => (k <= 2 ? "1" : k <= 14 ? "7" : "30");
      const MON = [
        "Jan",
        "Feb",
        "Mar",
        "Apr",
        "May",
        "Jun",
        "Jul",
        "Aug",
        "Sep",
        "Oct",
        "Nov",
        "Dec",
      ];
      const fmtD = (d) => d.getDate() + " " + MON[d.getMonth()];
      function hashOff(str) {
        let h = 2166136261;
        for (let i = 0; i < str.length; i++) {
          h ^= str.charCodeAt(i);
          h = Math.imul(h, 16777619);
        }
        return +((((h >>> 0) % 1000) / 1000) * 2.6 - 1.3).toFixed(2);
      }
      let PER = {
        k: "7",
        prof: "7",
        days: 7,
        off: 0,
        label: "last 7 days",
        col: "This week",
        rows: 7,
        segs: 14,
      };
      function setPeriod(k, from, to) {
        if (k === "c") {
          const d = Math.max(
            1,
            Math.min(365, Math.round((to - from) / 864e5) + 1),
          );
          PER = {
            k: "c",
            prof: PROF(d),
            days: d,
            off: hashOff(
              from.toISOString().slice(0, 10) + to.toISOString().slice(0, 10),
            ),
            label: fmtD(from) + " – " + fmtD(to),
            col: d + " days",
            rows: Math.min(d, 14),
            segs: Math.min(Math.max(d, 7), 30),
          };
        } else {
          const d = +k;
          PER = {
            k: k,
            prof: k,
            days: d,
            off: 0,
            label: d === 1 ? "last 24 hours" : "last " + d + " days",
            col: d === 1 ? "Today" : "This " + (d === 7 ? "week" : "month"),
            rows: d === 1 ? 1 : d === 7 ? 7 : 14,
            segs: d === 1 ? 12 : d === 7 ? 14 : 30,
          };
        }
        CACHE = {};
      }
      const CB = (x) => +clamp(x.cb[PER.prof] + PER.off, 35, 100).toFixed(1);

      /* shortfall attribution, computed for any slice of the estate */
      function agg(stores) {
        const screens = stores.reduce((a, s) => a.concat(s.screens), []);
        const totS = screens.length || 1;
        const comp = +(
          stores.reduce((a, s) => a + CB(s) * s.screens.length, 0) / totS
        ).toFixed(1);
        const gap = 100 - comp,
          acc = {};
        screens
          .filter((s) => s.cause)
          .forEach(
            (s) => (acc[s.cause.o] = (acc[s.cause.o] || 0) + (100 - CB(s))),
          );
        const tot = Object.values(acc).reduce((a, b) => a + b, 0) || 1;
        const shortfall = Object.entries(acc)
          .sort((a, b) => b[1] - a[1])
          .map(([o, v]) => ({
            o,
            pts: +((gap * v) / tot).toFixed(1),
            pc: (v / tot) * 100,
          }));
        return {
          stores,
          screens,
          totS: screens.length,
          totSt: stores.length,
          comp,
          onNow: screens.filter((s) => s.status === "on").length,
          below: stores.filter((s) => CB(s) < 95).length,
          shortfall,
          missing: +shortfall.reduce((a, x) => a + x.pts, 0).toFixed(1),
        };
      }
      const shortfall = agg(STORES).shortfall;
      const DEMO_RG = "east";
      const DEMO_ST = (
        STORES.filter(
          (s) =>
            s.region === DEMO_RG &&
            s.screens.length >= 4 &&
            s.comp >= 88 &&
            s.screens.filter((x) => x.status !== "on").length === 1,
        ).sort((a, b) => b.screens.length - a.screens.length)[0] ||
        STORES.filter(
          (s) =>
            s.screens.length >= 4 && s.screens.some((x) => x.status !== "on"),
        )[0] ||
        STORES[0]
      ).id;
      const SCOPE = {
        org: STORES,
        region: STORES.filter((s) => s.region === DEMO_RG),
        store: [STORE[DEMO_ST]],
      };
      let CACHE = {};
      function D() {
        const k = "a|" + level + "|" + PER.prof + "|" + PER.off;
        return CACHE[k] || (CACHE[k] = agg(SCOPE[level]));
      }
      function REG() {
        const k = "r|" + PER.prof + "|" + PER.off;
        if (CACHE[k]) return CACHE[k];
        return (CACHE[k] = REGIONS.map((rg) => {
          const ss = STORES.filter((s) => s.region === rg.id),
            a = agg(ss);
          return {
            ...rg,
            stores: a.totSt,
            scr: a.totS,
            comp: a.comp,
            online: a.onNow,
            risk: a.below,
            worst: ss.slice().sort((x, y) => CB(x) - CB(y))[0],
          };
        }));
      }
      /* compliance for the window immediately before the one on screen */
      function AGGORG() {
        const k = "a|org|" + PER.prof + "|" + PER.off;
        return (CACHE[k] || (CACHE[k] = agg(STORES))).comp;
      }
      function prevComp() {
        const p = PER.prof,
          back = { 1: "7", 7: "30", 30: "30" }[p];
        const save = PER.prof;
        PER.prof = back;
        const v = agg(SCOPE[level]).comp;
        PER.prof = save;
        return p === "30" ? +(v - 2.1).toFixed(1) : v;
      }

      /* time series */
      const AIR = Array.from({ length: 48 }, (_, i) => {
        const h = i / 2;
        if (h < 9.5 || h > 21.5) return 4 + R() * 5;
        let v = 93 + gauss(0, 2.2);
        if (h >= 14 && h < 16.5) v -= gauss(15, 4);
        if (h > 20.5) v -= 6;
        return clamp(v, 40, 99);
      });
      const TREND = Array.from(
        { length: 14 },
        (_, i) =>
          +clamp(wComp - 3.4 + i * 0.26 + gauss(0, 0.75), 80, 100).toFixed(1),
      );
      const DAYPART = [96, 97, 96, 94, 81, 74, 86, 95, 97, 96, 93, 88];

      function txDay(sc, d) {
        const seg = [];
        const push = (w, s) => seg.push({ w, s });
        push(42, "shut");
        if (sc.status === "off" && d >= 4) {
          push(20, "on");
          push(25, "off");
        } else if (sc.comp < 80) {
          push(14 + R() * 4, "on");
          push(8 + R() * 6, "off");
          push(20, "on");
        } else if (R() < 0.18) {
          push(24, "on");
          push(4 + R() * 3, "off");
          push(17, "on");
        } else push(45, "on");
        const used = seg.reduce((a, x) => a + x.w, 0);
        push(Math.max(0, 100 - used), "shut");
        return seg;
      }

      /* campaigns */
      const CAMPS = [
        {
          id: "c1",
          name: "Monsoon sale 2026",
          status: "live",
          from: "14 Jul",
          to: "15 Aug",
          day: 18,
          len: 33,
          targets: 842,
          assets: [
            { n: "Monsoon hero 30s", p: 168240, c: 98.2, sh: 41, h: "ok" },
            { n: "Kids range 15s", p: 124010, c: 97.6, sh: 30, h: "ok" },
            {
              n: "Sports range 20s",
              p: 86450,
              c: 89.1,
              sh: 21,
              h: "warn",
              hn: "Stalls on Tizen",
            },
            {
              n: "Store poster still",
              p: 34180,
              c: 99.4,
              sh: 8,
              h: "bad",
              hn: "Expires 2 Aug",
            },
          ],
        },
        {
          id: "c2",
          name: "Independence week",
          status: "scheduled",
          from: "11 Aug",
          to: "18 Aug",
          day: 0,
          len: 8,
          targets: 1047,
          assets: [
            { n: "Freedom sale 20s", p: 0, c: 0, sh: 0, h: "ok" },
            { n: "Tricolour still", p: 0, c: 0, sh: 0, h: "ok" },
          ],
        },
        {
          id: "c3",
          name: "Summer sale 2026",
          status: "closed",
          from: "1 May",
          to: "30 Jun",
          day: 61,
          len: 61,
          targets: 806,
          assets: [
            { n: "Summer hero 30s", p: 402110, c: 97.1, sh: 52, h: "ok" },
            { n: "Sandals 15s", p: 288400, c: 96.4, sh: 37, h: "ok" },
            { n: "Clearance still", p: 84200, c: 99.1, sh: 11, h: "ok" },
          ],
        },
      ];
      CAMPS.forEach((c) => {
        const tot = c.assets.reduce((a, x) => a + x.p, 0);
        c.plays = tot;
        c.planned =
          c.status === "scheduled"
            ? 0
            : Math.round(tot / (c.status === "closed" ? 0.968 : 0.913));
        c.deliv = c.planned ? +((tot / c.planned) * 100).toFixed(1) : 0;
        c.reach =
          c.status === "scheduled"
            ? 0
            : Math.round(c.targets * (c.status === "closed" ? 0.981 : 0.958));
        c.late = c.status === "live" ? 54 : c.status === "closed" ? 18 : 0;
        c.never = c.status === "live" ? 35 : c.status === "closed" ? 9 : 0;
        c.freq =
          c.status === "scheduled"
            ? 0
            : +(tot / Math.max(1, c.reach) / c.len).toFixed(1);
      });

      const ISSUES = [
        {
          o: "net",
          t: "{n} screens in East lose connection every afternoon",
          n: 22,
          st: 9,
          rg: "east",
          d: "All {n} sit behind the same ISP. They drop between 14:00 and 16:00 on weekdays and recover on their own. Nothing wrong with the screens or the platform.",
          meta: ["started 11 days ago", "confidence high"],
        },
        {
          o: "staff",
          t: "{n} screens switched off before closing time",
          n: 18,
          st: 11,
          d: "Powered down at the wall around 19:10 while the stores trade until 21:00. Costs roughly two hours of scheduled plays per screen per day.",
          meta: ["recurring", "confidence high"],
        },
        {
          o: "us",
          t: "Sports range 20s stalls on every Samsung screen",
          n: 17,
          st: 14,
          d: "Affects Tizen players only. The same file plays cleanly on Android. Ours to fix — a re-encode is in test.",
          meta: ["fix in test", "confidence high"],
        },
        {
          o: "dev",
          t: "{n} players reboot nightly after the 02:00 update",
          n: 6,
          st: 6,
          d: "All {n} are the same commercial display model. The player restarts cleanly but loses roughly forty minutes of the morning schedule.",
          meta: ["since app 2.4.1", "confidence medium"],
        },
        {
          o: "unk",
          t: "{n} screens have not been seen since install",
          n: 9,
          st: 6,
          d: "Registered during commissioning but never sent a heartbeat. Someone on site needs to confirm they are plugged in and connected.",
          meta: ["needs site visit", "confidence low"],
        },
      ];
      function issuesInScope() {
        const sf = level === "org" ? 1 : D().totS / TOTS;
        const pf =
          PER.days <= 2 ? 0.55 : PER.days <= 7 ? 1 : PER.days <= 30 ? 1.8 : 2.2;
        if (sf === 1 && pf === 1) return ISSUES;
        return ISSUES.map((i) => {
          const f = (i.rg === DEMO_RG ? 1 : sf) * pf;
          return Object.assign({}, i, {
            n: Math.max(1, Math.round(i.n * f)),
            st: Math.max(1, Math.round(i.st * f)),
          });
        });
      }
      const fill = (t, i) => String(t).split("{n}").join(i.n);

      /* ============ helpers ============ */
      const $ = (s) => document.querySelector(s);
      const esc = (s) =>
        String(s).replace(
          /[&<>"]/g,
          (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
        );
      const n0 = (v) => Math.round(v).toLocaleString("en-IN");
      const pc = (v) => v.toFixed(1) + "%";
      const cCol = (v) =>
        v >= 95 ? "var(--ok)" : v >= 90 ? "var(--warn)" : "var(--bad)";
      const cPill = (v) => (v >= 95 ? "p-ok" : v >= 90 ? "p-warn" : "p-bad");
      function toast(m) {
        const t = $("#toast");
        t.textContent = m;
        t.classList.add("show");
        clearTimeout(t._x);
        t._x = setTimeout(() => t.classList.remove("show"), 2100);
      }
      function stat(k, v, s) {
        return `<div class="card stat"><p class="k">${k}</p><p class="v num">${v}</p>${s ? `<p class="s">${s}</p>` : ""}</div>`;
      }
      function txHTML(seg, cls = "") {
        return (
          `<div class="tx ${cls}">` +
          seg
            .map(
              (x) =>
                `<i style="width:${x.w}%;background:${x.s === "on" ? "var(--on)" : x.s === "off" ? "var(--off)" : "var(--shut)"}"></i>`,
            )
            .join("") +
          `</div>`
        );
      }
      function ownTag(o) {
        return `<span class="tag ${OWNERS[o].cls}">${OWNERS[o].short}</span>`;
      }
      const LEGEND = `<div class="leg"><span><i style="background:var(--on)"></i>On air</span><span><i style="background:var(--off)"></i>Off air</span><span><i style="background:var(--shut)"></i>Store closed</span></div>`;

      /* ============ views ============ */
      function vOverview() {
        const Dv = D(),
          iss = issuesInScope(),
          RS = REG();
        const rg = level === "region" ? RS.find((r) => r.id === DEMO_RG) : null;
        const bars = AIR.map(
          (v, i) =>
            `<b style="height:${Math.max(3, v)}%" title="${String(Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"} — ${Math.round(v)}% on air"></b>`,
        ).join("");
        const worst = Dv.stores
          .slice()
          .sort((a, b) => CB(a) - CB(b))
          .slice(0, 10);
        const dlt = +(Dv.comp - prevComp()).toFixed(1);
        return `
  <div class="pt"><div><h1>${rg ? rg.name + " region overview" : "Network overview"}</h1></div><span class="stamp" id="asof"></span></div>
  <p class="sub">Compliance is the share of scheduled plays that completed, measured inside trading hours only. Everything below is calculated from ${n0(Dv.totS)} screens across ${n0(Dv.totSt)} stores.</p>

  <div class="card pad0 hero rise">
    <div class="heroL">
      <p class="stat k" style="margin-bottom:6px">Campaign compliance · ${PER.label}</p>
      <div style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap">
        <span class="big" id="bigv">0.0%</span>
        <span class="delta" style="color:${dlt >= 0 ? "var(--ok)" : "var(--bad)"}">${dlt >= 0 ? "▲" : "▼"} ${Math.abs(dlt).toFixed(1)} pts on the previous ${PER.k === "1" ? "24 hours" : PER.k === "7" ? "week" : PER.k === "30" ? "month" : "period"}</span>
      </div>
      <div class="meter"><i style="width:${Dv.comp}%"></i><u style="left:95%"></u></div>
      <p class="stat s" style="margin-top:9px">${(95 - Dv.comp).toFixed(1)} pts below the 95% contracted target</p>
      <div class="grid g2 mt16">
        <div><p class="stat k">Plays completed</p><p class="v num" style="font-size:17px">97.1%</p></div>
        <div><p class="stat k">Screens available</p><p class="v num" style="font-size:17px">96.4%</p></div>
      </div>
    </div>
    <div class="heroR">
      <div class="ch"><h2>${PER.k === "1" ? "Fleet on air today" : "Average day on air"}</h2><span class="hint">${PER.k === "1" ? "share of screens playing, half-hourly" : "mean across " + PER.label}</span></div>
      <div class="air">${bars}</div>
      <div class="axis"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>24:00</span></div>
      <p class="stat s" style="margin-top:10px">Dip between 14:00 and 16:00 tracks the East region ISP outage.</p>
    </div>
  </div>

  <div class="card mt16">
    <div class="ch"><h2>Where the missing ${Dv.missing}% went</h2><span class="hint">by who has to fix it</span></div>
    <div class="own">${Dv.shortfall.map((x) => `<i style="width:${x.pc}%;background:${OWNERS[x.o].c}" title="${OWNERS[x.o].label} — ${x.pts} pts"></i>`).join("")}</div>
    <div class="grid mt16" style="gap:8px;grid-template-columns:repeat(${Dv.shortfall.length},minmax(0,1fr))">
      ${Dv.shortfall.map((x) => `<div><div style="display:flex;align-items:center;gap:7px"><span class="dot" style="background:${OWNERS[x.o].c}"></span><span style="font-size:12px;color:var(--ink2)">${OWNERS[x.o].label}</span></div><p class="v num" style="font-size:16px;margin-left:15px">${x.pts} pts</p></div>`).join("")}
    </div>
  </div>

  <div class="grid g3 mt16">
    ${stat("On air right now", `${n0(Dv.onNow)} <small>of ${n0(Dv.totS)}</small>`, `${((Dv.onNow / Dv.totS) * 100).toFixed(1)}% of the fleet`)}
    ${stat("Stores below target", `<span style="color:var(--bad)">${n0(Dv.below)}</span> <small>of ${n0(Dv.totSt)}</small>`, `under 95% · ${PER.label}`)}
    ${stat("Open issues", `${iss.length}`, `${iss.reduce((a, i) => a + i.n, 0)} screens affected`)}
  </div>

  ${
    level === "org"
      ? `<div class="sec"><h2>Regions</h2>
    <div class="card pad0">
      <table><thead><tr><th>Region</th><th class="r">Compliance</th><th class="r">Stores</th><th class="r">Screens on air</th><th style="width:130px">Trend</th><th>Worst store</th></tr></thead><tbody>
      ${RS.slice()
        .sort((a, b) => b.comp - a.comp)
        .map(
          (r) => `
        <tr class="click" data-go="#/network?r=${r.id}">
          <td><b style="font-weight:500">${r.name}</b></td>
          <td class="r num" style="color:${cCol(r.comp)};font-weight:500">${pc(r.comp)}</td>
          <td class="r num" style="color:var(--ink2)">${r.stores}</td>
          <td class="r num" style="color:var(--ink2)">${r.online}/${r.scr}</td>
          <td>${txHTML(spark(r.comp), "sm")}</td>
          <td class="trunc" style="color:var(--ink2)">${esc(r.worst.name)} · ${pc(CB(r.worst))}</td>
        </tr>`,
        )
        .join("")}
      </tbody></table>
    </div>
  </div>`
      : `<div class="sec"><h2>Stores needing attention</h2>
    <div class="card pad0">
      <table><thead><tr><th>Store</th><th class="r">Compliance</th><th class="r">On air</th><th style="width:130px">${PER.col}</th><th>Main cause</th></tr></thead><tbody>
      ${worst
        .map((st) => {
          const c = (st.screens.find((x) => x.cause) || {}).cause;
          return `<tr class="click" data-go="#/store/${st.id}">
          <td class="trunc" style="font-weight:500">${esc(st.name)}</td>
          <td class="r num" style="color:${cCol(CB(st))};font-weight:500">${pc(CB(st))}</td>
          <td class="r num" style="color:var(--ink2)">${st.screens.filter((x) => x.status === "on").length}/${st.screens.length}</td>
          <td>${txHTML(spark(CB(st)), "sm")}</td>
          <td>${c ? ownTag(c.o) + ' <span style="font-size:12px;color:var(--ink2)">' + esc(c.t) + "</span>" : '<span style="color:var(--ink3)">—</span>'}</td>
        </tr>`;
        })
        .join("")}
      </tbody></table>
    </div>
  </div>`
  }`;
      }
      function spark(base) {
        const n = PER.segs;
        return Array.from({ length: n }, () => {
          const v = clamp(base + gauss(0, 5), 40, 100);
          return { w: 100 / n, s: v > 92 ? "on" : v > 78 ? "shut" : "off" };
        });
      }

      function vNetwork(q) {
        const rid = q.get("r") || "all",
          sq = (q.get("q") || "").toLowerCase(),
          only = q.get("below") === "1";
        const view = q.get("v") === "tile" ? "tile" : "table";
        const sf = q.get("s") || "all";
        const cur = {
          r: rid === "all" ? "" : rid,
          q: q.get("q") || "",
          below: only ? "1" : "",
          v: view === "tile" ? "tile" : "",
          s: sf === "all" ? "" : sf,
        };
        const mkq = (o) => {
          const m = Object.assign({}, cur, o || {}),
            u = new URLSearchParams();
          ["r", "q", "below", "v", "s", "n"].forEach((k) => {
            if (m[k]) u.set(k, m[k]);
          });
          const t = u.toString();
          return "#/network" + (t ? "?" + t : "");
        };

        const Dx = D(),
          RS = REG();
        let list = Dx.stores.filter(
          (s) =>
            (rid === "all" || s.region === rid) &&
            (!sq || s.name.toLowerCase().includes(sq)) &&
            (!only || CB(s) < 95),
        );
        list.sort((a, b) => CB(a) - CB(b));
        const rs = RS.find(
          (r) => r.id === (rid === "all" && level === "region" ? DEMO_RG : rid),
        );

        const allScr = list.reduce((a, s) => a.concat(s.screens), []);
        const scr = allScr.filter((x) => sf === "all" || x.status === sf);
        const shownScr = scr.slice(0, +(q.get("n") || 96));
        const shown = list.slice(0, +(q.get("n") || 25));

        const exc = list
          .slice(0, 3)
          .map((s) => {
            const bad = s.screens.find((x) => x.cause) || s.screens[0];
            const c = bad.cause || CAUSES[0];
            return `<div class="exc" style="border-left-color:${OWNERS[c.o].c}">
      <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start">
        <div style="min-width:0"><h3>${esc(s.name)} — ${c.t.toLowerCase()}</h3><p>${excCopy(c.o, s)}</p></div>${ownTag(c.o)}
      </div><div class="meta">${s.screens.filter((x) => x.status !== "on").length} of ${s.screens.length} screens · ${pc(CB(s))} compliance · ${s.regionName}</div></div>`;
          })
          .join("");

        const tableBlock = `
  <div class="card pad0">
    <table><thead><tr><th>Store</th><th>Region</th><th class="r">Compliance</th><th class="r">On air</th><th style="width:120px">${PER.col}</th><th>Main cause</th></tr></thead><tbody>
    ${shown
      .map((s) => {
        const c = (s.screens.find((x) => x.cause) || {}).cause;
        return `<tr class="click" data-go="#/store/${s.id}">
        <td class="trunc" style="font-weight:500">${esc(s.name)}</td>
        <td style="color:var(--ink2)">${s.regionName}</td>
        <td class="r num" style="color:${cCol(CB(s))};font-weight:500">${pc(CB(s))}</td>
        <td class="r num" style="color:var(--ink2)">${s.screens.filter((x) => x.status === "on").length}/${s.screens.length}</td>
        <td>${txHTML(spark(CB(s)), "sm")}</td>
        <td>${c ? ownTag(c.o) + ' <span style="font-size:12px;color:var(--ink2)">' + esc(c.t) + "</span>" : '<span style="color:var(--ink3)">—</span>'}</td>
      </tr>`;
      })
      .join("")}
    </tbody></table>
    ${list.length > shown.length ? `<div style="padding:12px 14px;border-top:1px solid var(--line)"><button class="btn" data-go="${mkq({ n: String(shown.length + 50) })}">Show 50 more · ${list.length - shown.length} remaining</button></div>` : ""}
  </div>

  <div class="sec"><h2>Repeat offenders · last 30 days</h2>
  <div class="card pad0"><table><tbody>
    ${list
      .slice(0, 5)
      .map(
        (s, i) =>
          `<tr><td class="trunc">${esc(s.name)} · ${esc(s.screens[0].name.toLowerCase())}</td><td class="r mono" style="color:var(--ink2);font-size:11.5px">${[41, 28, 19, 17, 12][i]} incidents · ${["always 14:00–16:00", "weekday evenings", "after each update", "weekend mornings", "no clear pattern"][i]}</td></tr>`,
      )
      .join("")}
  </tbody></table></div></div>`;

        const tileBlock = `
  <div class="ctl mb10"><div class="seg" role="group" aria-label="Filter by state">
    <button data-go="${mkq({ s: "", n: "" })}" class="${sf === "all" ? "on" : ""}">All screens</button>
    <button data-go="${mkq({ s: "on", n: "" })}" class="${sf === "on" ? "on" : ""}">On air</button>
    <button data-go="${mkq({ s: "degraded", n: "" })}" class="${sf === "degraded" ? "on" : ""}">Showing something wrong</button>
    <button data-go="${mkq({ s: "off", n: "" })}" class="${sf === "off" ? "on" : ""}">Off air</button>
  </div></div>
  <div class="tiles">
    ${
      shownScr
        .map(
          (
            x,
          ) => `<div class="tile ${x.status === "off" ? "off" : x.status === "degraded" ? "warn" : ""}" data-go="#/store/${x.store}">
      <div class="scr">${x.status === "off" ? "no signal" : x.status === "degraded" ? "part blank" : "monsoon sale"}</div>
      <div class="lb"><span class="dot" style="background:${x.status === "on" ? "var(--on)" : x.status === "degraded" ? "#E8A33D" : "var(--off)"}"></span><span style="min-width:0"><span style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(STORE[x.store].name)}</span><span style="display:block;font-size:10.5px;color:var(--ink3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(x.name.toLowerCase())}</span></span></div>
    </div>`,
        )
        .join("") ||
      '<div class="card" style="grid-column:1/-1"><h2>No screens in this state</h2><p style="margin:6px 0 0;font-size:12.5px;color:var(--ink2)">Nothing here matches the current filters.</p></div>'
    }
  </div>
  ${scr.length > shownScr.length ? `<div class="mt16"><button class="btn" data-go="${mkq({ n: String(shownScr.length + 96) })}">Show 96 more · ${n0(scr.length - shownScr.length)} remaining</button></div>` : ""}`;

        return `
  <div class="pt"><h1>${rs && (rid !== "all" || level === "region") ? rs.name + " region" : "All stores"}</h1><span class="stamp">${view === "tile" ? `${n0(shownScr.length)} of ${n0(scr.length)} screens shown` : `${list.length} stores match`}</span></div>
  <p class="sub">${
    view === "tile"
      ? "What each screen is actually showing right now, rather than what it reports. A screen can be online and still be wrong — a blank zone or yesterday&rsquo;s campaign both look healthy in a status list."
      : "Ranked worst first. The list is for triage, so it defaults to the stores that need attention rather than the whole estate."
  }</p>

  <div class="ctl mb10">
    ${
      level === "org"
        ? `<div class="seg" role="group" aria-label="Region">
      <button data-go="${mkq({ r: "", n: "" })}" class="${rid === "all" ? "on" : ""}">All</button>
      ${RS.map((r) => `<button data-go="${mkq({ r: r.id, n: "" })}" class="${rid === r.id ? "on" : ""}">${r.name}</button>`).join("")}
    </div>`
        : ""
    }
    <input class="srch" id="q" placeholder="Find a store" value="${esc(q.get("q") || "")}">
    <button class="btn ${only ? "dark" : ""}" data-go="${mkq({ below: only ? "" : "1", n: "" })}">Below target only</button>
    <div class="topsp"></div>
    <div class="seg" role="group" aria-label="Layout">
      <button data-go="${mkq({ v: "", n: "" })}" class="${view === "table" ? "on" : ""}">Stores</button>
      <button data-go="${mkq({ v: "tile", n: "" })}" class="${view === "tile" ? "on" : ""}">Screens</button>
    </div>
  </div>

  ${
    rs
      ? `<div class="grid g4 mb10">
    ${stat("Region compliance", `<span style="color:${cCol(rs.comp)}">${pc(rs.comp)}</span>`)}
    ${stat("Against national", (rs.comp - AGGORG() > 0 ? "+" : "") + (rs.comp - AGGORG()).toFixed(1) + " pts")}
    ${stat("Stores at risk", `${rs.risk} <small>of ${rs.stores}</small>`)}
    ${stat("Screens on air", `${rs.online} <small>of ${rs.scr}</small>`)}
  </div>`
      : ""
  }

  ${view === "tile" ? tileBlock : tableBlock}

  ${exc ? `<div class="sec"><h2>Needs someone to act</h2><div class="grid" style="gap:8px">${exc}</div></div>` : ""}`;
      }
      function excCopy(o, s) {
        return {
          net: `The store's internet has been dropping in the same window each day. It recovers on its own, so this sits with the customer's IT team rather than with us.`,
          staff: `The screens are being powered down at the wall before the store closes. A word with the team on site should fix it.`,
          us: `A video is failing to finish playing on this hardware. That is ours — a fix is being tested.`,
          dev: `The player keeps restarting on its own. Likely a hardware or firmware fault on this display model.`,
          unk: `We can see the screens are not playing but the evidence so far does not point anywhere. Someone on site needs to look.`,
        }[o];
      }

      function vStore(id) {
        const s = STORE[id];
        if (!s) return `<h1>Store not found</h1>`;
        const sc = s.screens[0];
        const now = new Date();
        const days = Array.from({ length: PER.rows }, (_, i) => {
          if (PER.rows === 1) return "Today";
          const d = new Date(now.getTime() - (PER.rows - 1 - i) * 864e5);
          return (
            String(d.getDate()).padStart(2, "0") +
            "/" +
            String(d.getMonth() + 1).padStart(2, "0")
          );
        });
        return `
  <div class="pt"><div><h1>${esc(s.name)}</h1><p class="sub" style="margin:2px 0 0">${s.regionName} region · ${s.screens.length} screens · trades ${s.open}–${s.close}</p></div>
  <span class="plain ${cPill(CB(s))}" style="font-size:13px;padding:5px 11px">${pc(CB(s))} compliance</span></div>

  <div class="tiles mt22">
    ${s.screens
      .map(
        (
          x,
        ) => `<div class="tile ${x.status === "off" ? "off" : x.status === "degraded" ? "warn" : ""}" data-scr="${x.id}">
      <div class="scr">${x.status === "off" ? "no signal" : x.status === "degraded" ? "part blank" : "playing"}</div>
      <div class="lb"><span class="dot" style="background:${x.status === "on" ? "var(--on)" : x.status === "degraded" ? "#E8A33D" : "var(--off)"}"></span><span>${esc(x.name)}</span></div>
    </div>`,
      )
      .join("")}
  </div>

  <div class="card mt16">
    <div class="ch"><h2>${esc(sc.name)} — ${PER.label} on air</h2>${LEGEND}</div>
    <div class="txr">
      ${days.map((d, i) => `<span class="d">${d}</span>${txHTML(txDay(sc, i))}`).join("")}
      <span></span><div class="axis"><span>00:00</span><span>10:00</span><span>14:00</span><span>21:00</span><span>24:00</span></div>
    </div>
    <hr class="hr mt16"><p class="stat s" style="margin-top:12px;font-family:var(--f-ui);font-size:12.5px;color:var(--ink2)">
      ${CB(sc) < 85 ? "The same window is dark every afternoon. A repeating time-of-day pattern points at the store network, not at the screen." : "On air through trading hours all week, with no repeating pattern worth chasing."}</p>
  </div>

  <div class="grid g2 mt16">
    <div class="card">
      <div class="ch"><h2>Screen health</h2><span class="hint mono">${esc(sc.id)}</span></div>
      <table><tbody>
        <tr><td style="color:var(--ink2);padding-left:0">Player</td><td class="r" style="padding-right:0">${esc(sc.platform)}</td></tr>
        <tr><td style="color:var(--ink2);padding-left:0">Wi-Fi signal</td><td class="r mono" style="padding-right:0;color:${sc.rssi < -75 ? "var(--bad)" : "var(--ink)"}">${sc.rssi} dBm${sc.rssi < -75 ? " · weak" : ""}</td></tr>
        <tr><td style="color:var(--ink2);padding-left:0">Storage free</td><td class="r mono" style="padding-right:0">${sc.storage} GB</td></tr>
        <tr><td style="color:var(--ink2);padding-left:0">App version</td><td class="r mono" style="padding-right:0">${sc.app}${sc.app === "2.4.1" ? " · current" : " · behind"}</td></tr>
      </tbody></table>
    </div>
    <div class="card">
      <div class="ch"><h2>What happened</h2><span class="hint">plain language, newest first</span></div>
      <div class="log">
        <div><time>${sc.since}</time><p>${sc.status === "off" ? `Screen went off air. The store's internet was down at the time, so this one sits with the customer's IT team.` : "Playlist reloaded after a scheduled content update."}</p></div>
        <div><time>13:58</time><p>Wi-Fi signal dropped below usable strength.</p></div>
        <div><time>10:04</time><p>Screen came on and started the morning playlist.</p></div>
        <div><time>02:00</time><p>Overnight update installed without error.</p></div>
      </div>
    </div>
  </div>`;
      }

      function vCampaigns(q) {
        const id = q.get("c") || "c1",
          c0 = CAMPS.find((x) => x.id === id) || CAMPS[0];
        const f = D().totS / TOTS,
          pf =
            c0.status === "live"
              ? Math.min(1, PER.days / Math.max(1, c0.day))
              : 1,
          sk = (v) => Math.round(v * f * pf);
        const c = Object.assign({}, c0, {
          targets: sk(c0.targets),
          plays: sk(c0.plays),
          planned: sk(c0.planned),
          reach: sk(c0.reach),
          never: sk(c0.never),
          late: sk(c0.late),
          assets: c0.assets.map((a) => Object.assign({}, a, { p: sk(a.p) })),
        });
        const mx = Math.max(...DAYPART),
          mn = 60;
        return `
  <div class="pt"><h1>Campaigns</h1><span class="stamp">${CAMPS.length} campaigns</span></div>
  <p class="sub">Delivery is measured against what was scheduled, not against what was possible. Screens that never received the content are counted separately from screens that tried and failed.</p>

  <div class="seg mb10" role="group" aria-label="Campaign">
    ${CAMPS.map((x) => `<button data-go="#/campaigns?c=${x.id}" class="${x.id === c.id ? "on" : ""}">${esc(x.name)}</button>`).join("")}
  </div>

  <div class="card">
    <div class="ch">
      <div><h2>${esc(c.name)}</h2><p class="stat s" style="margin-top:3px">${c.from} – ${c.to} · ${n0(c.targets)} screens targeted · ${c.assets.length} creatives</p></div>
      <span class="plain ${c.status === "live" ? "p-ok" : c.status === "scheduled" ? "p-warn" : ""}" style="${c.status === "closed" ? "background:#EEF1F5;color:var(--ink2)" : ""}">${c.status === "live" ? `Live · day ${c.day} of ${c.len}` : c.status === "scheduled" ? "Starts in 11 days" : "Closed"}</span>
    </div>
    <div class="grid g4">
      ${stat("Delivered against plan", c.planned ? pc(c.deliv) : "—", c.planned ? `${n0(c.plays)} of ${n0(c.planned)}` : "not started")}
      ${stat("Reach", c.reach ? n0(c.reach) : "—", `of ${n0(c.targets)} screens targeted`)}
      ${stat("Frequency", c.freq ? c.freq + " <small>/day</small>" : "—", "plays per screen per day")}
      ${stat("Started on time", c.reach ? n0(c.reach - c.late) : "—", c.late ? `${c.late} started late` : "—")}
    </div>
  </div>

  <div class="sec"><h2>Creatives</h2>
    <div class="card pad0"><table>
      <thead><tr><th>Asset</th><th class="r">Plays</th><th class="r">Completed</th><th class="r">Share of air time</th><th class="r">Condition</th></tr></thead><tbody>
      ${c.assets
        .map(
          (a) => `<tr>
        <td style="font-weight:500">${esc(a.n)}</td>
        <td class="r num">${a.p ? n0(a.p) : "—"}</td>
        <td class="r num" style="color:${a.c ? cCol(a.c) : "var(--ink3)"}">${a.c ? pc(a.c) : "—"}</td>
        <td class="r num" style="color:var(--ink2)">${a.sh ? a.sh + "%" : "—"}</td>
        <td class="r">${a.h === "ok" ? '<span style="color:var(--ink3)">good</span>' : `<span class="plain ${a.h === "warn" ? "p-warn" : "p-bad"}">${esc(a.hn)}</span>`}</td>
      </tr>`,
        )
        .join("")}
    </tbody></table></div>
  </div>

  ${
    c.status !== "scheduled"
      ? `
  <div class="grid g2 mt16">
    <div class="card">
      <div class="ch"><h2>Delivery by hour</h2><span class="hint">share of scheduled plays that ran</span></div>
      <div class="air" style="height:104px">${DAYPART.map((v, i) => `<b style="height:${((v - mn) / (mx - mn)) * 100}%;background:${v < 85 ? "var(--warn)" : "var(--on)"}" title="${i + 10}:00 — ${v}% delivered"></b>`).join("")}</div>
      <div class="axis">${DAYPART.map((_, i) => `<span>${i + 10}</span>`).join("")}</div>
      <p class="stat s" style="margin-top:10px;font-family:var(--f-ui);font-size:12.5px;color:var(--ink2)">Mid-afternoon is the weak spot, and it is the same window as the East region outage.</p>
    </div>
    <div class="grid" style="gap:12px;align-content:start">
      <div class="card">
        <h2 style="margin-bottom:10px">Where it under-delivered</h2>
        ${[
          ["East region", "−14.2 pts"],
          ["Howrah AC Market", "−31.0 pts"],
          ["Sports range 20s on Tizen", "−9.8 pts"],
        ]
          .map(
            (r) =>
              `<div style="display:flex;justify-content:space-between;padding:5px 0;font-size:12.5px"><span style="color:var(--ink2)">${r[0]}</span><span class="mono">${r[1]}</span></div>`,
          )
          .join("")}
      </div>
      <div class="card">
        <h2 style="margin-bottom:6px">Never received the content</h2>
        <p class="v num" style="font-size:26px;color:var(--bad);margin:0 0 6px">${c.never} screens</p>
        <p style="margin:0;font-size:12.5px;color:var(--ink2)">These never acknowledged the download, so they were never going to play it. A different problem from a failed play, and it needs a different fix.</p>
      </div>
    </div>
  </div>
  <div class="ctl mt16">
    <button class="btn dark" data-act="Proof-of-play certificate generated">Proof-of-play certificate</button>
    <button class="btn" data-act="As-run log exported as CSV">Export as-run log</button>
    <button class="btn" data-act="Comparison opened against Summer sale 2026">Compare with a previous campaign</button>
  </div>`
      : `<div class="card mt16"><h2 style="margin-bottom:6px">Nothing to report yet</h2><p style="margin:0;font-size:12.5px;color:var(--ink2)">This campaign starts on ${c.from}. Delivery figures appear here from the first scheduled play.</p></div>`
  }`;
      }

      function vIssues(q) {
        const f = q.get("o") || "all";
        const all = issuesInScope();
        const list = all.filter((i) => f === "all" || i.o === f);
        return `
  <div class="pt"><h1>Open issues</h1><span class="stamp">${all.reduce((a, i) => a + i.n, 0)} screens affected across ${all.length} issues</span></div>
  <p class="sub">Screens failing for the same reason are grouped into one issue. At this fleet size a per-screen alert list stops being read within a week.</p>
  <div class="seg mb10" role="group" aria-label="Filter by owner">
    <button data-go="#/issues" class="${f === "all" ? "on" : ""}">Everything</button>
    ${Object.entries(OWNERS)
      .map(
        ([k, v]) =>
          `<button data-go="#/issues?o=${k}" class="${f === k ? "on" : ""}">${v.short}</button>`,
      )
      .join("")}
  </div>
  <div class="grid" style="gap:8px">
    ${
      list
        .map(
          (
            i,
          ) => `<div class="exc rise" style="border-left-color:${OWNERS[i.o].c}">
      <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start">
        <div style="min-width:0"><h3>${esc(fill(i.t, i))}</h3><p>${esc(fill(i.d, i))}</p></div>${ownTag(i.o)}
      </div>
      <div class="meta"><span>${i.st} stores</span>${i.meta.map((m) => `<span>${esc(m)}</span>`).join("")}</div>
      <div class="ctl mt16"><button class="btn" data-act="Evidence trail opened">Show the evidence</button><button class="btn" data-act="Issue assigned to ${OWNERS[i.o].short}">Assign to ${OWNERS[i.o].short}</button></div>
    </div>`,
        )
        .join("") ||
      '<div class="card"><h2>Nothing open here</h2><p style="margin:6px 0 0;font-size:12.5px;color:var(--ink2)">No issues are currently attributed to this owner.</p></div>'
    }
  </div>`;
      }

      /* ============ nav + router ============ */
      const store = {
        get(k) {
          try {
            return localStorage.getItem(k);
          } catch (e) {
            return null;
          }
        },
        set(k, v) {
          try {
            localStorage.setItem(k, v);
          } catch (e) {}
        },
      };
      let level = store.get("beamos.level") || "org";
      const HOME = () =>
        level === "store" ? "#/store/" + DEMO_ST : "#/overview";
      const LVL = { org: "Organisation", region: "Regional", store: "Store" };
      function navItems() {
        const Dn = D();
        if (level === "store")
          return [{ h: "#/store/" + DEMO_ST, t: "Store view" }];
        return [
          { h: "#/overview", t: "Overview" },
          { h: "#/network", t: "Stores", cnt: Dn.totSt },
          {
            h: "#/campaigns",
            t: "Campaigns",
            cnt: CAMPS.filter((c) => c.status === "live").length,
          },
          { h: "#/issues", t: "Issues", cnt: issuesInScope().length },
        ];
      }
      function drawNav(cur) {
        $("#nav").innerHTML = navItems()
          .map(
            (n) =>
              `<a href="${n.h}" class="${cur.startsWith(n.h) ? "on" : ""}"><span class="gl"></span>${n.t}${n.cnt != null ? `<span class="cnt">${n.cnt}</span>` : ""}</a>`,
          )
          .join("");
      }
      function crumbs(path, q) {
        const p = [["Demo space", level === "store" ? null : "#/overview"]];
        if (level === "region" && !path.startsWith("#/store/"))
          p.push([
            REGIONS.find((r) => r.id === DEMO_RG).name + " region",
            null,
          ]);
        if (path.startsWith("#/network")) {
          const r = REGIONS.find((x) => x.id === q.get("r"));
          p.push(["Stores", "#/network"]);
          if (r) p.push([r.name, null]);
        } else if (path.startsWith("#/store/")) {
          const s = STORE[path.split("/")[2]];
          if (level !== "store") {
            p.push(["Stores", "#/network"]);
            if (s) p.push([s.regionName, "#/network?r=" + s.region]);
          }
          if (s) p.push([s.name, null]);
        } else if (path.startsWith("#/campaigns")) p.push(["Campaigns", null]);
        else if (path.startsWith("#/issues")) p.push(["Issues", null]);
        else p.push(["Overview", null]);
        $("#crumb").innerHTML = p
          .map((x, i) => {
            const last = i === p.length - 1;
            const el =
              x[1] && !last
                ? `<a href="${x[1]}">${esc(x[0])}</a>`
                : `<b>${esc(x[0])}</b>`;
            return el;
          })
          .join(" <span>/</span> ");
      }
      function route() {
        if (
          level === "store" &&
          !(location.hash || "").startsWith("#/store/")
        ) {
          location.hash = "#/store/" + DEMO_ST;
          return;
        }
        const raw = location.hash || HOME();
        const [path, qs] = raw.split("?");
        const q = new URLSearchParams(qs || "");
        let html;
        if (path.startsWith("#/network")) html = vNetwork(q);
        else if (path.startsWith("#/store/")) html = vStore(path.split("/")[2]);
        else if (path.startsWith("#/campaigns")) html = vCampaigns(q);
        else if (path.startsWith("#/issues")) html = vIssues(q);
        else html = vOverview();
        $("#view").innerHTML = html;
        drawNav(path);
        crumbs(path, q);
        window.scrollTo({ top: 0 });
        if (path === "#/overview" || path === "#/" || !location.hash) countUp();
        $("#level").value = level;
        const qi = $("#q");
        if (qi) {
          qi.addEventListener("input", (e) => {
            clearTimeout(qi._t);
            qi._t = setTimeout(() => {
              const keep = new URLSearchParams();
              ["r", "below", "v", "s"].forEach((k) => {
                if (q.get(k)) keep.set(k, q.get(k));
              });
              if (e.target.value) keep.set("q", e.target.value);
              location.hash =
                "#/network" + (keep.toString() ? "?" + keep.toString() : "");
              setTimeout(() => {
                const f = $("#q");
                if (f) {
                  f.focus();
                  f.selectionStart = f.value.length;
                }
              }, 0);
            }, 260);
          });
        }
      }
      function countUp() {
        const el = $("#bigv");
        if (!el) return;
        const v = D().comp;
        if (matchMedia("(prefers-reduced-motion:reduce)").matches) {
          el.textContent = pc(v);
          return;
        }
        const t0 = performance.now();
        (function step(t) {
          const k = Math.min(1, (t - t0) / 620);
          el.textContent = pc(v * (1 - Math.pow(1 - k, 3)));
          if (k < 1) requestAnimationFrame(step);
        })(t0);
      }
      function stamp() {
        const d = new Date(),
          p = (n) => String(n).padStart(2, "0");
        const s = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} IST`;
        $("#railstamp").textContent = s;
        const a = $("#asof");
        if (a) a.textContent = `as of ${s} · 98.2% of fleet reporting`;
      }

      document.addEventListener("click", (e) => {
        const go = e.target.closest("[data-go]");
        if (go) {
          e.preventDefault();
          location.hash = go.dataset.go;
          return;
        }
        const scr = e.target.closest("[data-scr]");
        if (scr) {
          toast("Live view is not available in the demo");
          return;
        }
        const act = e.target.closest("[data-act]");
        if (act) {
          toast(act.dataset.act);
          return;
        }
      });
      $("#level").addEventListener("change", (e) => {
        level = e.target.value;
        store.set("beamos.level", level);
        const h = HOME();
        if (location.hash === h) {
          drawNav(h);
          route();
        } else location.hash = h;
      });
      const pop = $("#dpick");
      function markPeriod() {
        [...$("#period").children].forEach((x) =>
          x.classList.toggle("on", x.dataset.p === PER.k),
        );
      }
      function closePop() {
        pop.hidden = true;
      }
      $("#period").addEventListener("click", (e) => {
        const b = e.target.closest("button");
        if (!b) return;
        if (b.dataset.p === "c") {
          pop.hidden = !pop.hidden;
          return;
        }
        closePop();
        setPeriod(b.dataset.p);
        markPeriod();
        $("#pcustom").textContent = "Custom";
        toast("Showing " + PER.label);
        drawNav(location.hash);
        route();
      });
      $("#dcancel").addEventListener("click", closePop);
      $("#dapply").addEventListener("click", () => {
        const f = $("#dfrom").valueAsDate,
          t = $("#dto").valueAsDate;
        if (!f || !t || t < f) {
          $("#dnote").textContent =
            "Pick a start date on or before the end date.";
          $("#dnote").style.color = "var(--bad)";
          return;
        }
        $("#dnote").textContent = "Any range from 1 to 365 days.";
        $("#dnote").style.color = "";
        setPeriod("c", f, t);
        markPeriod();
        $("#pcustom").textContent = PER.label;
        closePop();
        toast("Showing " + PER.label + " · " + PER.days + " days");
        drawNav(location.hash);
        route();
      });
      document.addEventListener("click", (e) => {
        if (!pop.hidden && !e.target.closest(".perwrap")) closePop();
      });
      (function () {
        const t = new Date(),
          f = new Date(t.getTime() - 13 * 864e5),
          iso = (d) => d.toISOString().slice(0, 10);
        $("#dto").value = iso(t);
        $("#dto").max = iso(t);
        $("#dfrom").value = iso(f);
        $("#dfrom").max = iso(t);
      })();
      window.addEventListener("hashchange", route);
      $("#level").value = level;
      if (
        !location.hash ||
        (level === "store" && !location.hash.startsWith("#/store/"))
      )
        location.hash = HOME();
      route();
      stamp();
      setInterval(stamp, 1000);
