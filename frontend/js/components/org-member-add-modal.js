// Add-Organization-Member modal. Adds an EXISTING user (by email) to an org
// with an org_owner/org_admin role - no account creation, no email invite
// (server 404s if the email has no BeamOS account). Styled like
// admin-create-org-modal.js.
import { api } from '../api.js';
import { t } from '../i18n.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Order = display order (least-privilege first, matching the workspace add-user
// modal's convention). Server validates set membership and further scopes which
// roles a non-platform-admin caller may grant (org_owner is platform-admin-only).
const ORG_ROLES = ['org_admin', 'org_owner'];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

export function openAddOrgMemberModal(org, opts = {}) {
  const { onSuccess, mapError } = opts;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <h3>${t('org_members.modal.add_title', { org: esc(org.name) })}</h3>
        <button class="btn-icon" type="button" data-org-member-close aria-label="Close">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label for="orgMemberEmail">${t('org_members.modal.email_label')}</label>
          <input id="orgMemberEmail" type="email" class="input" placeholder="${t('org_members.modal.email_placeholder')}" style="width:100%" autocomplete="off" autocapitalize="off" spellcheck="false">
        </div>
        <div class="form-group">
          <label for="orgMemberRole">${t('org_members.modal.role_label')}</label>
          <select id="orgMemberRole" class="input" style="width:100%">
            ${ORG_ROLES.map(r => `<option value="${r}">${esc(t('members.role.' + r))}</option>`).join('')}
          </select>
        </div>
        <div id="orgMemberError" style="display:none;color:var(--danger);font-size:13px;margin-top:8px"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" type="button" data-org-member-close>${t('org_members.modal.cancel')}</button>
        <button class="btn btn-primary" type="button" id="orgMemberSave">${t('org_members.modal.add')}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const emailInput = overlay.querySelector('#orgMemberEmail');
  const roleSelect = overlay.querySelector('#orgMemberRole');
  const errorEl = overlay.querySelector('#orgMemberError');
  const saveBtn = overlay.querySelector('#orgMemberSave');
  emailInput.focus();

  function close() { overlay.remove(); document.removeEventListener('keydown', onKey); }
  function onKey(e) {
    if (e.key === 'Escape') close();
    else if (e.key === 'Enter' && e.target === emailInput) save();
  }
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelectorAll('[data-org-member-close]').forEach(b => b.addEventListener('click', close));

  function showError(msg) { errorEl.textContent = msg; errorEl.style.display = 'block'; }

  async function save() {
    errorEl.style.display = 'none';
    const email = emailInput.value.trim().toLowerCase();
    const role = roleSelect.value;
    if (!email || !EMAIL_RE.test(email)) {
      showError(t('org_members.error.invalid_email'));
      return;
    }
    saveBtn.disabled = true;
    saveBtn.textContent = t('org_members.modal.adding');
    try {
      const result = await api.addOrgMember(org.id, email, role);
      close();
      if (typeof onSuccess === 'function') onSuccess({ ...result, email });
    } catch (err) {
      saveBtn.disabled = false;
      saveBtn.textContent = t('org_members.modal.add');
      showError(typeof mapError === 'function' ? mapError(err) : (err.message || t('org_members.error.mutation_generic', { error: err.message || '' })));
    }
  }

  saveBtn.addEventListener('click', save);
}
