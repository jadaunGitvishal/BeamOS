'use strict';

// Ref 30: the public activation-code landing page (GET /activate/:code).
//
// The registration-code QR (GET /api/provisioning/registration-codes/:id/qr)
// encodes a LINK to this page rather than the bare 6-digit number, so scanning it
// with a phone camera opens a clean confirmation page instead of triggering the
// phone's default "search the web for this number" behavior.
//
// No auth: the code is already printed on / shown in the QR the installer is
// holding, and the actual claim (POST .../registration-codes/claim) is the
// rate-limited security boundary. This page only DISPLAYS the code for the
// installer to type into the display's setup screen.

const { asyncHandler } = require('./async-handler');

const CODE_RE = /^[0-9]{6}$/;

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Pure renderer. `code` is the validated 6-digit string when the URL carried a
// well-formed code, else null. `found` is whether that code exists in
// registration_codes. Returns a self-contained HTML document (inline <style> +
// one inline onclick handler — both allowed by the app CSP; no <script> block).
function renderActivatePage({ code, found }) {
  const ok = !!code && found;
  const inner = ok
    ? `
      <p class="label">Activation Code</p>
      <p class="code">${esc(code)}</p>
      <p class="hint">Type this code into the display's setup screen.</p>
      <button class="copy" type="button"
        onclick="if(navigator.clipboard){navigator.clipboard.writeText('${esc(code)}');this.textContent='Copied'}">Copy code</button>`
    : `
      <p class="code notfound">Code not found</p>
      <p class="hint">${code
        ? "That activation code doesn't exist. Check for a typo, or generate a new one from the dashboard."
        : "That doesn't look like a valid 6-digit activation code."}</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Activate a display &mdash; BeamOS</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #111827; color: #e5e7eb; padding: 24px;
    font-family: -apple-system, system-ui, "Segoe UI", Roboto, sans-serif;
  }
  .card {
    width: 100%; max-width: 420px; text-align: center;
    background: #1f2937; border: 1px solid #374151; border-radius: 16px; padding: 32px 24px;
  }
  .brand { color: #3b82f6; font-weight: 700; font-size: 18px; letter-spacing: .02em; margin: 0 0 24px; }
  .label { color: #9ca3af; font-size: 13px; text-transform: uppercase; letter-spacing: .08em; margin: 0 0 8px; }
  .code {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: clamp(40px, 14vw, 64px); font-weight: 700; letter-spacing: .12em;
    color: #3b82f6; margin: 0; line-height: 1.1; word-break: break-word;
  }
  .code.notfound { color: #f87171; font-size: clamp(24px, 8vw, 32px); letter-spacing: normal; }
  .hint { color: #9ca3af; font-size: 15px; line-height: 1.5; margin: 16px 0 0; }
  .copy {
    margin-top: 24px; font: inherit; font-size: 15px; font-weight: 600; width: 100%;
    background: #3b82f6; color: #fff; border: 0; border-radius: 10px; padding: 12px 20px; cursor: pointer;
  }
  .copy:active { background: #2563eb; }
</style>
</head>
<body>
  <div class="card">
    <p class="brand">BeamOS</p>${inner}
  </div>
</body>
</html>`;
}

// Express handler for GET /activate/:code. Looks the code up so a typo'd / stale
// URL gets the "Code not found" message rather than a confidently-wrong display.
// Always 200 with a rendered page (never a bare error page). Requires db lazily
// to avoid a load-time cycle, same as the other server.js route helpers.
const activateHandler = asyncHandler(async (req, res) => {
  const raw = String(req.params.code || '').trim();
  const valid = CODE_RE.test(raw);
  let found = false;
  if (valid) {
    const { db } = require('../db/database');
    found = !!(await db.prepare('SELECT 1 FROM registration_codes WHERE code = ?').get(raw));
  }
  res.type('html').set('Cache-Control', 'no-store');
  res.send(renderActivatePage({ code: valid ? raw : null, found }));
});

module.exports = { renderActivatePage, activateHandler, CODE_RE };
