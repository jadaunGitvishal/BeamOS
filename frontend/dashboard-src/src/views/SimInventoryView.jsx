import { Fragment, useCallback, useState } from "react";
import { useApi } from "../hooks/useApi";
import { useSession } from "../hooks/useSession";
import { useClock } from "../hooks/useClock";
import { useToast } from "../hooks/useToast";
import { apiFetch, UnauthenticatedError } from "../lib/api";
import { SIM_STATUSES, SIM_STATUS } from "../lib/sim-inventory";

// Ref 65 — SIM inventory: a manual stock ledger for physical SIM cards
// (in_stock -> assigned -> active -> retired), no carrier API integration.
// Clones DevicesView.jsx's fetch-once-filter-client-side list pattern and
// CampaignsView.jsx's add-form + inline-edit CRUD shape. Write controls
// (add / assign / status change) need workspace_admin - one tier above the
// workspace_editor+ bar tickets/campaigns use (see routes/sim-inventory.js);
// a viewer sees the same list read-only, same as those other views.

const EMPTY_FORM = { iccid: "", serial_number: "", carrier: "", notes: "" };
// Statuses from which "Assign to device" is offered - the two states with no
// live device binding. 'assigned'/'active' show the unassign/activate/retire
// actions instead (see actionsFor below).
const ASSIGNABLE_FROM = new Set(["in_stock", "retired"]);

async function sendSim(method, id, body) {
  const path = id ? `/api/sim-inventory/${encodeURIComponent(id)}` : "/api/sim-inventory";
  const resp = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("token")}` },
    body: JSON.stringify(body),
  });
  if (resp.status === 401) throw new UnauthenticatedError();
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(json.error || `${method} -> ${resp.status}`);
  return json;
}

export default function SimInventoryView() {
  const { me } = useSession();
  const asof = useClock();
  const { toast } = useToast();
  const wsId = me?.current_workspace_id || null;
  const wsName = me?.current_workspace?.name || "";
  const canWrite =
    !!me?.is_platform_admin ||
    me?.current_org_role === "org_owner" ||
    me?.current_org_role === "org_admin" ||
    me?.current_workspace_role === "workspace_admin";

  const [statusFilter, setStatusFilter] = useState("");
  const [carrierFilter, setCarrierFilter] = useState("");
  const [form, setForm] = useState(null); // null = closed; { ...EMPTY_FORM } for new SIM
  const [managing, setManaging] = useState(null); // sim id whose inline manage row is open
  const [draft, setDraft] = useState({ carrier: "", notes: "", assign_device_id: "" });
  const [saving, setSaving] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const fetcher = useCallback(
    async ({ signal }) => {
      const [sims, devices] = await Promise.all([
        apiFetch(`/api/sim-inventory`, { signal }),
        apiFetch(`/api/dashboard/devices`, { signal }).catch(() => []),
      ]);
      return { sims, devices };
    },
    [wsId],
  );

  const { data, error } = useApi(fetcher, { pollMs: 30000, deps: [wsId, refreshKey], enabled: !!wsId });

  const header = (
    <div className="pt">
      <h1>SIM inventory</h1>
      <span className="stamp">as of {asof}</span>
    </div>
  );

  if (!wsId) {
    return (
      <>
        {header}
        <div className="card">
          <p className="empty" style={{ padding: 0 }}>
            No workspace selected for this session.
          </p>
        </div>
      </>
    );
  }
  if (error) {
    return (
      <>
        {header}
        <div className="card">
          <h2>Something went wrong</h2>
          <p style={{ margin: "6px 0 0", fontSize: 12.5, color: "var(--ink2)" }}>{error.message}</p>
        </div>
      </>
    );
  }
  if (!data) return <p className="sub">Loading…</p>;

  const allSims = data.sims || [];
  const devices = data.devices || [];
  const carriers = [...new Set(allSims.map((s) => s.carrier).filter(Boolean))].sort();

  const list = allSims.filter(
    (s) => (!statusFilter || s.status === statusFilter) && (!carrierFilter || s.carrier === carrierFilter),
  );

  function openNew() {
    setForm({ ...EMPTY_FORM });
  }
  async function createSim() {
    const body = {
      iccid: form.iccid.trim(),
      serial_number: form.serial_number.trim() || null,
      carrier: form.carrier.trim() || null,
      notes: form.notes.trim() || null,
    };
    if (!body.iccid) return toast("ICCID is required");
    setSaving(true);
    try {
      await sendSim("POST", null, body);
      toast("SIM added to stock");
      setForm(null);
      setRefreshKey((k) => k + 1);
    } catch (e) {
      toast(e.message || "Add failed");
    } finally {
      setSaving(false);
    }
  }

  function startManage(s) {
    setManaging(s.id);
    setDraft({ carrier: s.carrier || "", notes: s.notes || "", assign_device_id: "" });
  }
  async function saveDetails(s) {
    const body = {};
    if (draft.carrier !== (s.carrier || "")) body.carrier = draft.carrier || null;
    if (draft.notes !== (s.notes || "")) body.notes = draft.notes || null;
    if (!Object.keys(body).length) return;
    setSaving(true);
    try {
      await sendSim("PATCH", s.id, body);
      toast("SIM details updated");
      setRefreshKey((k) => k + 1);
    } catch (e) {
      toast(e.message || "Update failed");
    } finally {
      setSaving(false);
    }
  }
  async function changeStatus(s, status, deviceId) {
    const body = { status };
    if (deviceId) body.assigned_device_id = deviceId;
    setSaving(true);
    try {
      await sendSim("PATCH", s.id, body);
      toast(`SIM ${SIM_STATUS[status]?.label.toLowerCase() || status}`);
      // Deliberately NOT closing the manage panel here: assign -> activate ->
      // retire is a single sitting's workflow (live-verification caught this -
      // auto-closing forced a re-click of "Manage" after every single step).
      // "Close" above dismisses it explicitly once the admin is done.
      setRefreshKey((k) => k + 1);
    } catch (e) {
      toast(e.message || "Update failed");
    } finally {
      setSaving(false);
    }
  }

  const formPanel = form ? (
    <div className="card" style={{ marginBottom: 12 }}>
      <h2 style={{ margin: "0 0 10px" }}>New SIM</h2>
      <div className="grid g2" style={{ gap: 10 }}>
        <label style={fieldLabel}>
          ICCID
          <input
            className="srch"
            style={{ width: "100%" }}
            value={form.iccid}
            onChange={(e) => setForm((f) => ({ ...f, iccid: e.target.value }))}
          />
        </label>
        <label style={fieldLabel}>
          Serial number <span style={{ color: "var(--ink3)" }}>(optional)</span>
          <input
            className="srch"
            style={{ width: "100%" }}
            value={form.serial_number}
            onChange={(e) => setForm((f) => ({ ...f, serial_number: e.target.value }))}
          />
        </label>
        <label style={fieldLabel}>
          Carrier <span style={{ color: "var(--ink3)" }}>(optional)</span>
          <input
            className="srch"
            style={{ width: "100%" }}
            value={form.carrier}
            onChange={(e) => setForm((f) => ({ ...f, carrier: e.target.value }))}
          />
        </label>
        <label style={{ ...fieldLabel, gridColumn: "1 / -1" }}>
          Notes <span style={{ color: "var(--ink3)" }}>(optional)</span>
          <textarea
            rows={2}
            style={{ width: "100%", font: "inherit", fontSize: 12.5, padding: "6px 10px", border: "1px solid var(--line)", borderRadius: 8, resize: "vertical" }}
            value={form.notes}
            onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
          />
        </label>
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button className="btn dark" disabled={saving} onClick={createSim}>
          {saving ? "Adding…" : "Add to stock"}
        </button>
        <button className="btn" disabled={saving} onClick={() => setForm(null)}>
          Cancel
        </button>
      </div>
    </div>
  ) : null;

  return (
    <>
      {header}
      <p className="sub">
        Physical SIM stock for {wsName ? <b>{wsName}</b> : "this workspace"} — tracked manually through in stock,
        assigned, active and retired{canWrite ? "" : " — read-only for your role"}.
      </p>

      {canWrite && !form ? (
        <button className="btn dark" style={{ marginBottom: 12 }} onClick={openNew}>
          New SIM
        </button>
      ) : null}
      {formPanel}

      <div className="ctl mb10">
        <div className="seg" role="group" aria-label="Filter by status">
          <button className={statusFilter === "" ? "on" : ""} onClick={() => setStatusFilter("")}>
            All
          </button>
          {SIM_STATUSES.map((s) => (
            <button key={s} className={statusFilter === s ? "on" : ""} onClick={() => setStatusFilter(s)}>
              {SIM_STATUS[s].label}
            </button>
          ))}
        </div>
        {carriers.length ? (
          <select value={carrierFilter} onChange={(e) => setCarrierFilter(e.target.value)}>
            <option value="">All carriers</option>
            {carriers.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        ) : null}
        <span className="stamp">
          {list.length} of {allSims.length} SIMs
        </span>
      </div>

      {!list.length ? (
        <div className="card">
          <p className="empty" style={{ padding: 0 }}>
            {allSims.length
              ? "No SIMs match this filter."
              : canWrite
                ? "No SIMs in stock yet. Use “New SIM” above to add one."
                : "No SIMs in stock yet. A workspace admin can add one."}
          </p>
        </div>
      ) : (
        <div className="card pad0">
          <table>
            <thead>
              <tr>
                <th>ICCID</th>
                <th>Carrier</th>
                <th>Status</th>
                <th>Assigned device</th>
                {canWrite ? <th className="r">Manage</th> : null}
              </tr>
            </thead>
            <tbody>
              {list.map((s) => {
                const st = SIM_STATUS[s.status] || { label: s.status, color: "var(--ink3)" };
                const isManaging = managing === s.id;
                return (
                  <Fragment key={s.id}>
                    <tr>
                      <td>
                        {s.iccid}
                        {s.serial_number ? (
                          <span style={{ color: "var(--ink3)", fontSize: 11, marginLeft: 6 }}>· {s.serial_number}</span>
                        ) : null}
                        {s.notes ? (
                          <div style={{ color: "var(--ink2)", fontSize: 11.5, marginTop: 2 }}>{s.notes}</div>
                        ) : null}
                      </td>
                      <td style={!s.carrier ? { color: "var(--ink3)" } : undefined}>{s.carrier || "—"}</td>
                      <td style={{ color: st.color, fontWeight: 500 }}>{st.label}</td>
                      <td style={!s.assigned_device_name ? { color: "var(--ink3)" } : undefined}>
                        {s.assigned_device_name || "—"}
                      </td>
                      {canWrite ? (
                        <td className="r">
                          <button className="btn" onClick={() => (isManaging ? setManaging(null) : startManage(s))}>
                            {isManaging ? "Close" : "Manage"}
                          </button>
                        </td>
                      ) : null}
                    </tr>
                    {isManaging ? (
                      <tr>
                        <td colSpan={canWrite ? 5 : 4} style={{ background: "var(--line-soft)" }}>
                          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                            <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                              <label style={{ fontSize: 12, color: "var(--ink2)" }}>
                                Carrier{" "}
                                <input
                                  className="srch"
                                  value={draft.carrier}
                                  onChange={(e) => setDraft((d) => ({ ...d, carrier: e.target.value }))}
                                />
                              </label>
                              <label style={{ fontSize: 12, color: "var(--ink2)" }}>
                                Notes{" "}
                                <input
                                  className="srch"
                                  style={{ width: 220 }}
                                  value={draft.notes}
                                  onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))}
                                />
                              </label>
                              <button className="btn dark" disabled={saving} onClick={() => saveDetails(s)}>
                                Save details
                              </button>
                            </div>
                            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                              {ASSIGNABLE_FROM.has(s.status) ? (
                                <>
                                  <label style={{ fontSize: 12, color: "var(--ink2)" }}>
                                    Assign to{" "}
                                    <select
                                      value={draft.assign_device_id}
                                      onChange={(e) => setDraft((d) => ({ ...d, assign_device_id: e.target.value }))}
                                    >
                                      <option value="">Select a device…</option>
                                      {devices.map((d) => (
                                        <option key={d.id} value={d.id}>
                                          {d.name}
                                        </option>
                                      ))}
                                    </select>
                                  </label>
                                  <button
                                    className="btn"
                                    disabled={saving || !draft.assign_device_id}
                                    onClick={() => changeStatus(s, "assigned", draft.assign_device_id)}
                                  >
                                    Assign
                                  </button>
                                </>
                              ) : null}
                              {s.status === "assigned" ? (
                                <>
                                  <button className="btn" disabled={saving} onClick={() => changeStatus(s, "active")}>
                                    Activate
                                  </button>
                                  <button className="btn" disabled={saving} onClick={() => changeStatus(s, "in_stock")}>
                                    Unassign
                                  </button>
                                </>
                              ) : null}
                              {s.status === "active" ? (
                                <>
                                  <button className="btn" disabled={saving} onClick={() => changeStatus(s, "retired")}>
                                    Retire
                                  </button>
                                  <button className="btn" disabled={saving} onClick={() => changeStatus(s, "in_stock")}>
                                    Unassign
                                  </button>
                                </>
                              ) : null}
                              {s.status === "in_stock" ? (
                                <button className="btn" disabled={saving} onClick={() => changeStatus(s, "retired")}>
                                  Retire
                                </button>
                              ) : null}
                              {s.status === "retired" ? (
                                <button className="btn" disabled={saving} onClick={() => changeStatus(s, "in_stock")}>
                                  Return to stock
                                </button>
                              ) : null}
                            </div>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

const fieldLabel = { display: "flex", flexDirection: "column", gap: 3, fontSize: 12, color: "var(--ink2)" };
