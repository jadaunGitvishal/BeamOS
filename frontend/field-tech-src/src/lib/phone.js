// Client-side phone normalization + validation. Mirrors normalizePhone() in
// server/routes/field-auth.js exactly, so the client rejects a bad number with
// a friendly message before the round trip - the server still re-validates.

export function normalizePhone(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.trim().replace(/[\s().-]/g, "");
  if (!/^\+?[1-9]\d{6,14}$/.test(s)) return null;
  return s;
}
