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

export async function getMe() {
  let resp;
  try {
    resp = await fetch("/api/auth/me", {
      headers: { Authorization: `Bearer ${getToken()}` },
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
    throw new ApiError(data?.error || `Could not load your profile (${resp.status})`, resp.status);
  }
  return data;
}
