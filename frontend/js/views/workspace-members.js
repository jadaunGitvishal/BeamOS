// Workspace members view. Slice 2A established the read-only listing;
// slice 2B adds the mutation surface (invite modal + per-row role change /
// remove / cancel-invite) gated by can_admin from /me.
//
// Affordance rules (locked from 2A's CSS design, refined during 2B):
//   - direct-member rows: role select + remove button
//   - via_org rows: no actions (server would 403; access lives in org_members)
//   - invited rows: cancel-invite button only (server returns 200)
// Server enforces all three boundaries; UI must match.

import { api } from '../api.js';
import { t } from '../i18n.js';
import { showToast } from '../components/toast.js';
import { openInviteMemberModal } from '../components/workspace-members-invite-modal.js';
import { openAddUserModal } from '../components/workspace-members-add-user-modal.js';
import { isPlatformAdmin } from '../utils.js';

export async function render(container, workspaceId) {
  container.innerHTML = `
    <div class="page-header">
      <h1>${t('members.title')}</h1>
      <div style="display:flex;gap:8px;align-items:center">
        <div id="membersHeaderActions"></div>
        <div class="export-menu-wrap" id="exportMenuWrap">
          <button type="button" class="btn btn-secondary" id="exportBtn" aria-haspopup="true" aria-expanded="false">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            ${t('report.export_csv')}
          </button>
          <div class="export-menu" id="exportMenu" role="menu">
            <button type="button" class="export-menu-item" data-format="csv" role="menuitem">CSV</button>
            <button type="button" class="export-menu-item" data-format="xlsx" role="menuitem">XLSX</button>
            <button type="button" class="export-menu-item" data-format="pdf" role="menuitem">PDF</button>
          </div>
        </div>
      </div>
    </div>
    <div id="workspaceMembersContent" style="color:var(--text-muted)">${t('members.loading')}</div>
  `;
  const content = document.getElementById('workspaceMembersContent');
  const headerActions = document.getElementById('membersHeaderActions');
  wireExportMenu(workspaceId);

  // Fetch members, invites, and /me (for can_admin) in parallel. /me is the
  // source of truth for can_admin in THIS workspace - the same field the
  // switcher uses to gate the members icon.
  let members, meWorkspace;
  try {
    const [m, me] = await Promise.all([
      api.getWorkspaceMembers(workspaceId),
      api.getMe().catch(() => null),
    ]);
    members = m;
    meWorkspace = (me?.accessible_workspaces || []).find(w => w.id === workspaceId) || null;
  } catch (err) {
    const msg = err.message || '';
    if (/Workspace access required|Workspace not found/.test(msg)) {
      content.innerHTML = renderError(t('members.workspace_not_found'));
    } else {
      content.innerHTML = renderError(t('members.load_error', { error: esc(msg) }));
    }
    return;
  }

  const canAdmin = !!(meWorkspace && meWorkspace.can_admin);
  const workspaceName = meWorkspace?.name || '';

  // /invites is admin-only. Non-admins get 403; suppress silently. We could
  // skip the call entirely when !canAdmin to save a request, but defending
  // in depth: if /me drift ever leaves can_admin stale, the server still
  // returns the right answer.
  let invites = null;
  if (canAdmin) {
    try {
      invites = await api.getWorkspaceInvites(workspaceId);
    } catch (err) {
      console.warn('getWorkspaceInvites failed:', err.message);
      invites = null;
    }
  }

  // Invite + Add User buttons - admin only. Invite is self-service (emails a
  // link); Add User (#10) provisions an account directly with an admin-set
  // password (for instances with no outbound email). They coexist.
  if (canAdmin) {
    headerActions.innerHTML = `
      <div style="display:flex;gap:8px">
        <button class="btn btn-secondary" id="addUserBtn">${t('members.button.add_user')}</button>
        <button class="btn btn-primary" id="inviteMemberBtn">${t('members.button.invite')}</button>
      </div>
    `;
    document.getElementById('inviteMemberBtn').addEventListener('click', () => {
      openInviteMemberModal({ id: workspaceId, name: workspaceName }, {
        onSuccess: (result) => {
          showToast(t('members.success.invite_sent', { email: result.email }), 'success');
          render(container, workspaceId);
        },
        mapError: mapMutationError,
      });
    });
    document.getElementById('addUserBtn').addEventListener('click', () => {
      openAddUserModal({ id: workspaceId, name: workspaceName }, {
        onSuccess: (result) => {
          showToast(t('members.success.user_created', { email: result.email }), 'success');
          render(container, workspaceId);
        },
        mapError: mapMutationError,
      });
    });
  }

  const direct = members.filter(m => !m.via_org);
  const viaOrg = members.filter(m => m.via_org);

  content.innerHTML = `
    ${renderSection({
      titleKey: 'members.section.direct',
      count: direct.length,
      emptyKey: 'members.empty.members',
      rows: direct.map(m => renderMemberRow(m, { showJoined: true, canAdmin })).join(''),
    })}
    ${viaOrg.length > 0 ? renderSection({
      titleKey: 'members.section.via_org',
      count: viaOrg.length,
      emptyKey: null,
      rows: viaOrg.map(m => renderMemberRow(m, { showJoined: false, viaOrg: true, canAdmin })).join(''),
    }) : ''}
    ${invites !== null ? renderSection({
      titleKey: 'members.section.pending',
      count: invites.length,
      emptyKey: 'members.empty.invites',
      rows: invites.map(inv => renderInviteRow(inv, { canAdmin })).join(''),
    }) : ''}
  `;

  if (canAdmin) attachMutationHandlers(container, workspaceId);
}

function renderSection({ titleKey, count, emptyKey, rows }) {
  const countLabel = count > 0
    ? `<span style="color:var(--text-muted);font-weight:400;font-size:13px"> (${count})</span>`
    : '';
  const body = (count === 0 && emptyKey)
    ? `<p style="color:var(--text-muted);font-size:13px">${t(emptyKey)}</p>`
    : `<div class="members-list">${rows}</div>`;
  return `
    <div class="settings-section" style="margin-bottom:24px">
      <h3 style="font-size:15px;margin-bottom:12px">${t(titleKey)}${countLabel}</h3>
      ${body}
    </div>
  `;
}

function renderMemberRow(m, opts = {}) {
  const { showJoined = false, viaOrg = false, canAdmin = false } = opts;
  const initial = ((m.name || m.email || '?')[0] || '?').toUpperCase();
  const rightCell = viaOrg
    ? `<span class="member-via-org">${t('members.via_org_label')}</span>`
    : (showJoined ? esc(formatDate(m.joined_at)) : '');

  // Platform-level owners (platform_admin/superadmin) have platform-wide access
  // that is entirely independent of their workspace_members row (verified via
  // live testing: editing/removing that row has zero effect on their actual
  // access). Editing it here is misleading, so their row is always shown as a
  // static, non-interactive label with no remove action - regardless of the
  // viewer's canAdmin.
  const isPlatformOwner = isPlatformAdmin({ role: m.platform_role });

  // Same reasoning for org-level owners/admins (org_owner/org_admin): their
  // real power lives in organization_members, not this workspace_members row,
  // so editing the row here is equally misleading. Only applies to direct
  // rows - via_org rows are already fully locked via the viaOrg branch below.
  const isOrgLocked = !viaOrg && (m.org_role === 'org_owner' || m.org_role === 'org_admin');
  const isLocked = isPlatformOwner || isOrgLocked;

  // Role cell: select for direct-member rows when canAdmin (and not locked),
  // plain text otherwise. Platform takes precedence over org when both apply.
  const roleCell = (canAdmin && !viaOrg && !isLocked)
    ? `<select class="member-role-select" data-member-id="${esc(m.user_id)}" aria-label="${esc(t('members.col.role'))}">
         ${WORKSPACE_ROLES.map(r => `<option value="${r}"${r === m.role ? ' selected' : ''}>${esc(t('members.role.' + r))}</option>`).join('')}
       </select>`
    : isPlatformOwner
      ? `<div class="member-role" title="${esc(t('members.platform_role_tooltip'))}">${esc(t('admin.role.' + m.platform_role))}</div>`
      : isOrgLocked
        ? `<div class="member-role" title="${esc(t('members.org_role_tooltip'))}">${esc(t('members.role.' + m.org_role))}</div>`
        : `<div class="member-role">${esc(t('members.role.' + m.role))}</div>`;

  // Actions cell: remove on direct-member rows only when canAdmin and not locked.
  const actionsCell = (canAdmin && !viaOrg && !isLocked)
    ? `<div class="member-actions">
         <button class="member-action-btn member-action-btn--danger" type="button"
                 data-remove-member="${esc(m.user_id)}"
                 data-member-name="${esc(m.name || m.email)}"
                 aria-label="${esc(t('members.button.remove'))}"
                 title="${esc(t('members.button.remove'))}">${REMOVE_ICON}</button>
       </div>`
    : '';

  return `
    <div class="member-row${viaOrg ? ' member-row--via-org' : ''}">
      <div class="member-avatar">${esc(initial)}</div>
      <div class="member-meta">
        <div class="member-name">${esc(m.name || m.email)}</div>
        <div class="member-email">${esc(m.email)}</div>
      </div>
      ${roleCell}
      <div class="member-detail">${rightCell}</div>
      ${actionsCell}
    </div>
  `;
}

function renderInviteRow(inv, opts = {}) {
  const { canAdmin = false } = opts;
  const initial = ((inv.email || '?')[0] || '?').toUpperCase();
  const invitedBy = inv.invited_by_email
    ? t('members.invited_by', { email: inv.invited_by_email })
    : '';
  const expires = t('members.expires_in', { when: formatDate(inv.expires_at) });

  // Refined affordance rule: invited rows DO get one action - cancel.
  const actionsCell = canAdmin
    ? `<div class="member-actions">
         <button class="member-action-btn member-action-btn--danger" type="button"
                 data-cancel-invite="${esc(inv.id)}"
                 data-invite-email="${esc(inv.email)}"
                 aria-label="${esc(t('members.button.cancel_invite'))}"
                 title="${esc(t('members.button.cancel_invite'))}">${REMOVE_ICON}</button>
       </div>`
    : '';

  return `
    <div class="member-row member-row--invited">
      <div class="member-avatar member-avatar--muted">${esc(initial)}</div>
      <div class="member-meta">
        <div class="member-name">
          ${esc(inv.email)}
          <span class="member-badge">${t('members.invited_label')}</span>
        </div>
        <div class="member-email">${esc(invitedBy)}</div>
      </div>
      <div class="member-role">${esc(t('members.role.' + inv.role))}</div>
      <div class="member-detail">${esc(expires)}</div>
      ${actionsCell}
    </div>
  `;
}

// Wire all mutation handlers after innerHTML write. Each handler: confirm
// (if destructive), call API, on success toast + re-render, on error toast
// + re-render (to revert UI state in case the failed mutation was an
// optimistic display - belt and suspenders).
function attachMutationHandlers(container, workspaceId) {
  // Role change - fires on <select> change.
  container.querySelectorAll('select[data-member-id]').forEach(sel => {
    sel.addEventListener('change', async () => {
      const userId = sel.dataset.memberId;
      const newRole = sel.value;
      try {
        await api.updateWorkspaceMemberRole(workspaceId, userId, newRole);
        showToast(t('members.success.role_changed'), 'success');
        render(container, workspaceId);
      } catch (err) {
        showToast(mapMutationError(err), 'error');
        render(container, workspaceId);
      }
    });
  });

  // Remove member - confirm then DELETE.
  container.querySelectorAll('[data-remove-member]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const userId = btn.dataset.removeMember;
      const name = btn.dataset.memberName;
      if (!confirm(t('members.confirm.remove_member', { name }))) return;
      try {
        await api.removeWorkspaceMember(workspaceId, userId);
        showToast(t('members.success.member_removed', { name }), 'success');
        render(container, workspaceId);
      } catch (err) {
        showToast(mapMutationError(err), 'error');
      }
    });
  });

  // Cancel pending invite - confirm then DELETE.
  container.querySelectorAll('[data-cancel-invite]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const inviteId = btn.dataset.cancelInvite;
      const email = btn.dataset.inviteEmail;
      if (!confirm(t('members.confirm.cancel_invite', { email }))) return;
      try {
        await api.cancelWorkspaceInvite(workspaceId, inviteId);
        showToast(t('members.success.invite_cancelled'), 'success');
        render(container, workspaceId);
      } catch (err) {
        showToast(mapMutationError(err), 'error');
      }
    });
  });
}

// Map a backend mutation-error message to a translated user-facing string.
// Exported so the invite modal can reuse the same mapper (single source of
// truth - the "third regex mapper" per the slice 2A follow-up note;
// cumulative-debt cleanup tracked there).
//
// Order matters - most specific patterns first. Server message stability is
// the implicit contract; if the regex chain ever produces wrong matches,
// it's because server wording changed without updating this mapper.
export function mapMutationError(err) {
  const msg = err?.message || '';
  if (/rate limit/i.test(msg)) return t('members.error.rate_limit');
  if (/already pending/i.test(msg)) return t('members.error.invite_exists');
  if (/Cannot demote the last admin/i.test(msg)) return t('members.error.last_admin_demote');
  if (/Cannot remove the last admin/i.test(msg)) return t('members.error.last_admin_remove');
  if (/already a member/i.test(msg)) return t('members.error.already_member');
  // #10 Add User: duplicate email + weak password.
  if (/user with that email already exists/i.test(msg)) return t('members.error.user_exists');
  if (/at least 8 characters/i.test(msg)) return t('members.error.password_min_8');
  if (/Valid email required/i.test(msg)) return t('members.error.invalid_email');
  if (/Cannot remove the organization owner/i.test(msg)) return t('members.error.org_owner_remove');
  if (/Email send failed/i.test(msg)) return t('members.error.email_send_failed');
  return t('members.error.mutation_generic', { error: msg });
}

// Wires the CSV/XLSX/PDF export dropdown. Same open/close + fetch-blob-and-
// download behavior as reports.js's export menu; self-removing document
// click listener since this view has no teardown hook and render() re-runs
// on every visit.
function wireExportMenu(workspaceId) {
  const exportMenuWrap = document.getElementById('exportMenuWrap');
  const exportBtn = document.getElementById('exportBtn');

  exportBtn.onclick = (e) => {
    e.stopPropagation();
    const opening = !exportMenuWrap.classList.contains('open');
    exportMenuWrap.classList.toggle('open');
    exportBtn.setAttribute('aria-expanded', String(opening));
  };

  document.addEventListener('click', function onDocClick(e) {
    if (!document.body.contains(exportMenuWrap)) {
      document.removeEventListener('click', onDocClick);
      return;
    }
    if (!exportMenuWrap.contains(e.target)) {
      exportMenuWrap.classList.remove('open');
      exportBtn.setAttribute('aria-expanded', 'false');
    }
  });

  exportMenuWrap.querySelectorAll('.export-menu-item').forEach((item) => {
    item.onclick = async () => {
      exportMenuWrap.classList.remove('open');
      exportBtn.setAttribute('aria-expanded', 'false');

      const format = item.dataset.format;
      const token = localStorage.getItem('token');
      const url = `/api/workspaces/${workspaceId}/members/export?format=${format}`;

      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        showToast(error.error || 'Export failed', 'error');
        return;
      }

      const blob = await response.blob();
      const downloadUrl = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = downloadUrl;
      a.download = `workspace-members.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(downloadUrl);
    };
  });
}

function renderError(message) {
  return `<div style="color:var(--danger);font-size:14px;padding:16px;background:var(--bg-input);border-radius:6px">${message}</div>`;
}

function formatDate(ts) {
  if (!ts) return '';
  return new Date(ts * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

const WORKSPACE_ROLES = ['workspace_admin', 'workspace_editor', 'workspace_viewer'];
const REMOVE_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
