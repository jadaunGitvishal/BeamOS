import { Fragment, useCallback, useState } from "react";
import { useApi } from "../hooks/useApi";
import { useSession } from "../hooks/useSession";
import { useClock } from "../hooks/useClock";
import { useToast } from "../hooks/useToast";
import { apiFetch, UnauthenticatedError } from "../lib/api";
import { n0, formatDuration } from "../lib/format";
import {
  PRIORITY_COLOR,
  RESPONSE_STATUS,
  CAUSE_LABELS,
  CATEGORY_LABEL,
  CATEGORY_COLOR,
  OWNER_LABELS,
  rankOpenTickets,
} from "../lib/tickets";
import KpiCard from "../components/KpiCard";
import ShareBars from "../components/ShareBars";

// Phase 4 Stage D — the Operations page. Pulls the ticket list (Stage A) and the
// response-time rollup (Stage C) for one workspace and shows: a priority/age
// ranked queue of open work, the Breached / Due today / Within SLA breakdown,
// and a small per-owner count. workspace_editor+ can change a ticket's
// status/owner inline (PATCH, Stage A); a viewer sees the same data read-only.

const OWNER_OPTIONS = ["unassigned", "customer_it", "store_staff", "platform", "hardware"];
const CATEGORY_OPTIONS = ["reactive", "proactive", "emergency"];
const STATUS_OPTIONS = ["open", "in_progress", "resolved", "closed"];
const STATUS_LABELS = { open: "Open", in_progress: "In progress", resolved: "Resolved", closed: "Closed" };
const ownerLabel = (c) => OWNER_LABELS[c] || c;

// Ticket priority/response/cause vocabulary + the priority-then-age sort live in
// lib/tickets.js, shared with the Overview "Priority actions" teaser.

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
  const [draft, setDraft] = useState({ status: "", owner_category: "", ticket_category: "" });
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
  const queue = rankOpenTickets(allTickets);

  // Per-owner open count.
  const ownerCounts = {};
  for (const t of queue) ownerCounts[t.owner_category] = (ownerCounts[t.owner_category] || 0) + 1;
  const ownerRows = Object.entries(ownerCounts).sort((a, b) => b[1] - a[1]);
  const priorityRows = ["high", "medium", "low"]
    .map((pr) => ({ key: pr, label: pr.charAt(0).toUpperCase() + pr.slice(1), count: queue.filter((t) => t.priority === pr).length, color: PRIORITY_COLOR[pr] }))
    .filter((r) => r.count > 0);
  const totalOpen = summary.total_open;
  const shareOf = (n) => (totalOpen ? (n / totalOpen) * 100 : null);

  const nowSec = Math.floor(Date.now() / 1000);
  const targets = summary.targets || {};

  function startEdit(t) {
    setEditing(t.id);
    setDraft({ status: t.status, owner_category: t.owner_category, ticket_category: t.ticket_category });
  }
  async function save(t) {
    const body = {};
    if (draft.status !== t.status) body.status = draft.status;
    if (draft.owner_category !== t.owner_category) body.owner_category = draft.owner_category;
    if (draft.ticket_category !== t.ticket_category) body.ticket_category = draft.ticket_category;
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
        <KpiCard
          label="Breached"
          value={n0(summary.counts.breached)}
          ofValue={totalOpen ? n0(totalOpen) : null}
          subLine="past the response-time target"
          percentage={shareOf(summary.counts.breached)}
          color="var(--bad)"
        />
        <KpiCard
          label="Due today"
          value={n0(summary.counts.due_today)}
          ofValue={totalOpen ? n0(totalOpen) : null}
          subLine="in the final half of the budget"
          percentage={shareOf(summary.counts.due_today)}
          color="var(--warn)"
        />
        <KpiCard
          label="Within SLA"
          value={n0(summary.counts.within_sla)}
          ofValue={totalOpen ? n0(totalOpen) : null}
          subLine="comfortably inside target"
          percentage={shareOf(summary.counts.within_sla)}
          color="var(--ok)"
        />
        <KpiCard
          label="Open tickets"
          value={n0(totalOpen)}
          subLine={
            targets.high
              ? `targets ${targets.high}h / ${targets.medium}h / ${targets.low}h (H/M/L)`
              : "high / medium / low priority"
          }
          color="var(--accent)"
        />
      </div>

      {queue.length ? (
        <div className="grid g2 mt16 csplit">
          <ShareBars
            title="Ownership"
            note="Who open tickets are waiting on."
            rows={ownerRows.map(([cat, count]) => ({
              key: cat,
              label: ownerLabel(cat),
              count,
              color: cat === "unassigned" ? "var(--bad)" : "var(--accent)",
            }))}
            total={queue.length}
            foot="Unassigned tickets are flagged red."
          />
          <ShareBars title="Priority mix" note="Open tickets by priority." rows={priorityRows} total={queue.length} />
        </div>
      ) : null}

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
            <table style={{ minWidth: 760 }}>
              <thead>
                <tr>
                  <th>Ticket</th>
                  <th>Owner</th>
                  <th>Priority</th>
                  <th>Category</th>
                  <th>Response</th>
                  <th className="r">Open for</th>
                  {canWrite ? <th className="r">Action</th> : null}
                </tr>
              </thead>
              <tbody>
                {queue.map((t) => {
                  const rs = RESPONSE_STATUS[t.response_status];
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
                          {t.auto_source === "sla_breach" && CAUSE_LABELS[t.likely_cause] ? (
                            <div style={{ color: "var(--ink3)", fontSize: 11, marginTop: 2 }}>
                              Likely cause: {CAUSE_LABELS[t.likely_cause]}
                            </div>
                          ) : null}
                        </td>
                        <td style={t.owner_category === "unassigned" ? { color: "var(--ink3)" } : undefined}>
                          {ownerLabel(t.owner_category)}
                        </td>
                        <td style={{ color: PRIORITY_COLOR[t.priority], fontWeight: 500, textTransform: "capitalize", whiteSpace: "nowrap" }}>
                          <i className="dot" style={{ background: PRIORITY_COLOR[t.priority], marginRight: 6 }} />
                          {t.priority}
                        </td>
                        <td style={{ color: CATEGORY_COLOR[t.ticket_category] || "var(--ink3)", fontWeight: t.ticket_category === "emergency" ? 600 : 400 }}>
                          {CATEGORY_LABEL[t.ticket_category] || t.ticket_category}
                        </td>
                        <td style={{ color: rs ? rs.color : "var(--ink3)", fontWeight: 500, whiteSpace: "nowrap" }}>
                          {rs ? <i className="dot" style={{ background: rs.color, marginRight: 6 }} /> : null}
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
                          <td colSpan={canWrite ? 7 : 6} style={{ background: "var(--line-soft)" }}>
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
                              <label style={{ fontSize: 12, color: "var(--ink2)" }}>
                                Category{" "}
                                <select
                                  value={draft.ticket_category}
                                  onChange={(e) => setDraft((d) => ({ ...d, ticket_category: e.target.value }))}
                                >
                                  {CATEGORY_OPTIONS.map((c) => (
                                    <option key={c} value={c}>
                                      {CATEGORY_LABEL[c] || c}
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
