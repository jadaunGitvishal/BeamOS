// Client-side phone canonicalization + validation. MIRRORS
// server/lib/field-phone.js exactly, so the client rejects a bad number with a
// friendly message before the round trip and — crucially — sends the SAME
// canonical E.164 form the server stores + looks up.
//
// The client can't read the server's FIELD_AUTH_DEFAULT_CC env var, so the
// default country code is a build-time literal here. If you retarget the
// server's CC, change DEFAULT_CC too and rebuild the field-tech bundle.
const DEFAULT_CC = "91"; // India — this is an India-facing tool
const ASSUMED_NSN_LEN = 10; // see the note in server/lib/field-phone.js

export function normalizePhone(raw, cc = DEFAULT_CC) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/[\s().-]/g, "");
  const CC = String(cc || "").replace(/\D/g, "");

  let e164;
  if (trimmed.startsWith("+")) {
    // Already international — never prepend a CC (a UK "+44…" stays "+44…").
    e164 = "+" + trimmed.slice(1).replace(/\D/g, "");
  } else {
    const digits = trimmed.replace(/\D/g, "").replace(/^0+/, ""); // drop national trunk prefix
    if (digits.length < 7) return null; // too few digits to be a real number
    if (CC && digits.startsWith(CC) && digits.length >= CC.length + ASSUMED_NSN_LEN) {
      e164 = "+" + digits;
    } else if (CC) {
      e164 = "+" + CC + digits;
    } else {
      e164 = "+" + digits;
    }
  }

  return /^\+[1-9]\d{6,14}$/.test(e164) ? e164 : null;
}
