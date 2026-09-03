import { useCallback, useState } from "react";
import { useApi } from "../hooks/useApi";
import { useSession } from "../hooks/useSession";
import { useClock } from "../hooks/useClock";
import { useToast } from "../hooks/useToast";
import { apiFetch, UnauthenticatedError } from "../lib/api";
import { n0 } from "../lib/format";

// Phase 5 Stage C — the Campaigns page. Lists a workspace's campaigns (Stage A)
// with their computed status and delivery numbers (Stage B), and lets a
// workspace_editor+ create / edit / delete them. A viewer sees the same data
// with no write controls rendered at all.

const STATUS = {
  draft: { label: "Draft", color: "var(--ink3)" },
  live: { label: "Live", color: "var(--ok)" },
  completed: { label: "Completed", color: "var(--ink2)" },
};

// grey when there's no target to measure against; green on/over pace; red when
// significantly behind. (delivery_days_elapsed counts the current partial day
// as whole, so an on-pace campaign reads a little under 100 mid-day - hence the
// green cutoff at 90, not 100.)
function deliveryColor(pct) {
  if (pct == null) return "var(--ink3)";
  return pct >= 90 ? "var(--ok)" : "var(--bad)";
}

const EMPTY_FORM = { name: "", description: "", playlist_id: "", start_date: "", end_date: "", target_plays_per_day: "" };

async function sendCampaign(method, wsId, campaignId, body) {
  const path = campaignId
    ? `/api/workspaces/${encodeURIComponent(wsId)}/campaigns/${encodeURIComponent(campaignId)}`
    : `/api/workspaces/${encodeURIComponent(wsId)}/campaigns`;
  const resp = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("token")}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (resp.status === 401) throw new UnauthenticatedError();
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(json.error || `${method} -> ${resp.status}`);
  return json;
}

export default function CampaignsView() {
  const { me } = useSession();
  const asof = useClock();
  const { toast } = useToast();
  const wsId = me?.current_workspace_id || null;
  const wsName = me?.current_workspace?.name || "";
  const canWrite =
    !!me?.is_platform_admin ||
    me?.current_org_role === "org_owner" ||
    me?.current_org_role === "org_admin" ||
    me?.current_workspace_role === "workspace_admin" ||
    me?.current_workspace_role === "workspace_editor";

  const [form, setForm] = useState(null); // null = closed; { ...EMPTY_FORM } for new; { id, ... } for edit
  const [saving, setSaving] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const fetcher = useCallback(
    async ({ signal }) => {
      const [campaigns, playlists] = await Promise.all([
        apiFetch(`/api/workspaces/${encodeURIComponent(wsId)}/campaigns`, { signal }),
        apiFetch(`/api/playlists`, { signal }).catch(() => []),
      ]);
      return { campaigns, playlists };
    },
    [wsId],
  );

  const { data, error } = useApi(fetcher, { pollMs: 60000, deps: [wsId, refreshKey], enabled: !!wsId });

  const header = (
    <div className="pt">
      <h1>Campaigns</h1>
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

  const campaigns = data.campaigns || [];
  const playlists = data.playlists || [];

  function openNew() {
    setForm({ ...EMPTY_FORM });
  }
  function openEdit(c) {
    setForm({
      id: c.id,
      name: c.name || "",
      description: c.description || "",
      playlist_id: c.playlist_id || "",
      start_date: c.start_date || "",
      end_date: c.end_date || "",
      target_plays_per_day: c.target_plays_per_day == null ? "" : String(c.target_plays_per_day),
    });
  }
  async function save() {
    const body = {
      name: form.name.trim(),
      description: form.description.trim() || null,
      playlist_id: form.playlist_id || null,
      start_date: form.start_date,
      end_date: form.end_date,
      target_plays_per_day: form.target_plays_per_day === "" ? null : Number(form.target_plays_per_day),
    };
    if (!body.name) return toast("Name is required");
    if (!body.start_date || !body.end_date) return toast("Start and end dates are required");
    if (body.end_date < body.start_date) return toast("End date must not be before the start date");
    setSaving(true);
    try {
      await sendCampaign(form.id ? "PATCH" : "POST", wsId, form.id, body);
      toast(form.id ? "Campaign updated" : "Campaign created");
      setForm(null);
      setRefreshKey((k) => k + 1);
    } catch (e) {
      toast(e.message || "Save failed");
    } finally {
      setSaving(false);
    }
  }
  async function remove(c) {
    if (!window.confirm(`Delete campaign “${c.name}”? Its playlist and content are not affected.`)) return;
    try {
      await sendCampaign("DELETE", wsId, c.id);
      toast("Campaign deleted");
      setRefreshKey((k) => k + 1);
    } catch (e) {
      toast(e.message || "Delete failed");
    }
  }

  const formPanel = form ? (
    <div className="card" style={{ marginBottom: 12 }}>
      <h2 style={{ margin: "0 0 10px" }}>{form.id ? "Edit campaign" : "New campaign"}</h2>
      <div className="grid g2" style={{ gap: 10 }}>
        <label style={fieldLabel}>
          Name
          <input
            className="srch"
            style={{ width: "100%" }}
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          />
        </label>
        <label style={fieldLabel}>
          Playlist
          <select
            style={{ width: "100%" }}
            value={form.playlist_id}
            onChange={(e) => setForm((f) => ({ ...f, playlist_id: e.target.value }))}
          >
            <option value="">No playlist</option>
            {playlists.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label style={fieldLabel}>
          Start date
          <input
            type="date"
            className="srch"
            style={{ width: "100%" }}
            value={form.start_date}
            onChange={(e) => setForm((f) => ({ ...f, start_date: e.target.value }))}
          />
        </label>
        <label style={fieldLabel}>
          End date
          <input
            type="date"
            className="srch"
            style={{ width: "100%" }}
            value={form.end_date}
            onChange={(e) => setForm((f) => ({ ...f, end_date: e.target.value }))}
          />
        </label>
        <label style={fieldLabel}>
          Target plays / day <span style={{ color: "var(--ink3)" }}>(optional)</span>
          <input
            type="number"
            min="1"
            className="srch"
            style={{ width: "100%" }}
            value={form.target_plays_per_day}
            onChange={(e) => setForm((f) => ({ ...f, target_plays_per_day: e.target.value }))}
          />
        </label>
        <label style={{ ...fieldLabel, gridColumn: "1 / -1" }}>
          Description <span style={{ color: "var(--ink3)" }}>(optional)</span>
          <textarea
            rows={2}
            style={{ width: "100%", font: "inherit", fontSize: 12.5, padding: "6px 10px", border: "1px solid var(--line)", borderRadius: 8, resize: "vertical" }}
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          />
        </label>
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button className="btn dark" disabled={saving} onClick={save}>
          {saving ? "Saving…" : form.id ? "Save changes" : "Create campaign"}
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
        Playlist campaigns for {wsName ? <b>{wsName}</b> : "this workspace"} — schedule a playlist over a date range and
        track its delivery against a target{canWrite ? "" : " — read-only for your role"}.
      </p>

      {canWrite && !form ? (
        <button className="btn dark" style={{ marginBottom: 12 }} onClick={openNew}>
          New campaign
        </button>
      ) : null}
      {formPanel}

      {!campaigns.length ? (
        <div className="card">
          <p className="empty" style={{ padding: 0 }}>
            No campaigns yet.{" "}
            {canWrite
              ? "Use “New campaign” above to wrap one of this workspace’s playlists in a start/end date range and an optional plays-per-day target."
              : "An editor can create one to schedule a playlist over a date range and track its delivery."}
          </p>
        </div>
      ) : (
        <div className="card pad0">
          <table>
            <thead>
              <tr>
                <th>Campaign</th>
                <th>Status</th>
                <th>Dates</th>
                <th className="r">Delivery</th>
                <th className="r">Plays (actual / expected)</th>
                {canWrite ? <th className="r">Actions</th> : null}
              </tr>
            </thead>
            <tbody>
              {campaigns.map((c) => {
                const s = STATUS[c.status] || { label: c.status, color: "var(--ink3)" };
                return (
                  <tr key={c.id}>
                    <td>
                        {c.name}
                        {c.playlist_name ? (
                          <span style={{ color: "var(--ink3)", fontSize: 11, marginLeft: 6 }}>· {c.playlist_name}</span>
                        ) : (
                          <span style={{ color: "var(--ink3)", fontSize: 11, marginLeft: 6 }}>· no playlist</span>
                        )}
                        {c.description ? (
                          <div style={{ color: "var(--ink2)", fontSize: 11.5, marginTop: 2 }}>{c.description}</div>
                        ) : null}
                      </td>
                      <td style={{ color: s.color, fontWeight: 500 }}>{s.label}</td>
                      <td className="mono" style={{ fontSize: 12 }}>
                        {c.start_date} → {c.end_date}
                      </td>
                      <td className="r mono" style={{ color: deliveryColor(c.delivery_pct), fontWeight: 500 }}>
                        {c.delivery_pct == null ? "—" : `${c.delivery_pct}%`}
                      </td>
                      <td className="r mono">
                        {c.actual_plays == null ? (
                          <span style={{ color: "var(--ink3)" }}>n/a</span>
                        ) : (
                          <>
                            {n0(c.actual_plays)}
                            <span style={{ color: "var(--ink3)" }}>
                              {" / "}
                              {c.expected_plays == null ? "—" : n0(c.expected_plays)}
                            </span>
                          </>
                        )}
                      </td>
                      {canWrite ? (
                        <td className="r">
                          <button className="btn" onClick={() => openEdit(c)}>
                            Edit
                          </button>{" "}
                          <button className="btn" onClick={() => remove(c)}>
                            Delete
                          </button>
                        </td>
                      ) : null}
                  </tr>
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
