import { useRef, useState } from "react";
import { postJson, getMe, setSession, NetworkError, ApiError } from "../lib/api.js";
import { normalizePhone } from "../lib/phone.js";

// Phone -> OTP login. The backend (server/routes/field-auth.js) is a documented
// PLACEHOLDER: it never sends an SMS and accepts one hard-coded code. That code
// is deliberately NOT shown anywhere in this UI — a real technician must be
// given it out of band. (When field-auth.js gains a real SMS provider, nothing
// on this screen changes.)

export default function LoginScreen({ onAuthed }) {
  const [step, setStep] = useState("phone"); // "phone" | "otp"
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
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
      setSession(res.token, res.user);
      // Prefer the full profile; fall back to the compact user from verify.
      let me = res.user;
      try {
        me = await getMe();
      } catch {
        /* token is fresh; the compact user is enough for the home screen */
      }
      onAuthed(me);
    } catch (err) {
      setError(messageFor(err, "That code didn’t work. Try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="screen screen--brand">
      <div className="brandmark">
        <span className="brandmark__name">CXO1<span>.ai</span></span>
        <span className="brandmark__tag">Field Technician</span>
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
