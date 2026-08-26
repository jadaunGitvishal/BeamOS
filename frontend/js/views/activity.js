import { showToast } from '../components/toast.js';
import { esc } from '../utils.js';
import { t } from '../i18n.js';

const API = (url) => fetch('/api' + url, { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }}).then(r => r.json());

export async function render(container) {
  container.innerHTML = `
    <div class="page-header">
      <div><h1>${t('activity.title')}</h1><div class="subtitle">${t('activity.subtitle')}</div></div>
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
    <div id="activityList"><div class="empty-state"><h3>${t('common.loading')}</h3></div></div>
    <div style="text-align:center;margin-top:16px">
      <button class="btn btn-secondary btn-sm" id="loadMoreBtn" style="display:none">${t('activity.load_more')}</button>
    </div>
  `;
  wireExportMenu();

  let offset = 0;
  const limit = 50;

  async function loadActivity(append = false) {
    try {
      const items = await API(`/activity?limit=${limit}&offset=${offset}`);
      const list = document.getElementById('activityList');

      if (!append) list.innerHTML = '';

      if (items.length === 0 && offset === 0) {
        list.innerHTML = `<div class="empty-state"><h3>${t('activity.empty_title')}</h3><p>${t('activity.empty_desc')}</p></div>`;
        return;
      }

      const html = items.map(item => {
        const time = new Date(item.created_at * 1000);
        const timeStr = time.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
                        time.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
        const icon = getActionIcon(item.action);

        return `
          <div style="display:flex;gap:12px;padding:12px 0;border-bottom:1px solid var(--border);align-items:flex-start">
            <div style="width:32px;height:32px;border-radius:50%;background:var(--bg-card);display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:14px">${icon}</div>
            <div style="flex:1;min-width:0">
              <div style="font-size:13px">
                <strong>${esc(item.user_name || item.user_email || t('activity.system'))}</strong>
                <span style="color:var(--text-secondary)"> ${esc(formatAction(item.action))}</span>
              </div>
              ${item.details ? `<div style="font-size:12px;color:var(--text-muted);margin-top:2px">${esc(item.details)}</div>` : ''}
            </div>
            <div style="font-size:11px;color:var(--text-muted);white-space:nowrap;flex-shrink:0">${timeStr}</div>
          </div>
        `;
      }).join('');

      if (append) {
        list.insertAdjacentHTML('beforeend', html);
      } else {
        list.innerHTML = html;
      }

      document.getElementById('loadMoreBtn').style.display = items.length >= limit ? '' : 'none';
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  document.getElementById('loadMoreBtn').onclick = () => {
    offset += limit;
    loadActivity(true);
  };

  loadActivity();
}

function getActionIcon(action) {
  if (action.includes('DELETE')) return '&#128465;';
  if (action.includes('POST') && action.includes('content')) return '&#128228;';
  if (action.includes('POST') && action.includes('provision')) return '&#128279;';
  if (action.includes('POST') && action.includes('assignment')) return '&#128203;';
  if (action.includes('alert')) return '&#128276;';
  if (action.includes('PUT')) return '&#9998;';
  if (action.includes('POST')) return '&#10133;';
  return '&#128196;';
}

// Action verbs are user-visible; translate them through t() so they switch
// languages with the rest of the UI. The mapping below preserves the original
// verb-then-noun structure of the English version.
function formatAction(action) {
  // Verbs
  let s = action
    .replace('POST /api/', t('activity.verb_created') + ' ')
    .replace('PUT /api/', t('activity.verb_updated') + ' ')
    .replace('DELETE /api/', t('activity.verb_deleted') + ' ');
  // Specific endpoints
  s = s
    .replace('/provision/pair', t('activity.action_paired_device'))
    .replace('/content/remote', t('activity.action_added_remote_content'))
    .replace('/content', t('activity.noun_content'))
    .replace('/devices/:id', t('activity.noun_device'))
    .replace('/assignments/device/:deviceId', t('activity.noun_playlist_assignment'))
    .replace('/assignments/:id', t('activity.noun_assignment'))
    .replace('/layouts', t('activity.noun_layout'))
    .replace('/widgets', t('activity.noun_widget'))
    .replace('/schedules', t('activity.noun_schedule'))
    .replace('/walls', t('activity.noun_video_wall'))
    .replace('alert:device_offline', t('activity.alert_device_offline'));
  return s;
}

// Wires the CSV/XLSX/PDF export dropdown. Same open/close + fetch-blob-and-
// download behavior as workspace-members.js's export menu; self-removing
// document click listener since this view has no teardown hook and render()
// re-runs on every visit.
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
      const url = `/api/activity/export?format=${format}`;

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
      a.download = `activity-log.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(downloadUrl);
    };
  });
}

export function cleanup() {}
