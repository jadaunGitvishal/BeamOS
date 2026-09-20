import { useEffect, useRef, useState } from "react";
import { apiUpload, apiPatch, newUuid, NetworkError, ApiError } from "../lib/api.js";
import { hardwarePrefill } from "../lib/hardware-prefill.js";

// Stage B2b: the completion form for an already-started visit — technical
// fields, geotagged photos (one GPS fix captured per photo, the moment it's
// taken), then upload-all + PATCH-complete.
//
// GPS rule: the ONLY source of a photo's coordinates is
// navigator.geolocation.getCurrentPosition. There is deliberately NO manual
// lat/long input anywhere — the backend already rejects a photo without a valid
// fix (Ref 43 Stage A), and letting a technician type coordinates would defeat
// the point of geotagging.

const DEVICE_STATUS_OPTIONS = ["Working", "Working with issues", "Faulty", "Replaced", "Removed"];
const TEXT_FIELDS = [
  ["serial_number", "Serial number", "e.g. SN-48210-A"],
  ["mac_address", "MAC address", "e.g. AA:BB:CC:DD:EE:FF"],
  ["device_model", "Device model", "e.g. BeamBox 3"],
  ["sim_network_info", "SIM / network", "e.g. Airtel 4G, signal 3/4"],
];
// Warn (don't block) above this — a phone fix this loose isn't trustworthy for
// "was the tech actually at the screen".
const ACCURACY_WARN_M = 100;

function geoMessage(err) {
  switch (err && err.code) {
    case 1: return "Location permission denied. Allow location access for this site in your browser settings, then retake the photo.";
    case 2: return "GPS position unavailable. Move to an open area away from buildings and retake the photo.";
    case 3: return "GPS timed out. Retake the photo to try again.";
    default: return "Couldn't get a location fix. Retake the photo.";
  }
}

function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject({ code: 2, message: "no geolocation support" });
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 15000,
      maximumAge: 0,
    });
  });
}

export default function CompletionForm({ workspaceId, visitId, deviceName, device, telemetryCaptured, onCompleted, onSessionExpired }) {
  // Computed once on mount: these are DEFAULT values, not locked — the technician
  // can overwrite any of them (a swapped-but-not-yet-re-paired device has stale
  // cached info; a serial number is often only readable off a sticker in person).
  const [prefill] = useState(() => hardwarePrefill(device));
  // Ref 43: installed_at isn't one of hardwarePrefill()'s marker-stripped
  // fields - devices.installed_at is either a real 'YYYY-MM-DD' or absent,
  // never one of Android's "unavailable"/"no SIM"-style honest markers, so
  // there's nothing to strip. Read it straight off the device row.
  const [fields, setFields] = useState(() => ({
    serial_number: prefill.serial_number,
    mac_address: prefill.mac_address,
    device_model: prefill.device_model,
    sim_network_info: prefill.sim_network_info,
    installed_at: (device && device.installed_at) || "",
    // Ref 52: same reasoning as installed_at directly above - devices.warranty_expiry_date
    // is either a real 'YYYY-MM-DD' or absent, read straight off the device row.
    warranty_expiry_date: (device && device.warranty_expiry_date) || "",
    remarks: "",
  }));
  const [deviceStatus, setDeviceStatus] = useState("");
  const [photos, setPhotos] = useState([]); // see addPhoto() for shape
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState(null); // { done, total } while uploading
  const [phase, setPhase] = useState("form"); // "form" | "retry"

  const fileRef = useRef(null);

  // Revoke every preview object-URL on unmount (photos held in a ref to dodge
  // the stale-closure trap).
  const photosRef = useRef(photos);
  photosRef.current = photos;
  useEffect(() => () => photosRef.current.forEach((p) => URL.revokeObjectURL(p.url)), []);

  const setField = (k) => (e) => setFields((f) => ({ ...f, [k]: e.target.value }));

  function triggerCamera() {
    setError("");
    fileRef.current?.click();
  }

  async function onFileChosen(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = ""; // let the same file be chosen again / camera reopen
    if (!file) {
      // <input capture> gives NO javascript signal that distinguishes "camera
      // permission denied" from "user backed out" — both return an empty
      // selection. (True camera-permission detection needs getUserMedia + a
      // custom capture UI, which the spec's `<input type=file capture>`
      // approach rules out.) Neutral, actionable message covering both.
      setError("No photo was captured. Tap “Add photo” to try again — if the camera doesn't open, check this site's camera permission in your browser settings.");
      return;
    }
    const key = newUuid();
    const url = URL.createObjectURL(file);
    setPhotos((p) => [
      ...p,
      { key, file, url, gps: "capturing", coords: null, message: "", lowAccuracy: false, uploaded: false, uploadError: "" },
    ]);
    try {
      const pos = await getPosition();
      const { latitude, longitude, accuracy } = pos.coords;
      const low = typeof accuracy === "number" && accuracy > ACCURACY_WARN_M;
      setPhotos((p) =>
        p.map((x) =>
          x.key === key
            ? {
                ...x,
                gps: "ok",
                coords: { latitude, longitude, accuracy, timestamp: pos.timestamp },
                lowAccuracy: low,
                message: low
                  ? `Low GPS accuracy (±${Math.round(accuracy)} m). Move to open sky and retake for a better fix — or keep it.`
                  : "",
              }
            : x,
        ),
      );
    } catch (err) {
      setPhotos((p) => p.map((x) => (x.key === key ? { ...x, gps: "error", message: geoMessage(err) } : x)));
    }
  }

  function removePhoto(key) {
    setPhotos((p) => {
      const t = p.find((x) => x.key === key);
      if (t) URL.revokeObjectURL(t.url);
      return p.filter((x) => x.key !== key);
    });
  }
  function retakePhoto(key) {
    removePhoto(key);
    triggerCamera();
  }

  const allHaveGps = photos.length > 0 && photos.every((p) => p.gps === "ok");
  const canSubmit = !submitting && allHaveGps && !!deviceStatus;

  function payload() {
    const out = { device_status: deviceStatus, status: "completed" };
    for (const [k] of TEXT_FIELDS) {
      const v = fields[k].trim();
      if (v) out[k] = v;
    }
    // Ref 43: installed_at isn't in TEXT_FIELDS - it updates devices.installed_at
    // server-side, not a field_visits column, so it's sent alongside rather than
    // looped with the free-text fields above.
    if (fields.installed_at) out.installed_at = fields.installed_at;
    // Ref 52: same reasoning - updates devices.warranty_expiry_date server-side,
    // not a field_visits column.
    if (fields.warranty_expiry_date) out.warranty_expiry_date = fields.warranty_expiry_date;
    const remarks = fields.remarks.trim();
    if (remarks) out.remarks = remarks;
    return out;
  }

  async function submit() {
    if (submitting) return;
    if (photos.length === 0) return setError("Add at least one photo before submitting.");
    if (!deviceStatus) return setError("Select the device status before submitting.");
    if (photos.some((p) => p.gps !== "ok")) {
      return setError("Every photo needs a GPS location. Retake or delete the photos marked in red.");
    }
    setError("");
    setSubmitting(true);

    const pending = photos.filter((p) => !p.uploaded);
    let done = photos.length - pending.length;
    setProgress({ done, total: photos.length });

    let failed = 0;
    for (const ph of pending) {
      try {
        const fd = new FormData();
        fd.append("photo", ph.file, ph.file.name || "photo.jpg");
        fd.append("latitude", String(ph.coords.latitude));
        fd.append("longitude", String(ph.coords.longitude));
        fd.append("gps_accuracy_meters", String(ph.coords.accuracy));
        await apiUpload(`/api/workspaces/${workspaceId}/field-visits/${visitId}/photos`, fd);
        done += 1;
        setPhotos((p) => p.map((x) => (x.key === ph.key ? { ...x, uploaded: true, uploadError: "" } : x)));
        setProgress({ done, total: photos.length });
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return onSessionExpired();
        failed += 1;
        const msg = err instanceof NetworkError ? "Network error" : err.message || "Upload failed";
        setPhotos((p) => p.map((x) => (x.key === ph.key ? { ...x, uploadError: msg } : x)));
      }
    }

    if (failed > 0) {
      setError(
        `${done} of ${photos.length} photo${photos.length === 1 ? "" : "s"} uploaded. ` +
          `${failed} failed — still saved on this screen. Check your connection and tap “Retry upload”.`,
      );
      setPhase("retry");
      setSubmitting(false);
      setProgress(null);
      return;
    }

    // Every photo is up — record the technical fields and mark the visit complete.
    try {
      const visit = await apiPatch(`/api/workspaces/${workspaceId}/field-visits/${visitId}`, payload());
      setProgress(null);
      onCompleted(visit, photos.length);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onSessionExpired();
      setError(
        "All photos uploaded, but the visit couldn't be marked complete: " +
          (err instanceof NetworkError ? "network error." : err.message) +
          " Tap “Retry upload” to finish.",
      );
      setPhase("retry");
      setSubmitting(false);
      setProgress(null);
    }
  }

  const submitLabel = submitting
    ? progress
      ? `Uploading ${progress.done}/${progress.total}…`
      : "Finishing…"
    : phase === "retry"
      ? "Retry upload"
      : "Submit visit";

  return (
    <>
      <p className="step-title">Complete the visit</p>
      <dl className="kv">
        <dt>Device</dt><dd>{deviceName}</dd>
        <dt>Visit ID</dt><dd className="mono-sm">{visitId}</dd>
        <dt>Telemetry</dt><dd>{telemetryCaptured ? "snapshot captured" : "none on file"}</dd>
      </dl>
      <p className="muted">This visit is saved. Fill in what you can and submit when you're done.</p>

      {/* ---- technical fields ---- */}
      {TEXT_FIELDS.map(([k, label, ph]) => (
        <div className="form-field" key={k}>
          <label className="field-label" htmlFor={`f-${k}`}>
            {label}
            {prefill[k] && <span className="muted-inline"> · from device records, edit if changed</span>}
          </label>
          <input
            id={`f-${k}`}
            className="input"
            type="text"
            autoCapitalize={k === "mac_address" || k === "serial_number" ? "characters" : "sentences"}
            autoCorrect="off"
            placeholder={ph}
            value={fields[k]}
            onChange={setField(k)}
          />
        </div>
      ))}

      {/* Ref 43: separate from TEXT_FIELDS above - a date input, not free text,
          and it updates devices.installed_at directly rather than a field_visits
          column (see payload()). Same visual pattern as the other 4 fields. */}
      <div className="form-field">
        <label className="field-label" htmlFor="f-installed_at">
          Installation date
          {device && device.installed_at && <span className="muted-inline"> · from device records, edit if changed</span>}
        </label>
        <input
          id="f-installed_at"
          className="input"
          type="date"
          max={new Date().toISOString().slice(0, 10)}
          value={fields.installed_at}
          onChange={setField("installed_at")}
        />
      </div>

      {/* Ref 52: same pattern as installed_at above - a date input that updates
          devices.warranty_expiry_date directly (see payload()). Deliberately no
          `max` here - unlike an installation date, a warranty expiry is expected
          to be in the future. */}
      <div className="form-field">
        <label className="field-label" htmlFor="f-warranty_expiry_date">
          Warranty expiry date
          {device && device.warranty_expiry_date && <span className="muted-inline"> · from device records, edit if changed</span>}
        </label>
        <input
          id="f-warranty_expiry_date"
          className="input"
          type="date"
          value={fields.warranty_expiry_date}
          onChange={setField("warranty_expiry_date")}
        />
      </div>

      <div className="form-field">
        <p className="field-label">Device status</p>
        <div className="choice-group">
          {DEVICE_STATUS_OPTIONS.map((s) => (
            <button
              key={s}
              type="button"
              className={`choice ${deviceStatus === s ? "choice--on" : ""}`}
              aria-pressed={deviceStatus === s}
              onClick={() => setDeviceStatus(s)}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      <div className="form-field">
        <label className="field-label" htmlFor="f-remarks">Remarks</label>
        <textarea
          id="f-remarks"
          className="input textarea"
          rows={4}
          placeholder="Anything worth noting about this visit"
          value={fields.remarks}
          onChange={setField("remarks")}
        />
      </div>

      {/* ---- photos ---- */}
      <p className="field-label">Photos <span className="muted-inline">({photos.length})</span></p>
      <p className="step-sub">Each photo is geotagged with your location at the moment you take it.</p>

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={onFileChosen}
        hidden
      />

      {photos.map((p) => (
        <div className="photo-card" key={p.key}>
          <img className="photo-card__img" src={p.url} alt="Visit photo" />
          <div className="photo-card__body">
            {p.gps === "capturing" && <p className="photo-gps photo-gps--wait">Getting GPS location…</p>}
            {p.gps === "ok" && (
              <p className={`photo-gps ${p.lowAccuracy ? "photo-gps--warn" : "photo-gps--ok"}`}>
                {p.coords.latitude.toFixed(6)}, {p.coords.longitude.toFixed(6)}
                {" · ±"}{Math.round(p.coords.accuracy)} m
              </p>
            )}
            {p.gps === "error" && <p className="photo-gps photo-gps--err" role="alert">{p.message}</p>}
            {p.gps === "ok" && p.message && <p className="photo-gps photo-gps--warn">{p.message}</p>}
            {p.uploaded && <p className="photo-gps photo-gps--ok">Uploaded ✓</p>}
            {p.uploadError && <p className="photo-gps photo-gps--err" role="alert">Upload failed: {p.uploadError}</p>}
            {!p.uploaded && (
              <div className="photo-actions">
                <button type="button" className="button button--sm button--secondary" onClick={() => retakePhoto(p.key)}>
                  Retake
                </button>
                <button type="button" className="button button--sm button--danger" onClick={() => removePhoto(p.key)}>
                  Delete
                </button>
              </div>
            )}
          </div>
        </div>
      ))}

      <button type="button" className="button button--secondary" onClick={triggerCamera} disabled={submitting}>
        {photos.length === 0 ? "Add photo" : "Add another photo"}
      </button>

      {error && <p className="error" role="alert">{error}</p>}
      {!allHaveGps && photos.length > 0 && !error && (
        <p className="muted">Waiting for a GPS fix on every photo before you can submit.</p>
      )}

      <button type="button" className="button" onClick={submit} disabled={!canSubmit}>
        {submitLabel}
      </button>
      {photos.length === 0 && <p className="muted">At least one photo is required to submit.</p>}
    </>
  );
}
