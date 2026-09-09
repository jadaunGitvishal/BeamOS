import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { apiFetch, apiObjectUrl } from "../lib/api";
import { osmUrl, formatDuration, n0 } from "../lib/format";

// Ref 43 Stage C — field-visit history on the Device Detail page.
//
// `visits` is the LIST-endpoint payload (GET /api/workspaces/:id/field-visits
// ?device_id=), newest-first — it carries the technical fields + technical_metrics
// but NOT photos. Each visit's photos come from the DETAIL endpoint, fetched once
// per visit id (cached), so the list poll stays a single cheap request.
//
// null  -> section unavailable (endpoint 403'd or errored) — degrade like AuditTrail
// []    -> device has no field visits — explicit empty state
export default function FieldVisits({ visits, workspaceId }) {
  const [detailsById, setDetailsById] = useState({});
  const [openId, setOpenId] = useState(null);
  const requestedRef = useRef(new Set());

  useEffect(() => {
    if (!visits || !visits.length || !workspaceId) return;
    const todo = visits.filter((v) => !requestedRef.current.has(v.id));
    if (!todo.length) return;
    todo.forEach((v) => requestedRef.current.add(v.id));
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        todo.map(async (v) => {
          try {
            return [v.id, await apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/field-visits/${encodeURIComponent(v.id)}`)];
          } catch {
            requestedRef.current.delete(v.id); // let a later poll retry
            return [v.id, null];
          }
        }),
      );
      if (!cancelled) setDetailsById((prev) => ({ ...prev, ...Object.fromEntries(entries) }));
    })();
    return () => {
      cancelled = true;
    };
  }, [visits, workspaceId]);

  if (visits == null) {
    return <p className="empty" style={{ padding: 0 }}>Field visits aren’t available for this device.</p>;
  }
  if (!visits.length) {
    return (
      <p className="empty" style={{ padding: 0 }}>
        No field visits have been logged for this device yet. A technician records one from the BeamOS Field Tech app when they’re on site.
      </p>
    );
  }

  return (
    <div className="fv-list">
      {visits.map((v) => {
        const det = detailsById[v.id];
        const photoCount = det ? (det.photos || []).length : null;
        const open = openId === v.id;
        return (
          <div key={v.id}>
            <button
              type="button"
              className={"fv-row" + (open ? " open" : "")}
              aria-expanded={open}
              onClick={() => setOpenId(open ? null : v.id)}
            >
              <span className="fv-main">
                <span className="fv-tech">{v.technician_email || "Unknown technician"}</span>
                <span className="fv-sub">
                  {new Date(v.created_at * 1000).toLocaleString()} · {v.visit_type}
                </span>
              </span>
              <span className="fv-right">
                <span className={"tag " + (v.status === "completed" ? "p-ok" : "p-warn")}>
                  {v.status === "completed" ? "completed" : "in progress"}
                </span>
                <span className="fv-count">
                  {photoCount == null ? "…" : `${photoCount} photo${photoCount === 1 ? "" : "s"}`}
                </span>
              </span>
            </button>
            {open && <VisitDetail visit={v} detail={det} workspaceId={workspaceId} />}
          </div>
        );
      })}
    </div>
  );
}

function VisitDetail({ visit, detail, workspaceId }) {
  const tech = [
    ["Serial number", visit.serial_number],
    ["MAC address", visit.mac_address],
    ["Device model", visit.device_model],
    ["SIM / network", visit.sim_network_info],
    ["Device status", visit.device_status],
    ["Remarks", visit.remarks],
  ].filter(([, val]) => val != null && String(val).trim() !== "");

  const m = visit.technical_metrics || null;
  const metricRows = m
    ? [
        ["Battery", m.battery_level != null ? `${m.battery_level}%${m.battery_charging ? " ⚡" : ""}` : null],
        ["Storage free", m.storage_free_mb != null ? `${n0(m.storage_free_mb)} MB${m.storage_total_mb ? ` of ${n0(m.storage_total_mb)} MB` : ""}` : null],
        ["RAM free", m.ram_free_mb != null ? `${n0(m.ram_free_mb)} MB${m.ram_total_mb ? ` of ${n0(m.ram_total_mb)} MB` : ""}` : null],
        ["Wi-Fi", m.wifi_ssid ? `${m.wifi_ssid}${m.wifi_rssi != null ? ` (${m.wifi_rssi} dBm)` : ""}` : m.wifi_rssi != null ? `${m.wifi_rssi} dBm` : null],
        ["Uptime", m.uptime_seconds != null ? formatDuration(m.uptime_seconds) : null],
        ["Telemetry age", m.telemetry_reported_at ? new Date(m.telemetry_reported_at * 1000).toLocaleString() : null],
      ].filter(([, val]) => val != null)
    : [];

  const photos = detail?.photos || [];

  // Fetch a blob: URL for every photo once, so the thumbnail grid AND the
  // lightbox share one fetch each and Next/Prev is flicker-free.
  const [urls, setUrls] = useState({}); // photoId -> blob url ("" = failed)
  useEffect(() => {
    if (!photos.length) return;
    let cancelled = false;
    const created = [];
    (async () => {
      for (const p of photos) {
        try {
          const u = await apiObjectUrl(`/api/workspaces/${encodeURIComponent(workspaceId)}/field-visits/${encodeURIComponent(visit.id)}/photos/${encodeURIComponent(p.id)}`);
          if (cancelled) { URL.revokeObjectURL(u); return; }
          created.push(u);
          setUrls((prev) => ({ ...prev, [p.id]: u }));
        } catch {
          if (!cancelled) setUrls((prev) => ({ ...prev, [p.id]: "" }));
        }
      }
    })();
    return () => {
      cancelled = true;
      created.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [detail, workspaceId, visit.id]); // detail is cached upstream -> runs once per expand

  const [lightboxIdx, setLightboxIdx] = useState(null);

  return (
    <div className="fv-detail">
      <h3>Technical details</h3>
      {tech.length ? (
        <dl className="fv-kv">
          {tech.map(([k, val]) => (
            <div key={k} style={{ display: "contents" }}>
              <dt>{k}</dt>
              <dd>{val}</dd>
            </div>
          ))}
          {visit.completed_at ? (
            <div style={{ display: "contents" }}>
              <dt>Completed</dt>
              <dd>{new Date(visit.completed_at * 1000).toLocaleString()}</dd>
            </div>
          ) : null}
        </dl>
      ) : (
        <p className="empty" style={{ padding: "0 0 14px" }}>No technical details were recorded.</p>
      )}

      <h3>Telemetry snapshot</h3>
      {m ? (
        metricRows.length ? (
          <dl className="fv-kv">
            {metricRows.map(([k, val]) => (
              <div key={k} style={{ display: "contents" }}>
                <dt>{k}</dt>
                <dd>{val}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="empty" style={{ padding: "0 0 14px" }}>The device reported telemetry, but every field was empty.</p>
        )
      ) : (
        <p className="empty" style={{ padding: "0 0 14px" }}>No telemetry snapshot was captured (the device had never reported telemetry).</p>
      )}

      <h3>Photos</h3>
      {!detail ? (
        <p className="empty" style={{ padding: 0 }}>Loading photos…</p>
      ) : !photos.length ? (
        <p className="empty" style={{ padding: 0 }}>No photos were attached to this visit.</p>
      ) : (
        <>
          <div className="fv-thumbs">
            {photos.map((p, i) => (
              <button
                key={p.id}
                type="button"
                className="fv-thumb"
                aria-label={`Open photo ${i + 1} of ${photos.length}`}
                onClick={() => setLightboxIdx(i)}
              >
                {urls[p.id] === undefined ? (
                  <span className="fv-thumb-ph">loading…</span>
                ) : urls[p.id] === "" ? (
                  <span className="fv-thumb-ph">unavailable</span>
                ) : (
                  <img src={urls[p.id]} alt={`Field visit photo ${i + 1}`} loading="lazy" />
                )}
              </button>
            ))}
          </div>
          {lightboxIdx != null && (
            <PhotoLightbox
              photos={photos}
              urls={urls}
              index={lightboxIdx}
              onClose={() => setLightboxIdx(null)}
              onIndex={setLightboxIdx}
            />
          )}
        </>
      )}
    </div>
  );
}

function PhotoLightbox({ photos, urls, index, onClose, onIndex }) {
  const total = photos.length;
  const go = useCallback(
    (delta) => onIndex((i) => (i + delta + total) % total),
    [onIndex, total],
  );

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft" && total > 1) go(-1);
      else if (e.key === "ArrowRight" && total > 1) go(1);
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose, go, total]);

  const p = photos[index];
  const hasCoords = p.latitude != null && p.longitude != null;
  const u = urls[p.id];

  return createPortal(
    <div className="lbx-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label="Field visit photo">
      <div className="lbx" onClick={(e) => e.stopPropagation()}>
        <div className="lbx-head">
          <span className="lbx-count">Photo {index + 1} of {total}</span>
          <button type="button" className="lbx-x" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="lbx-stage">
          {total > 1 && (
            <button type="button" className="lbx-arrow lbx-arrow--prev" onClick={() => go(-1)} aria-label="Previous photo">‹</button>
          )}
          {u === undefined ? (
            <div className="lbx-ph">loading…</div>
          ) : u === "" ? (
            <div className="lbx-ph">image unavailable</div>
          ) : (
            <img className="lbx-img" src={u} alt={`Field visit photo ${index + 1}`} />
          )}
          {total > 1 && (
            <button type="button" className="lbx-arrow lbx-arrow--next" onClick={() => go(1)} aria-label="Next photo">›</button>
          )}
        </div>

        <dl className="lbx-meta">
          {p.photo_category ? (
            <div style={{ display: "contents" }}><dt>Category</dt><dd>{p.photo_category}</dd></div>
          ) : null}
          <div style={{ display: "contents" }}>
            <dt>Latitude</dt>
            <dd>{hasCoords ? Number(p.latitude).toFixed(6) : "—"}</dd>
          </div>
          <div style={{ display: "contents" }}>
            <dt>Longitude</dt>
            <dd>{hasCoords ? Number(p.longitude).toFixed(6) : "—"}</dd>
          </div>
          <div style={{ display: "contents" }}>
            <dt>Accuracy</dt>
            <dd>{p.gps_accuracy_meters != null ? `± ${Math.round(p.gps_accuracy_meters)} m` : "—"}</dd>
          </div>
          <div style={{ display: "contents" }}>
            <dt>Captured</dt>
            <dd>{p.captured_at ? new Date(p.captured_at * 1000).toLocaleString() : "—"}</dd>
          </div>
          <div style={{ display: "contents" }}>
            <dt>Location</dt>
            <dd>{p.place_name ? p.place_name : <span className="lbx-muted">Location name unavailable</span>}</dd>
          </div>
        </dl>

        {hasCoords && (
          <a className="lbx-osm" href={osmUrl(p.latitude, p.longitude)} target="_blank" rel="noopener noreferrer">
            View on OpenStreetMap
          </a>
        )}
      </div>
    </div>,
    document.body,
  );
}
