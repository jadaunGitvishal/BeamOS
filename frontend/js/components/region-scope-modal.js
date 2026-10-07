// Refs 49/67: region-scope picker for a regional_viewer org member. Lists the
// org's regions as a tree (indented, with level) as checkboxes, pre-checked from
// GET .../region-scopes, and saves the whole set with PUT (the server replaces it
// in one transaction). The member reads every workspace in a chosen region and
// everything below it. Styled like org-member-add-modal.js.
import { api } from '../api.js';
import { t } from '../i18n.js';

const REGION_LEVELS = ['region', 'cluster', 'area', 'territory'];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// Depth-first, siblings by name: [{ r, depth }].
function treeOrder(regions) {
  const kids = new Map();
  for (const r of regions) {
    const k = r.parent_id || '';
    if (!kids.has(k)) kids.set(k, []);
    kids.get(k).push(r);
  }
  for (const list of kids.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  const out = [];
  const walk = (pid, depth) => {
    for (const r of kids.get(pid) || []) {
      out.push({ r, depth });
      if (depth < REGION_LEVELS.length) walk(r.id, depth + 1);
    }
  };
  walk('', 0);
  for (const r of regions) if (!out.some(x => x.r.id === r.id)) out.push({ r, depth: 0 });
  return out;
}

export async function openRegionScopeModal({ orgId, userId, name }, opts = {}) {
  const { onSaved } = opts;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <h3>${t('org_members.scopes.title', { name: esc(name) })}</h3>
        <button class="btn-icon" type="button" data-scope-close aria-label="Close">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
      <div class="modal-body">
        <p style="color:var(--text-muted);font-size:12px;margin-bottom:12px">${esc(t('org_members.scopes.help', { name }))}</p>
        <div id="regionScopeList" style="max-height:360px;overflow:auto;color:var(--text-muted);font-size:13px">${t('org_members.loading')}</div>
        <div id="regionScopeError" style="display:none;color:var(--danger);font-size:13px;margin-top:8px"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" type="button" data-scope-close>${t('org_members.modal.cancel')}</button>
        <button class="btn btn-primary" type="button" id="regionScopeSave" disabled>${t('org_members.scopes.save')}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const listEl = overlay.querySelector('#regionScopeList');
  const errorEl = overlay.querySelector('#regionScopeError');
  const saveBtn = overlay.querySelector('#regionScopeSave');

  function close() { overlay.remove(); document.removeEventListener('keydown', onKey); }
  function onKey(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelectorAll('[data-scope-close]').forEach(b => b.addEventListener('click', close));
  function showError(msg) { errorEl.textContent = msg; errorEl.style.display = 'block'; }

  let regions, current;
  try {
    [regions, current] = await Promise.all([
      api.getOrgRegions(orgId),
      api.getMemberRegionScopes(orgId, userId),
    ]);
  } catch (err) {
    listEl.textContent = '';
    showError(err.message || String(err));
    return;
  }
  if (!regions.length) {
    listEl.innerHTML = `<p>${esc(t('org_members.scopes.empty_org'))}</p>`;
    return;
  }
  const selected = new Set(current.region_ids || []);
  listEl.innerHTML = treeOrder(regions).map(({ r, depth }) => `
    <label style="display:flex;align-items:center;gap:8px;padding:4px 0 4px ${depth * 20}px;color:var(--text);cursor:pointer">
      <input type="checkbox" value="${esc(r.id)}"${selected.has(r.id) ? ' checked' : ''}>
      <span>${esc(r.name)}</span>
      <span style="color:var(--text-muted);font-size:12px">${esc(t('regions.level.' + (r.level || 'region')))}</span>
    </label>`).join('');
  saveBtn.disabled = false;

  saveBtn.addEventListener('click', async () => {
    errorEl.style.display = 'none';
    const ids = [...listEl.querySelectorAll('input[type=checkbox]:checked')].map(i => i.value);
    saveBtn.disabled = true;
    saveBtn.textContent = t('org_members.scopes.saving');
    try {
      const result = await api.setMemberRegionScopes(orgId, userId, ids);
      close();
      if (typeof onSaved === 'function') onSaved(result);
    } catch (err) {
      saveBtn.disabled = false;
      saveBtn.textContent = t('org_members.scopes.save');
      showError(err.message || String(err));
    }
  });
}
