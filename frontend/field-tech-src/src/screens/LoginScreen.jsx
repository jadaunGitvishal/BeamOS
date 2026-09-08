import { useRef, useState } from "react";
import { postJson, getMe, setSession, NetworkError, ApiError } from "../lib/api.js";
import { normalizePhone } from "../lib/phone.js";

// ⚠️ DEV/TEST AID — remove together with the placeholder OTP backend.
// The backend (server/routes/field-auth.js) is a documented placeholder: it
// never sends an SMS, it accepts one hardcoded code. Surfacing that code on the
// OTP screen (clearly labelled) lets Stage B2 development + the browser
// verification test drive the real flow without an SMS provider. When
// field-auth.js gains a real provider, delete this constant and the <p class=
// "dev-note"> that renders it.
const DEV_OTP_CODE = "123456";

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
      setError("Enter a valid phone number (7–15 digits, optional leading +).");
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
      setError("Enter the numeric code from your text message.");
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
    <main className="screen">
      <div className="card">
        <h1 className="brand">BeamOS Field Tech</h1>

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
              placeholder="+1 555 123 4567"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
            {error && <p className="error" role="alert">{error}</p>}
            <button className="button" type="submit" disabled={busy}>
              {busy ? "Sending…" : "Send code"}
            </button>
            <p className="dev-note">
              Testing build — the code is not texted. Use <strong>{DEV_OTP_CODE}</strong>.
            </p>
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
              placeholder="123456"
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
