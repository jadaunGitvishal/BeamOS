/**
 * BeamOS - Raise Request
 *
 * Adds a "Raise Request" item to the sidebar under Displays, and a matching
 * button on the Displays page next to "Add Display". Both open the campaign
 * request form in a modal over the app.
 *
 * Self-contained. No build step, no dependencies, no markup changes.
 * It finds the existing Displays nav item and clones it, so it inherits
 * whatever classes and styling the sidebar already uses.
 *
 * Include once, after your other scripts:
 *   <script src="/js/beamos-raise-request.js"></script>
 */
(function () {
  "use strict";

  // ---------------------------------------------------------------- config
  var FORM_URL =
    "https://script.google.com/macros/s/AKfycbys1B1KY16w3STweJpJgoOzu1jtJL4Q_C-OxDfFBt1QbMLswF9W1IF1eRVroh98dxYI/exec";

  // How long to wait for the form to say hello before assuming the browser
  // blocked the frame and offering a new tab instead.
  var FRAME_TIMEOUT_MS = 3500;

  var LABEL = "Raise Request";
  var ANCHOR_NAV = "Displays"; // sidebar item to insert after
  var ANCHOR_BTN = "Add Display"; // page button to sit next to

  // Inbox / send icon, drawn to match typical line-icon sidebars.
  var ICON =
    '<path d="M4 4h16v12H7l-3 3V4z" fill="none" stroke="currentColor" ' +
    'stroke-width="1.8" stroke-linejoin="round"/>' +
    '<path d="M8 9h8M8 12h5" fill="none" stroke="currentColor" ' +
    'stroke-width="1.8" stroke-linecap="round"/>';

  // ------------------------------------------------------------- utilities
  function findByText(selector, text) {
    var nodes = document.querySelectorAll(selector);
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].textContent.trim() === text) return nodes[i];
    }
    return null;
  }

  /** Swap the visible label without disturbing the surrounding markup. */
  function setLabel(root, from, to) {
    var walk = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT,
      null,
      false,
    );
    var node;
    while ((node = walk.nextNode())) {
      if (node.nodeValue.trim() === from) {
        node.nodeValue = node.nodeValue.replace(from, to);
        return true;
      }
    }
    return false;
  }

  // ----------------------------------------------------------------- modal
  var open = false;

  function openForm() {
    if (open) return; // however many times they click
    open = true;

    var overlay = document.createElement("div");
    overlay.setAttribute("data-beamos-request", "overlay");
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:100000;background:rgba(8,12,18,.66);" +
      "display:flex;align-items:center;justify-content:center;padding:24px";

    var shell = document.createElement("div");
    // Structure only - no colours. The form paints its own background, so any
    // future restyling is a Form.html change and a redeploy, nothing here.
    shell.style.cssText =
      "width:min(1140px,96vw);height:min(880px,92vh);background:transparent;" +
      "border-radius:10px;overflow:hidden;position:relative;" +
      "box-shadow:0 24px 64px rgba(0,0,0,.55)";

    var frame = document.createElement("iframe");
    frame.src = FORM_URL;
    frame.title = "Raise a request";
    frame.style.cssText = "width:100%;height:100%;border:none;display:block";

    shell.appendChild(frame);
    overlay.appendChild(shell);
    document.body.appendChild(overlay);

    var prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    // The form says hello when it loads. Silence means the browser refused to
    // embed it - almost always this app's own frame-src policy. Rather than
    // show the client a blank grey box, fall back to a new tab.
    var ready = false;
    var watchdog = setTimeout(function () {
      if (!ready) showFallback();
    }, FRAME_TIMEOUT_MS);

    function showFallback() {
      shell.innerHTML = "";
      shell.style.height = "auto";
      shell.style.width = "min(520px,92vw)";
      shell.style.padding = "30px 32px";
      shell.style.font =
        '14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif';
      shell.style.color = "#E6EDF5";
      shell.innerHTML =
        '<div style="font-size:16px;font-weight:600;margin-bottom:8px">' +
        "Opening the request form</div>" +
        '<div style="color:#8B9BB0">This form opens in a separate tab.</div>' +
        '<p style="margin:24px 0 0">' +
        '<button type="button" id="beamosOpenTab" style="font:inherit;font-weight:600;' +
        "padding:9px 17px;border:none;border-radius:6px;background:#2563EB;color:#fff;" +
        'cursor:pointer">Open the form</button>' +
        '<button type="button" id="beamosCancel" style="font:inherit;padding:9px 17px;' +
        "margin-left:9px;border:1px solid rgba(255,255,255,.14);border-radius:6px;" +
        'background:#16202E;color:#E6EDF5;cursor:pointer">Cancel</button></p>' +
        '<p style="margin:22px 0 0;font-size:11px;color:#6B7C93">' +
        "Developer note: to show this inside BeamOS, add script.google.com and " +
        "script.googleusercontent.com to the frame-src directive of this app's " +
        "Content-Security-Policy.</p>";

      shell
        .querySelector("#beamosOpenTab")
        .addEventListener("click", function () {
          window.open(FORM_URL, "_blank", "noopener");
          shut();
        });
      shell.querySelector("#beamosCancel").addEventListener("click", shut);
    }

    function shut() {
      clearTimeout(watchdog);
      window.removeEventListener("message", onMessage);
      document.removeEventListener("keydown", onKey);
      overlay.remove();
      document.body.style.overflow = prevOverflow;
      open = false;
    }

    function onMessage(e) {
      if (!e.data || e.data.source !== "beamos-campaign-form") return;

      // Form loaded. Answer it, so it knows to draw its own close button and
      // to ask us to close rather than trying to navigate.
      if (e.data.status === "ready") {
        ready = true;
        clearTimeout(watchdog);
        try {
          (e.source || frame.contentWindow).postMessage(
            { source: "beamos-host", status: "hosted" },
            "*",
          );
        } catch (err) {}
        return;
      }

      // Saved. Tell the user; the form closes itself a moment later.
      if (e.data.status === "submitted") {
        toast("Request sent. Your reference is " + e.data.batch + ".");
        return;
      }

      if (e.data.status === "close") shut();
    }

    function onKey(e) {
      if (e.key === "Escape") shut();
    }

    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) shut();
    });
    window.addEventListener("message", onMessage);
    document.addEventListener("keydown", onKey);
  }

  function toast(text) {
    var t = document.createElement("div");
    t.textContent = text;
    t.style.cssText =
      "position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:100001;" +
      "background:#16202E;color:#E6EDF5;border:1px solid rgba(255,255,255,.12);" +
      'font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;' +
      "padding:12px 18px;border-radius:8px;box-shadow:0 10px 30px rgba(0,0,0,.5)";
    document.body.appendChild(t);
    setTimeout(function () {
      t.remove();
    }, 6000);
  }

  // ------------------------------------------------------------ sidebar item
  function addNavItem() {
    if (document.querySelector('[data-beamos-request="nav"]')) return;

    var anchor = findByText(
      "nav a, aside a, .sidebar a, nav button, aside button",
      ANCHOR_NAV,
    );
    if (!anchor) return;

    var item = anchor.cloneNode(true);
    item.setAttribute("data-beamos-request", "nav");

    // Strip anything that would make it behave like the item we copied.
    item.removeAttribute("href");
    item.removeAttribute("id");
    ["route", "view", "page", "nav", "target"].forEach(function (k) {
      item.removeAttribute("data-" + k);
    });
    item.className = anchor.className
      .split(/\s+/)
      .filter(function (c) {
        return !/active|current|selected/i.test(c);
      })
      .join(" ");
    item.style.cursor = "pointer";

    setLabel(item, ANCHOR_NAV, LABEL);

    var svg = item.querySelector("svg");
    if (svg) {
      svg.innerHTML = ICON;
      if (!svg.getAttribute("viewBox"))
        svg.setAttribute("viewBox", "0 0 24 24");
    }

    item.addEventListener("click", function (e) {
      e.preventDefault();
      openForm();
    });
    anchor.parentNode.insertBefore(item, anchor.nextSibling);
  }

  // -------------------------------------------------------- page-level button
  function addPageButton() {
    if (document.querySelector('[data-beamos-request="btn"]')) return;

    var addBtn = findByText("button, a", ANCHOR_BTN);
    if (!addBtn) return;

    var btn = addBtn.cloneNode(true);
    btn.setAttribute("data-beamos-request", "btn");
    btn.removeAttribute("href");
    btn.removeAttribute("id");
    setLabel(btn, ANCHOR_BTN, LABEL);

    var svg = btn.querySelector("svg");
    if (svg) svg.innerHTML = ICON;

    // Secondary treatment so "Add Display" stays the primary action.
    btn.style.background = "transparent";
    btn.style.border = "1px solid rgba(255,255,255,.22)";
    btn.style.marginRight = "10px";

    btn.addEventListener("click", function (e) {
      e.preventDefault();
      openForm();
    });
    addBtn.parentNode.insertBefore(btn, addBtn);
  }

  // ------------------------------------------------------------------ start
  function mount() {
    addNavItem();
    addPageButton();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }

  // The app re-renders views, so put them back if a redraw removes them.
  new MutationObserver(function () {
    mount();
  }).observe(document.body, { childList: true, subtree: true });

  // Optional: call BeamOSRaiseRequest.open() from anywhere else in the app.
  window.BeamOSRaiseRequest = { open: openForm };
})();
