import { api } from '../api.js';
import { showToast } from '../components/toast.js';
import { t, tn } from '../i18n.js';
import { esc } from '../utils.js';

const API = (url, opts = {}) => fetch('/api' + url, { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}`, ...opts.headers }, ...opts }).then(r => r.json());

export async function render(container) {
  const hash = window.location.hash;
  if (hash.startsWith('#/layout/')) {
    const id = hash.split('#/layout/')[1];
    return renderEditor(container, id);
  }
  return renderList(container);
}

async function renderList(container) {
  container.innerHTML = `
    <div class="page-header">
      <div><h1>${t('layout.title')} <span class="help-tip" data-tip="${t('layout.help_tip')}">?</span></h1><div class="subtitle">${t('layout.subtitle')}</div></div>
      <div style="display:flex;gap:8px;align-items:center">
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
        <button class="btn btn-primary" id="newLayoutBtn">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          ${t('layout.new_layout')}
        </button>
      </div>
    </div>
    <h3 style="margin-bottom:12px;font-size:14px;color:var(--text-secondary)">${t('layout.templates')}</h3>
    <div class="content-grid" id="templateGrid"></div>
    <h3 style="margin:24px 0 12px;font-size:14px;color:var(--text-secondary)">${t('layout.my_layouts')}</h3>
    <div class="content-grid" id="layoutGrid"></div>
  `;

  document.getElementById('newLayoutBtn').onclick = async () => {
    const name = prompt(t('layout.prompt_name'));
    if (!name) return;
    const layout = await API('/layouts', { method: 'POST', body: JSON.stringify({ name, zones: [{ name: t('layout.default_zone_name'), x_percent: 0, y_percent: 0, width_percent: 100, height_percent: 100 }] }) });
    window.location.hash = `#/layout/${layout.id}`;
  };

  wireExportMenu();

  try {
    const layouts = await API('/layouts');
    const templates = layouts.filter(l => l.is_template);
    const custom = layouts.filter(l => !l.is_template);

    document.getElementById('templateGrid').innerHTML = templates.map(l => renderLayoutCard(l, true)).join('');
    document.getElementById('layoutGrid').innerHTML = custom.length ? custom.map(l => renderLayoutCard(l, false)).join('') :
      `<div class="empty-state" style="grid-column:1/-1"><p>${t('layout.empty_custom')}</p></div>`;

    container.querySelectorAll('[data-use-template]').forEach(btn => {
      btn.onclick = async () => {
        const layout = await API(`/layouts/${btn.dataset.useTemplate}/duplicate`, { method: 'POST', body: '{}' });
        window.location.hash = `#/layout/${layout.id}`;
      };
    });

    container.querySelectorAll('[data-edit-layout]').forEach(btn => {
      btn.onclick = () => { window.location.hash = `#/layout/${btn.dataset.editLayout}`; };
    });

    container.querySelectorAll('[data-delete-layout]').forEach(btn => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const name = btn.dataset.layoutName;
        if (!confirm(t('layout.confirm_delete', { name }))) return;
        try {
          await API(`/layouts/${btn.dataset.deleteLayout}`, { method: 'DELETE' });
          showToast(t('layout.toast.deleted'));
          renderList(container);
        } catch (err) {
          showToast(err.message || t('layout.toast.delete_failed'), 'error');
        }
      };
    });
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// Wires the CSV/XLSX/PDF export dropdown. Same open/close + fetch-blob-and-
// download behavior as the other export menus (playlists.js, widgets.js).
function wireExportMenu() {
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
      const url = `/api/layouts/export?format=${format}`;

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
      a.download = `layouts.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(downloadUrl);
    };
  });
}

function renderLayoutCard(layout, isTemplate) {
  const zoneCount = layout.zones?.length || 0;
  const zonesText = tn('layout.zone_count', zoneCount);
  return `
    <div class="content-item" style="cursor:pointer">
      <div class="content-item-preview" style="position:relative;background:var(--bg-primary)">
        <div style="position:absolute;inset:8px;border:1px solid var(--border)">
          ${(layout.zones || []).map(z => `
            <div style="position:absolute;left:${z.x_percent}%;top:${z.y_percent}%;width:${z.width_percent}%;height:${z.height_percent}%;
              background:rgba(59,130,246,0.15);border:1px solid rgba(59,130,246,0.4);display:flex;align-items:center;justify-content:center;
              font-size:9px;color:var(--text-muted);overflow:hidden">${esc(z.name)}</div>
          `).join('')}
        </div>
      </div>
      <div class="content-item-body">
        <div class="content-item-name">${esc(layout.name)}</div>
        <div class="content-item-size">${zonesText}${isTemplate ? ' • ' + t('layout.template_label') : ''}</div>
      </div>
      <div class="content-item-actions">
        ${isTemplate
          ? `<button class="btn btn-primary btn-sm" data-use-template="${layout.id}">${t('layout.use_template')}</button>`
          : `<button class="btn btn-secondary btn-sm" data-edit-layout="${layout.id}">${t('common.edit')}</button>`
        }
        <button class="btn btn-danger btn-sm" data-delete-layout="${layout.id}" data-layout-name="${esc(layout.name)}" style="margin-left:4px">${t('common.delete')}</button>
      </div>
    </div>
  `;
}

async function renderEditor(container, layoutId) {
  let layout;
  try {
    layout = await API(`/layouts/${layoutId}`);
  } catch { container.innerHTML = `<div class="empty-state"><h3>${t('layout.not_found')}</h3></div>`; return; }

  container.innerHTML = `
    <a href="#/layouts" class="back-link" style="display:inline-flex;align-items:center;gap:6px;color:var(--text-secondary);margin-bottom:16px;font-size:13px">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
      ${t('layout.back')}
    </a>
    <div class="page-header">
      <h1 id="layoutName">${esc(layout.name)}</h1>
      <div style="display:flex;gap:8px">
        <button class="btn btn-secondary btn-sm" id="addZoneBtn">${t('layout.add_zone')}</button>
        <button class="btn btn-primary btn-sm" id="saveLayoutBtn">${t('common.save')}</button>
      </div>
    </div>
    <div style="display:flex;gap:20px">
      <div style="flex:1">
        <div id="canvasWrap" style="position:relative;background:var(--bg-primary);border:1px solid var(--border);border-radius:var(--radius-lg);overflow:hidden">
          <div id="canvas" style="position:relative;width:100%;padding-top:56.25%">
          </div>
        </div>
      </div>
      <div style="width:280px">
        <h3 style="font-size:14px;margin-bottom:12px">${t('layout.zones')}</h3>
        <div id="zoneList"></div>
        <div id="zoneProperties" style="margin-top:16px;display:none">
          <h3 style="font-size:14px;margin-bottom:12px">${t('layout.properties')}</h3>
          <div class="form-group"><label>${t('layout.prop.name')}</label><input type="text" id="propName" class="input"></div>
          <div class="form-group"><label>${t('layout.prop.x')}</label><input type="number" id="propX" class="input" min="0" max="100" step="0.1"></div>
          <div class="form-group"><label>${t('layout.prop.y')}</label><input type="number" id="propY" class="input" min="0" max="100" step="0.1"></div>
          <div class="form-group"><label>${t('layout.prop.width')}</label><input type="number" id="propW" class="input" min="1" max="100" step="0.1"></div>
          <div class="form-group"><label>${t('layout.prop.height')}</label><input type="number" id="propH" class="input" min="1" max="100" step="0.1"></div>
          <div class="form-group"><label>${t('layout.prop.type')}</label>
            <select id="propType" class="input" style="background:var(--bg-input)">
              <option value="content">${t('layout.type_content')}</option><option value="widget">${t('layout.type_widget')}</option>
            </select>
          </div>
          <div class="form-group"><label>${t('layout.prop.fit')}</label>
            <select id="propFit" class="input" style="background:var(--bg-input)">
              <option value="contain">${t('layout.fit_contain')}</option>
              <option value="cover">${t('layout.fit_cover')}</option>
              <option value="fill">${t('layout.fit_fill')}</option>
            </select>
            <div style="font-size:11px;color:var(--text-muted);margin-top:4px">${t('layout.fit_hint')}</div>
          </div>
          <button class="btn btn-danger btn-sm" id="deleteZoneBtn" style="width:100%;justify-content:center;margin-top:8px">${t('layout.delete_zone')}</button>
        </div>
      </div>
    </div>
  `;

  const canvas = document.getElementById('canvas');
  let zones = layout.zones || [];
  let selectedZone = null;
  let dragging = null;

  // Bug #2: overlapping zones share z_index:0 by default, so paint order (DOM/
  // array order) decides who's on top - a zone earlier in the array can have
  // its body AND resize handle completely covered by a later one, silently
  // stealing clicks meant for it. Rendering the SELECTED zone at this z-index
  // (way above any realistic real z_index) guarantees its handle is always
  // reachable while selected. Purely a rendering concern - z.z_index itself
  // (the saved value) is never touched, only read.
  const SELECTED_Z_INDEX = 9999;
  const effectiveZIndex = (i, z) => selectedZone === i ? SELECTED_Z_INDEX : (z.z_index || 0);

  // Toggle the "selected" visual state on the EXISTING zone/list nodes, without
  // removing/recreating anything. renderZones() below does a full teardown-and-
  // rebuild of every .zone-el - fine when the zone set itself changes, but fatal
  // to call mid-drag: it was orphaning the very node a just-started drag's
  // onMove/onUp closures were about to update, so the drag kept moving an
  // invisible, detached copy while the visible zone stayed frozen (the data -
  // and Save - were fine; only the screen was stuck). Selecting a zone (via its
  // body, its resize handle, or its sidebar entry) must never tear the canvas
  // down, so it goes through this instead.
  function refreshSelectionVisuals() {
    canvas.querySelectorAll('.zone-el').forEach(el => {
      const i = Number(el.dataset.index);
      const isSelected = selectedZone === i;
      el.style.background = isSelected ? 'rgba(59,130,246,0.3)' : 'rgba(59,130,246,0.1)';
      el.style.borderColor = isSelected ? 'var(--accent)' : 'rgba(59,130,246,0.4)';
      el.style.zIndex = effectiveZIndex(i, zones[i]);
    });
    document.querySelectorAll('#zoneList [data-zone-idx]').forEach(item => {
      const isSelected = selectedZone === parseInt(item.dataset.zoneIdx);
      item.style.background = isSelected ? 'var(--bg-card-hover)' : 'var(--bg-secondary)';
      item.style.borderColor = isSelected ? 'var(--accent)' : 'var(--border)';
    });
  }

  function renderZones() {
    canvas.querySelectorAll('.zone-el').forEach(z => z.remove());

    zones.forEach((z, i) => {
      const el = document.createElement('div');
      el.className = 'zone-el';
      el.dataset.index = i;
      el.style.cssText = `position:absolute;left:${z.x_percent}%;top:${z.y_percent}%;width:${z.width_percent}%;height:${z.height_percent}%;
        background:${selectedZone === i ? 'rgba(59,130,246,0.3)' : 'rgba(59,130,246,0.1)'};
        border:2px solid ${selectedZone === i ? 'var(--accent)' : 'rgba(59,130,246,0.4)'};
        cursor:move;display:flex;align-items:center;justify-content:center;font-size:12px;color:var(--text-secondary);
        user-select:none;z-index:${effectiveZIndex(i, z)}`;
      el.textContent = z.name;

      el.onmousedown = (e) => {
        if (e.target !== el) return;
        e.preventDefault();
        selectedZone = i;
        refreshSelectionVisuals();
        updateProperties();
        const rect = canvas.getBoundingClientRect();
        const startX = e.clientX;
        const startY = e.clientY;
        const origX = z.x_percent;
        const origY = z.y_percent;

        const onMove = (e2) => {
          const dx = (e2.clientX - startX) / rect.width * 100;
          const dy = (e2.clientY - startY) / rect.height * 100;
          z.x_percent = Math.max(0, Math.min(100 - z.width_percent, Math.round((origX + dx) * 10) / 10));
          z.y_percent = Math.max(0, Math.min(100 - z.height_percent, Math.round((origY + dy) * 10) / 10));
          el.style.left = z.x_percent + '%';
          el.style.top = z.y_percent + '%';
          updateProperties();
        };
        const onUp = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      };

      const handle = document.createElement('div');
      handle.style.cssText = 'position:absolute;right:0;bottom:0;width:12px;height:12px;cursor:se-resize;background:var(--accent);border-radius:2px 0 0 0;opacity:0.7';
      handle.onmousedown = (e) => {
        e.preventDefault();
        e.stopPropagation();
        selectedZone = i;
        refreshSelectionVisuals();
        const rect = canvas.getBoundingClientRect();
        const onMove = (e2) => {
          const newW = ((e2.clientX - rect.left) / rect.width * 100) - z.x_percent;
          const newH = ((e2.clientY - rect.top) / rect.height * 100) - z.y_percent;
          z.width_percent = Math.max(5, Math.min(100 - z.x_percent, Math.round(newW * 10) / 10));
          z.height_percent = Math.max(5, Math.min(100 - z.y_percent, Math.round(newH * 10) / 10));
          el.style.width = z.width_percent + '%';
          el.style.height = z.height_percent + '%';
          updateProperties();
        };
        const onUp = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      };
      el.appendChild(handle);
      canvas.appendChild(el);
    });

    document.getElementById('zoneList').innerHTML = zones.map((z, i) => `
      <div style="padding:8px 10px;background:${selectedZone === i ? 'var(--bg-card-hover)' : 'var(--bg-secondary)'};
        border:1px solid ${selectedZone === i ? 'var(--accent)' : 'var(--border)'};border-radius:var(--radius);
        margin-bottom:4px;cursor:pointer;font-size:13px" data-zone-idx="${i}">
        <div style="font-weight:500">${esc(z.name)}</div>
        <div style="font-size:11px;color:var(--text-muted)">${Math.round(z.width_percent)}% x ${Math.round(z.height_percent)}% • ${esc(z.zone_type)}</div>
      </div>
    `).join('');

    document.querySelectorAll('[data-zone-idx]').forEach(el => {
      el.onclick = () => { selectedZone = parseInt(el.dataset.zoneIdx); refreshSelectionVisuals(); updateProperties(); };
    });
  }

  function updateProperties() {
    const panel = document.getElementById('zoneProperties');
    if (selectedZone === null || !zones[selectedZone]) { panel.style.display = 'none'; return; }
    panel.style.display = 'block';
    const z = zones[selectedZone];
    document.getElementById('propName').value = z.name;
    document.getElementById('propX').value = z.x_percent;
    document.getElementById('propY').value = z.y_percent;
    document.getElementById('propW').value = z.width_percent;
    document.getElementById('propH').value = z.height_percent;
    document.getElementById('propType').value = z.zone_type;
    document.getElementById('propFit').value = z.fit_mode || 'cover';
  }

  ['propName', 'propX', 'propY', 'propW', 'propH', 'propType', 'propFit'].forEach(id => {
    document.getElementById(id).oninput = () => {
      if (selectedZone === null) return;
      const z = zones[selectedZone];
      z.name = document.getElementById('propName').value;
      z.x_percent = parseFloat(document.getElementById('propX').value) || 0;
      z.y_percent = parseFloat(document.getElementById('propY').value) || 0;
      z.width_percent = parseFloat(document.getElementById('propW').value) || 10;
      z.height_percent = parseFloat(document.getElementById('propH').value) || 10;
      z.zone_type = document.getElementById('propType').value;
      z.fit_mode = document.getElementById('propFit').value;
      renderZones();
    };
  });

  document.getElementById('addZoneBtn').onclick = () => {
    zones.push({ id: null, name: t('layout.zone_n', { n: zones.length + 1 }), x_percent: 10, y_percent: 10, width_percent: 30, height_percent: 30, z_index: 0, zone_type: 'content', fit_mode: 'contain', background_color: '#000000', sort_order: zones.length });
    selectedZone = zones.length - 1;
    renderZones();
    updateProperties();
  };

  document.getElementById('deleteZoneBtn').onclick = () => {
    if (selectedZone === null) return;
    zones.splice(selectedZone, 1);
    selectedZone = null;
    renderZones();
    updateProperties();
  };

  document.getElementById('saveLayoutBtn').onclick = async () => {
    try {
      // Single atomic update: send the full zone set and the server replaces them
      // exactly. The old per-zone delete-then-add loop could accumulate zones
      // (and regenerated every zone id each save). Keep each zone's id so
      // device->zone assignments survive.
      const updated = await API(`/layouts/${layoutId}`, {
        method: 'PUT',
        body: JSON.stringify({ zones }),
      });
      if (updated && updated.error) { showToast(updated.error, 'error'); return; }
      layout = updated;
      zones = layout.zones || [];
      selectedZone = null;
      showToast(t('layout.toast.saved'), 'success');
      renderZones();
      updateProperties();
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  renderZones();
}

export function cleanup() {}
