// Organization members view. Structural twin of workspace-members.js, one
// tenancy layer up: lists organization_members (org_owner/org_admin) for a
// target org and lets an authorized caller add/change-role/remove.
//
// Authorization tiers enforced server-side (routes/organizations.js /
// canAdminOrg): platform_admin has full control; org_owner of this org can
// manage org_admin rows only (cannot grant org_owner, cannot touch another
// org_owner row, cannot touch the primary owner row or demote the last
// owner); org_admin gets read-only (GET succeeds, mutations 403).
//
// Reachable from the platform Admin panel's Organizations list (gated by
// isPlatformAdmin there) and, for a regular org_owner, from Settings ->
// Organization (gated by current_org_role there). canAdmin mirrors the
// server's canAdminOrg (owner-tier only: platform_admin or org_owner of
// THIS org - org_admin stays read-only). /me only exposes org role for the
// caller's currently ACTIVE org (current_org_role/current_organization), so
// this can't yet resolve "am I org_owner of some OTHER, non-active org" -
// the server enforces the real check regardless; a non-active org_owner just
// sees a read-only page here until /me exposes per-org roles more broadly.

import { api } from '../api.js';
import { t } from '../i18n.js';
import { showToast } from '../components/toast.js';
import { openAddOrgMemberModal } from '../components/org-member-add-modal.js';
import { openRegionScopeModal } from '../components/region-scope-modal.js'; // Refs 49/67
import { isPlatformAdmin } from '../utils.js';

export async function render(container, orgId) {
  container.innerHTML = `
    <div class="page-header">
      <h1>${t('org_members.title')}</h1>
      <div style="display:flex;gap:8px;align-items:center">
        <div id="orgMembersHeaderActions"></div>
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
    <div id="orgMembersContent" style="color:var(--text-muted)">${t('org_members.loading')}</div>
  `;
  const content = document.getElementById('orgMembersContent');
  const headerActions = document.getElementById('orgMembersHeaderActions');
  wireExportMenu(orgId);

  let members, me;
  try {
    const [m, meResult] = await Promise.all([
      api.getOrgMembers(orgId),
      api.getMe().catch(() => null),
    ]);
    members = m;
    me = meResult;
  } catch (err) {
    const msg = err.message || '';
    if (/Organization access required|Organization not found/.test(msg)) {
      content.innerHTML = renderError(t('org_members.org_not_found'));
    } else {
      content.innerHTML = renderError(t('org_members.load_error', { error: esc(msg) }));
    }
    return;
  }
  // The router can start a second render of this view while this one awaits;
  // a superseded render must stop here, or it would wire a second set of
  // handlers onto the live page (or throw on its detached header).
  if (!content.isConnected) return;

  const canAdmin =
    isPlatformAdmin(me) ||
    (me?.current_org_role === "org_owner" &&
      me?.current_organization?.id === orgId);
  // Refs 49/67: a regional_viewer's region scopes are managed by org_owner OR
  // org_admin (same tier as Settings -> Regions; the server re-checks).
  const canScopes =
    isPlatformAdmin(me) ||
    (["org_owner", "org_admin"].includes(me?.current_org_role) &&
      me?.current_organization?.id === orgId);
  if (canScopes) {
    await Promise.all(members.filter(m => m.role === 'regional_viewer').map(async (m) => {
      try { m._scopes = (await api.getMemberRegionScopes(orgId, m.user_id)).regions; } catch { m._scopes = null; }
    }));
  }
  if (!content.isConnected) return; // superseded while loading scopes (see above)
  // Org name isn't returned by /members (it's a members-only endpoint) - the
  // Admin panel passes it through as a hash query param so the modal title
  // can show it without an extra request. Falls back to empty if navigated
  // to directly.
  const orgName = new URLSearchParams(location.hash.split('?')[1] || '').get('name') || '';

  if (canAdmin) {
    headerActions.innerHTML = `
      <button class="btn btn-primary" id="addOrgMemberBtn">${t('org_members.button.add')}</button>
    `;
    document.getElementById('addOrgMemberBtn').addEventListener('click', () => {
      openAddOrgMemberModal({ id: orgId, name: orgName }, {
        onSuccess: (result) => {
          showToast(t('org_members.success.member_added', { email: result.email }), 'success');
          render(container, orgId);
          // Refs 49/67: a new regional viewer sees nothing until regions are chosen.
          if (result.role === 'regional_viewer' && canScopes) {
            showToast(t('org_members.scopes.added_hint', { email: result.email }), 'info');
            openRegionScopeModal({ orgId, userId: result.user_id, name: result.email }, {
              onSaved: () => { showToast(t('org_members.scopes.saved'), 'success'); render(container, orgId); },
            });
          }
        },
        mapError: mapMutationError,
      });
    });
  }

  content.innerHTML = `
    <div class="settings-section" style="margin-bottom:24px">
      <h3 style="font-size:15px;margin-bottom:12px">${t('org_members.section.members')}${members.length > 0 ? ` <span style="color:var(--text-muted);font-weight:400;font-size:13px">(${members.length})</span>` : ''}</h3>
      ${members.length === 0
        ? `<p style="color:var(--text-muted);font-size:13px">${t('org_members.empty')}</p>`
        : `<div class="members-list">${members.map(m => renderMemberRow(m, { canAdmin, canScopes })).join('')}</div>`}
    </div>
  `;

  if (canAdmin) attachMutationHandlers(container, orgId);
  if (canScopes) {
    container.querySelectorAll('[data-region-scopes]').forEach(btn => {
      btn.addEventListener('click', () => {
        openRegionScopeModal({ orgId, userId: btn.dataset.regionScopes, name: btn.dataset.memberName }, {
          onSaved: () => { showToast(t('org_members.scopes.saved'), 'success'); render(container, orgId); },
        });
      });
    });
  }
}

function renderMemberRow(m, opts = {}) {
  const { canAdmin = false, canScopes = false } = opts;
  const initial = ((m.name || m.email || '?')[0] || '?').toUpperCase();
  // A role this view doesn't offer (e.g. field_technician) still shows as itself.
  const roleChoices = ORG_ROLES.includes(m.role) ? ORG_ROLES : [...ORG_ROLES, m.role];

  const roleCell = canAdmin
    ? `<select class="member-role-select" data-member-id="${esc(m.user_id)}" aria-label="${esc(t('org_members.col.role'))}">
         ${roleChoices.map(r => `<option value="${esc(r)}"${r === m.role ? ' selected' : ''}>${esc(t('members.role.' + r))}</option>`).join('')}
       </select>`
    : `<div class="member-role">${esc(t('members.role.' + m.role))}</div>`;

  // Refs 49/67: a regional viewer's regions, and the button that edits them.
  const isRegional = m.role === 'regional_viewer';
  const scopeLine = isRegional && Array.isArray(m._scopes)
    ? `<div class="member-email" style="color:var(--text-muted)">${esc(m._scopes.length
        ? t('org_members.scopes.summary', { list: m._scopes.map(r => r.name).join(', ') })
        : t('org_members.scopes.none'))}</div>`
    : '';
  const scopeBtn = isRegional && canScopes
    ? `<button class="member-action-btn" type="button" data-region-scopes="${esc(m.user_id)}"
               data-member-name="${esc(m.name || m.email)}"
               aria-label="${esc(t('org_members.scopes.button'))}" title="${esc(t('org_members.scopes.button'))}">${REGIONS_ICON}</button>`
    : '';

  const actionsCell = canAdmin || scopeBtn
    ? `<div class="member-actions">
         ${scopeBtn}
         ${canAdmin ? `<button class="member-action-btn member-action-btn--danger" type="button"
                 data-remove-member="${esc(m.user_id)}"
                 data-member-name="${esc(m.name || m.email)}"
                 aria-label="${esc(t('org_members.button.remove'))}"
                 title="${esc(t('org_members.button.remove'))}">${REMOVE_ICON}</button>` : ''}
       </div>`
    : '';

  return `
    <div class="member-row">
      <div class="member-avatar">${esc(initial)}</div>
      <div class="member-meta">
        <div class="member-name">${esc(m.name || m.email)}</div>
        <div class="member-email">${esc(m.email)}</div>
        ${scopeLine}
      </div>
      ${roleCell}
      <div class="member-detail">${esc(formatDate(m.joined_at))}</div>
      ${actionsCell}
    </div>
  `;
}

function attachMutationHandlers(container, orgId) {
  container.querySelectorAll('select[data-member-id]').forEach(sel => {
    sel.addEventListener('change', async () => {
      const userId = sel.dataset.memberId;
      const newRole = sel.value;
      try {
        await api.updateOrgMemberRole(orgId, userId, newRole);
        showToast(t('org_members.success.role_changed'), 'success');
        render(container, orgId);
      } catch (err) {
        showToast(mapMutationError(err), 'error');
        render(container, orgId);
      }
    });
  });

  container.querySelectorAll('[data-remove-member]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const userId = btn.dataset.removeMember;
      const name = btn.dataset.memberName;
      if (!confirm(t('org_members.confirm.remove_member', { name }))) return;
      try {
        await api.removeOrgMember(orgId, userId);
        showToast(t('org_members.success.member_removed', { name }), 'success');
        render(container, orgId);
      } catch (err) {
        showToast(mapMutationError(err), 'error');
      }
    });
  });
}

// Map a backend mutation-error message to a translated user-facing string.
// Order matters - most specific patterns first.
export function mapMutationError(err) {
  const msg = err?.message || '';
  if (/User not found/i.test(msg)) return t('org_members.error.user_not_found');
  if (/already a member/i.test(msg)) return t('org_members.error.already_member');
  if (/Cannot demote the last organization owner/i.test(msg)) return t('org_members.error.last_owner_demote');
  if (/Cannot remove the last organization owner/i.test(msg)) return t('org_members.error.last_owner_remove');
  if (/primary owner/i.test(msg)) return t('org_members.error.primary_owner_protected');
  if (/Only a platform admin can/i.test(msg)) return t('org_members.error.owner_grant_forbidden');
  if (/Valid email required/i.test(msg)) return t('org_members.error.invalid_email');
  return t('org_members.error.mutation_generic', { error: msg });
}

// Wires the CSV/XLSX/PDF export dropdown. Same open/close + fetch-blob-and-
// download behavior as reports.js's export menu; self-removing document
// click listener since this view has no teardown hook and render() re-runs
// on every visit.
function wireExportMenu(orgId) {
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
      const url = `/api/organizations/${orgId}/members/export?format=${format}`;

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
      a.download = `org-members.${format}`;
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

const ORG_ROLES = ['org_owner', 'org_admin', 'regional_viewer'];
// Refs 49/67: map-pin icon for a regional viewer's Regions button (icon-sized, like
// the remove button, so the row still fits at phone widths).
const REGIONS_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>';
const REMOVE_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
