import { Fragment, useCallback, useState } from "react";
import { useApi } from "../hooks/useApi";
import { useSession } from "../hooks/useSession";
import { useClock } from "../hooks/useClock";
import { useToast } from "../hooks/useToast";
import { apiFetch, UnauthenticatedError } from "../lib/api";
import { n0, formatDuration } from "../lib/format";
import StatTile from "../components/StatTile";

// Phase 4 Stage D — the Operations page. Pulls the ticket list (Stage A) and the
// response-time rollup (Stage C) for one workspace and shows: a priority/age
// ranked queue of open work, the Breached / Due today / Within SLA breakdown,
// and a small per-owner count. workspace_editor+ can change a ticket's
// status/owner inline (PATCH, Stage A); a viewer sees the same data read-only.

const OWNER_LABELS = {
  customer_it: "Customer IT",
  store_staff: "Store staff",
  platform: "Platform",
  hardware: "Hardware",
  unassigned: "Unassigned",
};
const OWNER_OPTIONS = ["unassigned", "customer_it", "store_staff", "platform", "hardware"];
const STATUS_OPTIONS = ["open", "in_progress", "resolved", "closed"];
const STATUS_LABELS = { open: "Open", in_progress: "In progress", resolved: "Resolved", closed: "Closed" };
const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };
const PRIORITY_COLOR = { high: "var(--bad)", medium: "var(--warn)", low: "var(--ink3)" };
const RESPONSE = {
  breached: { label: "Breached", color: "var(--bad)" },
  due_today: { label: "Due today", color: "var(--warn)" },
  within_sla: { label: "Within SLA", color: "var(--ok)" },
};
const ownerLabel = (c) => OWNER_LABELS[c] || c;

async function patchTicket(wsId, ticketId, body) {
  const resp = await fetch(
    `/api/workspaces/${encodeURIComponent(wsId)}/tickets/${encodeURIComponent(ticketId)}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${localStorage.getItem("token")}`,
      },
      body: JSON.stringify(body),
    },
  );
  if (resp.status === 401) throw new UnauthenticatedError();
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(json.error || `PATCH -> ${resp.status}`);
  return json;
}

export default function OperationsView() {
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

  const [editing, setEditing] = useState(null); // ticket id whose inline editor is open
  const [draft, setDraft] = useState({ status: "", owner_category: "" });
  const [saving, setSaving] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const fetcher = useCallback(
    async ({ signal }) => {
      const [tickets, summary] = await Promise.all([
        apiFetch(`/api/workspaces/${encodeURIComponent(wsId)}/tickets`, { signal }),
        apiFetch(`/api/workspaces/${encodeURIComponent(wsId)}/tickets/sla-summary`, { signal }),
      ]);
      return { tickets, summary };
    },
    [wsId],
  );

  const { data, error } = useApi(fetcher, {
    pollMs: 30000,
    deps: [wsId, refreshKey],
    enabled: !!wsId,
  });

  const header = (
    <div className="pt">
      <h1>Operations</h1>
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

  const allTickets = data.tickets || [];
  const summary = data.summary || { counts: { breached: 0, due_today: 0, within_sla: 0 }, targets: {}, total_open: 0 };

  // Ranked queue: open + in_progress, priority first, then oldest first.
  const queue = allTickets
    .filter((t) => t.status === "open" || t.status === "in_progress")
    .sort(
      (a, b) =>
        (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9) ||
        a.created_at - b.created_at,
    );

  // Per-owner open count.
  const ownerCounts = {};
  for (const t of queue) ownerCounts[t.owner_category] = (ownerCounts[t.owner_category] || 0) + 1;
  const ownerRows = Object.entries(ownerCounts).sort((a, b) => b[1] - a[1]);

  const nowSec = Math.floor(Date.now() / 1000);
  const targets = summary.targets || {};

  function startEdit(t) {
    setEditing(t.id);
    setDraft({ status: t.status, owner_category: t.owner_category });
  }
  async function save(t) {
    const body = {};
    if (draft.status !== t.status) body.status = draft.status;
    if (draft.owner_category !== t.owner_category) body.owner_category = draft.owner_category;
    if (!Object.keys(body).length) {
      setEditing(null);
      return;
    }
    setSaving(true);
    try {
      await patchTicket(wsId, t.id, body);
      toast("Ticket updated");
      setEditing(null);
      setRefreshKey((k) => k + 1);
    } catch (e) {
      toast(e.message || "Update failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      {header}
      <p className="sub">
        Open operational work for {wsName ? <b>{wsName}</b> : "this workspace"}, ranked by priority then age
        {canWrite ? "" : " — read-only for your role"}.
      </p>

      {/* SLA attention */}
      <div className="grid g4">
        <StatTile
          label="Breached"
          value={<span style={{ color: "var(--bad)" }}>{n0(summary.counts.breached)}</span>}
          sub="past the response-time target"
          card
        />
        <StatTile
          label="Due today"
          value={<span style={{ color: "var(--warn)" }}>{n0(summary.counts.due_today)}</span>}
          sub="in the final half of the budget"
          card
        />
        <StatTile
          label="Within SLA"
          value={<span style={{ color: "var(--ok)" }}>{n0(summary.counts.within_sla)}</span>}
          sub="comfortably inside target"
          card
        />
        <StatTile
          label="Open tickets"
          value={n0(summary.total_open)}
          sub={
            targets.high
              ? `targets ${targets.high}h / ${targets.medium}h / ${targets.low}h (H/M/L)`
              : "high / medium / low priority"
          }
          card
        />
      </div>

      {/* Ownership breakdown */}
      <div className="sec">
        <h2>Ownership</h2>
        {ownerRows.length ? (
          <div className="card">
            {ownerRows.map(([cat, count], i) => (
              <div
                key={cat}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  padding: "6px 0",
                  fontSize: 13,
                  borderBottom: i < ownerRows.length - 1 ? "1px solid var(--line-soft)" : "none",
                }}
              >
                <span style={cat === "unassigned" ? { color: "var(--ink3)" } : undefined}>{ownerLabel(cat)}</span>
                <span className="mono">{n0(count)}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="sub" style={{ margin: 0 }}>
            Nothing to assign.
          </p>
        )}
      </div>

      {/* Ranked queue */}
      <div className="sec">
        <h2>Ranked queue</h2>
        {!queue.length ? (
          <div className="card">
            <p className="empty" style={{ padding: 0 }}>
              All clear — no open operational tickets right now. Anything the SLA monitor or your team opens will show up
              here.
            </p>
          </div>
        ) : (
          <div className="card pad0">
            <table>
              <thead>
                <tr>
                  <th>Ticket</th>
                  <th>Owner</th>
                  <th>Priority</th>
                  <th>Response</th>
                  <th className="r">Open for</th>
                  {canWrite ? <th className="r">Action</th> : null}
                </tr>
              </thead>
              <tbody>
                {queue.map((t) => {
                  const rs = RESPONSE[t.response_status];
                  const isEditing = editing === t.id;
                  return (
                    <Fragment key={t.id}>
                      <tr>
                        <td>
                          {t.title}
                          {t.auto_source === "sla_breach" ? (
                            <span style={{ color: "var(--ink3)", fontSize: 11, marginLeft: 6 }}>· auto</span>
                          ) : null}
                          {t.status === "in_progress" ? (
                            <span style={{ color: "var(--ink3)", fontSize: 11, marginLeft: 6 }}>· in progress</span>
                          ) : null}
                        </td>
                        <td style={t.owner_category === "unassigned" ? { color: "var(--ink3)" } : undefined}>
                          {ownerLabel(t.owner_category)}
                        </td>
                        <td style={{ color: PRIORITY_COLOR[t.priority], fontWeight: 500, textTransform: "capitalize" }}>
                          {t.priority}
                        </td>
                        <td style={{ color: rs ? rs.color : "var(--ink3)", fontWeight: 500 }}>
                          {rs ? rs.label : "—"}
                        </td>
                        <td className="r mono">{formatDuration(nowSec - t.created_at)}</td>
                        {canWrite ? (
                          <td className="r">
                            <button className="btn" onClick={() => (isEditing ? setEditing(null) : startEdit(t))}>
                              {isEditing ? "Close" : "Change"}
                            </button>
                          </td>
                        ) : null}
                      </tr>
                      {isEditing ? (
                        <tr>
                          <td colSpan={canWrite ? 6 : 5} style={{ background: "var(--line-soft)" }}>
                            <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                              <label style={{ fontSize: 12, color: "var(--ink2)" }}>
                                Status{" "}
                                <select
                                  value={draft.status}
                                  onChange={(e) => setDraft((d) => ({ ...d, status: e.target.value }))}
                                >
                                  {STATUS_OPTIONS.map((s) => (
                                    <option key={s} value={s}>
                                      {STATUS_LABELS[s]}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              <label style={{ fontSize: 12, color: "var(--ink2)" }}>
                                Owner{" "}
                                <select
                                  value={draft.owner_category}
                                  onChange={(e) => setDraft((d) => ({ ...d, owner_category: e.target.value }))}
                                >
                                  {OWNER_OPTIONS.map((o) => (
                                    <option key={o} value={o}>
                                      {ownerLabel(o)}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              <button className="btn dark" disabled={saving} onClick={() => save(t)}>
                                {saving ? "Saving…" : "Save"}
                              </button>
                              <button className="btn" disabled={saving} onClick={() => setEditing(null)}>
                                Cancel
                              </button>
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
      </div>
    </>
  );
}
