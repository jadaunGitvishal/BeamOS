// Ref 30: "Copy code" behaviour for the public /activate/<code> page. Loaded as an
// external script (scriptSrc 'self') because an inline <script> is CSP-blocked and
// an inline onclick can't report navigator.clipboard's async success/failure.
//
// navigator.clipboard.writeText() requires a secure context (HTTPS or localhost),
// so on a plain-HTTP LAN install it is either absent or rejects. We try it, then
// the legacy execCommand path, then tell the installer to copy manually (the code
// element is `user-select: all`, so a long-press selects the whole thing).
(function () {
  var btn = document.getElementById('copyBtn');
  var codeEl = document.getElementById('code');
  var status = document.getElementById('copyStatus');
  if (!btn || !codeEl || !status) return;

  var MANUAL = "Couldn't auto-copy — press and hold the code above to copy it manually.";

  function ok() {
    status.textContent = 'Copied!';
    status.className = 'status ok';
  }
  function warn() {
    status.textContent = MANUAL;
    status.className = 'status warn';
    // Pre-select the code so the manual copy is one long-press away.
    try {
      var sel = window.getSelection();
      var range = document.createRange();
      range.selectNodeContents(codeEl);
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e) { /* selection API unavailable — the text is still selectable */ }
  }

  // Legacy fallback for non-secure contexts. Returns true only on a confirmed copy.
  function execCopy() {
    try {
      var sel = window.getSelection();
      var range = document.createRange();
      range.selectNodeContents(codeEl);
      sel.removeAllRanges();
      sel.addRange(range);
      var done = document.execCommand && document.execCommand('copy');
      sel.removeAllRanges();
      return !!done;
    } catch (e) {
      return false;
    }
  }

  btn.addEventListener('click', function () {
    var code = (codeEl.textContent || '').trim();
    status.textContent = '';
    status.className = 'status';

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code).then(ok, function () {
        // Rejected (usually the secure-context requirement) — try the old path.
        if (execCopy()) ok(); else warn();
      });
      return;
    }
    if (execCopy()) ok(); else warn();
  });
})();
