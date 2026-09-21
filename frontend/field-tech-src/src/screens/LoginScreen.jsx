import { useRef, useState } from "react";
import { postJson, getMe, setSession, NetworkError, ApiError } from "../lib/api.js";
import { normalizePhone } from "../lib/phone.js";

// Phone -> OTP login. The backend (server/routes/field-auth.js) is a documented
// PLACEHOLDER: it never sends an SMS and accepts one hard-coded code. That code
// is deliberately NOT shown anywhere in this UI — a real technician must be
// given it out of band. (When field-auth.js gains a real SMS provider, nothing
// on this screen changes.)
//
// Ref 75: a second, independent login path for management (workspace
// viewer/admin, org admin) — plain email+password against the SAME
// POST /api/auth/login the main dashboard uses (routes/auth.js), not a new
// auth backend. Picking "Management sign-in" only swaps which form is shown;
// the phone+OTP form and submitPhone/submitCode below are untouched.

export default function LoginScreen({ onAuthed }) {
  // "phone" | "otp" | "email" — "email" is the new management path; "phone"
  // and "otp" are the original field-technician flow, unchanged.
  const [step, setStep] = useState("phone");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const sentToRef = useRef("");

  function messageFor(err, fallback) {
    if (err instanceof NetworkError) {
      return "Network error — check your connection and try again.";
    }
    if (err instanceof ApiError) return err.message;
    return fallback;
  }

  async function submitPhone(e) {
    e.preventDefault();
    if (busy) return;
    const normalized = normalizePhone(phone);
    if (!normalized) {
      setError("Enter a valid phone number — your 10-digit number, or with country code (+91…).");
      return;
    }
    setError("");
    setBusy(true);
    try {
      await postJson("/api/field-auth/send-otp", { phone: normalized });
      sentToRef.current = normalized;
      setPhone(normalized);
      setCode("");
      setStep("otp");
    } catch (err) {
      setError(messageFor(err, "Could not send the code. Try again."));
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(e) {
    e.preventDefault();
    if (busy) return;
    const trimmed = code.trim();
    if (!/^\d{4,8}$/.test(trimmed)) {
      setError("Enter the numeric code you were given.");
      return;
    }
    setError("");
    setBusy(true);
    try {
      const res = await postJson("/api/field-auth/verify-otp", {
        phone: sentToRef.current,
        code: trimmed,
      });
      setSession(res.token, res.user, "technician");
      // Prefer the full profile; fall back to the compact user from verify.
      let me = res.user;
      try {
        me = await getMe();
      } catch {
        /* token is fresh; the compact user is enough for the home screen */
      }
      onAuthed(me, "technician");
    } catch (err) {
      setError(messageFor(err, "That code didn’t work. Try again."));
    } finally {
      setBusy(false);
    }
  }

  // Ref 75: management sign-in. Plain email+password against the SAME
  // POST /api/auth/login the dashboard uses (routes/auth.js) - not a new auth
  // backend, and it mints the identical BeamOS JWT verify-otp above does
  // (both call middleware/auth.generateToken). TOTP-enabled accounts get a
  // clear message rather than a half-built MFA flow here - out of scope for a
  // report-viewing surface, use the desktop dashboard instead.
  async function submitEmail(e) {
    e.preventDefault();
    if (busy) return;
    if (!email.trim() || !password) {
      setError("Enter your email and password.");
      return;
    }
    setError("");
    setBusy(true);
    try {
      const res = await postJson("/api/auth/login", { email: email.trim(), password });
      if (res.mfa_required) {
        setError("Two-factor accounts aren't supported here yet — sign in on the desktop dashboard instead.");
        return;
      }
      setSession(res.token, res.user, "management");
      let me = res.user;
      try {
        me = await getMe();
      } catch {
        /* token is fresh; the compact user is enough for the home screen */
      }
      onAuthed(me, "management");
    } catch (err) {
      setError(messageFor(err, "Could not sign in. Check your email and password."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="screen screen--brand">
      <div className="brandmark">
        <span className="brandmark__name">CXO1<span>.ai</span></span>
        <span className="brandmark__tag">{step === "email" ? "Management Reports" : "Field Technician"}</span>
      </div>

      <div className="card">
        {step === "phone" && (
          <form onSubmit={submitPhone} noValidate>
            <label className="field-label" htmlFor="phone">
              Phone number
            </label>
            <input
              id="phone"
              className="input"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              autoFocus
              placeholder="+91 98765 43210"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
            {error && <p className="error" role="alert">{error}</p>}
            <button className="button" type="submit" disabled={busy}>
              {busy ? "Sending…" : "Send code"}
            </button>
            <button
              className="button button--link"
              type="button"
              disabled={busy}
              onClick={() => {
                setStep("email");
                setError("");
              }}
            >
              Management sign-in
            </button>
          </form>
        )}

        {step === "email" && (
          <form onSubmit={submitEmail} noValidate>
            <label className="field-label" htmlFor="mgmt-email">
              Email
            </label>
            <input
              id="mgmt-email"
              className="input"
              type="email"
              inputMode="email"
              autoComplete="username"
              autoFocus
              placeholder="you@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <label className="field-label" htmlFor="mgmt-password">
              Password
            </label>
            <input
              id="mgmt-password"
              className="input"
              type="password"
              autoComplete="current-password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {error && <p className="error" role="alert">{error}</p>}
            <button className="button" type="submit" disabled={busy}>
              {busy ? "Signing in…" : "Sign in"}
            </button>
            <button
              className="button button--link"
              type="button"
              disabled={busy}
              onClick={() => {
                setStep("phone");
                setError("");
                setPassword("");
              }}
            >
              Field technician sign-in
            </button>
          </form>
        )}

        {step === "otp" && (
          <form onSubmit={submitCode} noValidate>
            <p className="muted">
              Enter the 6-digit code for <strong>{sentToRef.current}</strong>.
            </p>
            <label className="field-label" htmlFor="code">
              Verification code
            </label>
            <input
              id="code"
              className="input input--code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              maxLength={8}
              placeholder="——————"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/[^\d]/g, ""))}
            />
            {error && <p className="error" role="alert">{error}</p>}
            <button className="button" type="submit" disabled={busy}>
              {busy ? "Verifying…" : "Verify"}
            </button>
            <button
              className="button button--link"
              type="button"
              disabled={busy}
              onClick={() => {
                setStep("phone");
                setError("");
                setCode("");
              }}
            >
              Change number
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
