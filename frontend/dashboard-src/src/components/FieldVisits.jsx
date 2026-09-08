import { useEffect, useRef, useState } from "react";
import { apiFetch, apiObjectUrl } from "../lib/api";
import { fmtCoords, osmUrl, formatDuration, n0 } from "../lib/format";

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
      ) : !(detail.photos || []).length ? (
        <p className="empty" style={{ padding: 0 }}>No photos were attached to this visit.</p>
      ) : (
        <div className="fv-photos">
          {detail.photos.map((p) => (
            <PhotoCard key={p.id} photo={p} workspaceId={workspaceId} visitId={visit.id} />
          ))}
        </div>
      )}
    </div>
  );
}

function PhotoCard({ photo, workspaceId, visitId }) {
  const hasCoords = photo.latitude != null && photo.longitude != null;
  return (
    <div className="fv-photo">
      <AuthImg src={`/api/workspaces/${encodeURIComponent(workspaceId)}/field-visits/${encodeURIComponent(visitId)}/photos/${encodeURIComponent(photo.id)}`} />
      <div className="fv-pmeta">
        {photo.photo_category ? <div>{photo.photo_category}</div> : null}
        <div>{hasCoords ? fmtCoords(photo.latitude, photo.longitude) : "no coordinates"}</div>
        {photo.gps_accuracy_meters != null ? <div>±{Math.round(photo.gps_accuracy_meters)} m</div> : null}
        {photo.captured_at ? <div>captured {new Date(photo.captured_at * 1000).toLocaleString()}</div> : null}
        {hasCoords ? (
          <a href={osmUrl(photo.latitude, photo.longitude)} target="_blank" rel="noopener noreferrer">
            View location
          </a>
        ) : null}
      </div>
    </div>
  );
}

function AuthImg({ src }) {
  const [url, setUrl] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let obj = null;
    (async () => {
      try {
        obj = await apiObjectUrl(src);
        if (cancelled) URL.revokeObjectURL(obj);
        else setUrl(obj);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      if (obj) URL.revokeObjectURL(obj);
    };
  }, [src]);
  if (failed) return <div className="fv-photo-ph">image unavailable</div>;
  if (!url) return <div className="fv-photo-ph">loading…</div>;
  return <img src={url} alt="Field visit photo" loading="lazy" />;
}
