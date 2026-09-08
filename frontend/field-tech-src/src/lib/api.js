// Field-tech API helpers.
//
// Token storage uses localStorage the same way the BeamOS Dashboard does
// (frontend/dashboard-src/src/lib/api.js) - but under a NAMESPACED key
// (`ft_token`), NOT the bare `token` key the main app / dashboard use. This app
// is served from the same origin as /app and /dashboard, so a bare key would be
// shared: a technician signing in on a shared phone would silently take over (or
// be taken over by) an operator's dashboard session. Namespacing keeps the two
// session lifecycles independent. The token itself is a normal BeamOS JWT
// (issued by POST /api/field-auth/verify-otp via the same generateToken the
// password login uses), so it works against every /api route unchanged.

const TOKEN_KEY = "ft_token";
const USER_KEY = "ft_user";

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function getStoredUser() {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function setSession(token, user) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
    if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
  } catch {
    /* private-mode / storage disabled - the app still works for this session */
  }
}

// Replace just the token (e.g. after POST /api/auth/switch-workspace mints a
// fresh JWT with the new current_workspace_id baked in), keeping the stored user.
export function setToken(token) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* ignore */
  }
}

export function clearSession() {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  } catch {
    /* ignore */
  }
}

// Thrown when the request never reached the server (offline, DNS, CORS, etc.).
export class NetworkError extends Error {
  constructor() {
    super("network");
    this.name = "NetworkError";
  }
}

// Thrown for a non-2xx response. `.message` is a human string (the server's
// { error } when present), never a raw JSON blob.
export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function readBody(resp) {
  try {
    return await resp.json();
  } catch {
    return null;
  }
}

export async function postJson(path, body) {
  let resp;
  try {
    resp = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new NetworkError();
  }
  const data = await readBody(resp);
  if (!resp.ok) {
    throw new ApiError(data?.error || `Request failed (${resp.status})`, resp.status);
  }
  return data;
}

// Authenticated request against the BeamOS API using the stored ft_token. A 401
// clears the session and throws ApiError(401) so the caller can bounce to login.
async function authFetch(path, { method = "GET", body } = {}) {
  let resp;
  try {
    resp = await fetch(path, {
      method,
      headers: {
        Authorization: `Bearer ${getToken()}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new NetworkError();
  }
  if (resp.status === 401) {
    clearSession();
    throw new ApiError("Your session has expired. Please sign in again.", 401);
  }
  const data = await readBody(resp);
  if (!resp.ok) {
    throw new ApiError(data?.error || `Request failed (${resp.status})`, resp.status);
  }
  return data;
}

export const apiGet = (path) => authFetch(path);
export const apiPost = (path, body) => authFetch(path, { method: "POST", body });
export const apiPatch = (path, body) => authFetch(path, { method: "PATCH", body });
export const getMe = () => authFetch("/api/auth/me");

// Authenticated multipart upload. The browser sets the multipart Content-Type
// (with boundary) itself, so we must NOT set it here. Same 401 handling as authFetch.
export async function apiUpload(path, formData) {
  let resp;
  try {
    resp = await fetch(path, {
      method: "POST",
      headers: { Authorization: `Bearer ${getToken()}` },
      body: formData,
    });
  } catch {
    throw new NetworkError();
  }
  if (resp.status === 401) {
    clearSession();
    throw new ApiError("Your session has expired. Please sign in again.", 401);
  }
  const data = await readBody(resp);
  if (!resp.ok) {
    throw new ApiError(data?.error || `Upload failed (${resp.status})`, resp.status);
  }
  return data;
}

// Browsers only expose crypto.randomUUID in a secure context (https or
// localhost). Fall back to a v4-shaped random id built from getRandomValues so
// the idempotency key still works on a plain-http LAN deployment.
export function newUuid() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch {
    /* fall through */
  }
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
