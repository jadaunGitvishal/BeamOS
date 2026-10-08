// PMI Ref 68: Field Operations report modal. Opened from the "Field operations"
// button on the Reports view (views/reports.js), next to "Export custom reports".
//
// GET /api/reports/field-operations?period=&date=&format= for the ACTIVE workspace.
// Section names and the "definition assumed" notes come from the API (its `sections[*]
// .label` and `definitions.pmi_confirmation_pending`), never from this file, so the
// server's lib/field-ops-summary.js config stays the only place they are defined.
import { showToast } from './toast.js';
import { esc } from '../utils.js';
import { t } from '../i18n.js';

function authHeaders() {
  const token = localStorage.getItem('token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

const fmt = (epoch) => (epoch ? new Date(epoch * 1000).toISOString().slice(0, 16).replace('T', ' ') : '');

function table(headers, rows, emptyText = t('fieldops.none')) {
  const head = headers.map((h) => `<th style="padding:6px 8px;text-align:left;color:var(--text-muted);white-space:nowrap">${esc(h)}</th>`).join('');
  const body = rows.length
    ? rows.map((r) => `<tr style="border-bottom:1px solid var(--border)">${r.map((c) => `<td style="padding:6px 8px;vertical-align:top">${esc(c ?? '')}</td>`).join('')}</tr>`).join('')
    : `<tr><td colspan="${headers.length}" style="padding:12px;text-align:center;color:var(--text-muted)">${esc(emptyText)}</td></tr>`;
  return `<div class="table-wrap"><table style="width:100%;border-collapse:collapse;font-size:12px">
    <thead><tr style="border-bottom:1px solid var(--border)">${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function card(label, value) {
  return `<div class="info-card"><div class="info-card-label">${esc(label)}</div><div class="info-card-value">${esc(value ?? '-')}</div></div>`;
}

function sectionBlock(section, pendingKeys, key, inner) {
  const note = pendingKeys.has(key)
    ? `<div data-fo-pending="${esc(key)}" style="font-size:12px;color:var(--warning, #b7791f);margin:-6px 0 10px">${esc(t('fieldops.pending_note'))}</div>`
    : '';
  return `<div class="settings-section" style="margin-bottom:16px" data-fo-section="${esc(key)}">
    <h3 style="font-size:14px;margin-bottom:10px">${esc(section.label)}</h3>${note}${inner}</div>`;
}

function subHeading(text) {
  return `<h4 style="font-size:12px;margin:12px 0 6px;color:var(--text-muted)">${esc(text)}</h4>`;
}

const techRows = (s) => s.by_technician.map((r) => [r.technician_name, r.visits]);
const visitRows = (s) => s.visits.map((v) => [fmt(v.completed_at), v.device_name || v.device_id, v.technician_name, v.visit_type, v.device_status || '', v.remarks || '']);

function renderReport(r) {
  const s = r.sections;
  const pendingKeys = new Set((r.definitions.pmi_confirmation_pending || []).map((p) => p.section));
  const visitHeaders = [t('fieldops.col.completed'), t('fieldops.col.screen'), t('fieldops.col.technician'), t('fieldops.col.visit_type'), t('fieldops.col.device_status'), t('fieldops.col.remarks')];
  const techHeaders = [t('fieldops.col.technician'), t('fieldops.col.visits')];
  const screenHeaders = [t('fieldops.col.screen'), t('fieldops.col.visits'), t('fieldops.col.last_status')];
  const visitSection = (key) =>
    sectionBlock(s[key], pendingKeys, key, `
      <div class="info-grid" style="margin-bottom:8px">${card(t('fieldops.completed_visits'), s[key].completed_visits)}</div>
      ${subHeading(t('fieldops.by_technician'))}${table(techHeaders, techRows(s[key]))}
      ${subHeading(t('fieldops.by_screen'))}${table(screenHeaders, s[key].by_screen.map((b) => [b.device_name || b.device_id, b.visits, b.last_device_status || '']))}
      ${subHeading(t('fieldops.visit_list'))}${table(visitHeaders, visitRows(s[key]))}`);

  return `
    <div style="font-size:13px;color:var(--text-muted);margin-bottom:12px" id="foPeriodLabel">
      ${esc(r.workspace ? r.workspace.name : '')} · ${esc(r.period.label)} · ${esc(t('fieldops.utc_range', { start: fmt(r.period.start_epoch), end: fmt(r.period.end_epoch) }))}
      ${r.period.complete === false ? ` · <strong>${esc(t('fieldops.incomplete'))}</strong>` : ''}
    </div>
    ${sectionBlock(s.installation, pendingKeys, 'installation', `
      <div class="info-grid" style="margin-bottom:8px">
        ${card(t('fieldops.completed_visits'), s.installation.completed_visits)}
        ${card(t('fieldops.activations'), s.installation.activations)}
      </div>
      ${subHeading(t('fieldops.by_technician'))}${table(techHeaders, techRows(s.installation))}
      ${subHeading(t('fieldops.visit_list'))}${table(visitHeaders, visitRows(s.installation))}
      ${subHeading(t('fieldops.activated_screens'))}${table([t('fieldops.col.activated'), t('fieldops.col.screen')], s.installation.activated_screens.map((a) => [fmt(a.activated_at), a.device_name || a.device_id]))}`)}
    ${visitSection('rfs')}
    ${visitSection('rm')}
    ${sectionBlock(s.oem, pendingKeys, 'oem', `
      <div class="info-grid" style="margin-bottom:8px">
        ${card(t('fieldops.oem_opened'), s.oem.opened_in_period)}
        ${card(t('fieldops.oem_resolved'), s.oem.resolved_in_period)}
        ${card(r.definitions.metric_labels.oem_open_now, s.oem.open_now)}
        ${card(t('fieldops.oem_avg_age'), s.oem.avg_open_age_days)}
      </div>
      ${table(
        [t('fieldops.col.opened'), t('fieldops.col.resolved'), t('fieldops.col.screen'), t('fieldops.col.title'), t('fieldops.col.status'), t('fieldops.col.age_days')],
        s.oem.cases.map((c) => [fmt(c.created_at), fmt(c.resolved_at), c.device_name || '', c.title, c.status, c.open_age_days ?? '']),
      )}`)}
    ${sectionBlock(s.other, pendingKeys, 'other', `
      <div class="info-grid" style="margin-bottom:8px">${card(t('fieldops.completed_visits'), s.other.completed_visits)}</div>
      ${table(visitHeaders, visitRows(s.other))}`)}
    ${sectionBlock(s.in_progress, pendingKeys, 'in_progress', `
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">${esc(t('fieldops.in_progress_hint'))}</div>
      ${table(
        [t('fieldops.col.started'), t('fieldops.col.screen'), t('fieldops.col.technician'), t('fieldops.col.visit_type'), t('fieldops.col.remarks')],
        s.in_progress.visits.map((v) => [fmt(v.created_at), v.device_name || v.device_id, v.technician_name, v.visit_type, v.remarks || '']),
      )}`)}
  `;
}

export async function openFieldOpsReportModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:960px;width:96%">
      <div class="modal-header">
        <h3>${esc(t('fieldops.title'))}</h3>
        <button class="btn-icon" type="button" data-fo-close aria-label="${esc(t('fieldops.close'))}">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
      <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end;padding:0 20px 12px">
        <div class="form-group" style="margin:0"><label for="foPeriod">${esc(t('fieldops.period'))}</label>
          <select id="foPeriod" class="input" style="min-width:140px;max-width:100%;background:var(--bg-input)">
            <option value="day">${esc(t('fieldops.period_day'))}</option>
            <option value="week" selected>${esc(t('fieldops.period_week'))}</option>
            <option value="month">${esc(t('fieldops.period_month'))}</option>
          </select>
        </div>
        <div class="form-group" style="margin:0"><label for="foDate">${esc(t('fieldops.date'))}</label>
          <input type="date" id="foDate" class="input" max="${new Date().toISOString().slice(0, 10)}">
        </div>
        <button class="btn btn-primary btn-sm" type="button" id="foLoad">${esc(t('fieldops.load'))}</button>
        <div style="display:flex;gap:6px;margin-left:auto">
          <button class="btn btn-secondary btn-sm" type="button" data-fo-format="csv">CSV</button>
          <button class="btn btn-secondary btn-sm" type="button" data-fo-format="xlsx">XLSX</button>
          <button class="btn btn-secondary btn-sm" type="button" data-fo-format="pdf">PDF</button>
        </div>
      </div>
      <div style="font-size:12px;color:var(--text-muted);padding:0 20px 8px">${esc(t('fieldops.date_hint'))}</div>
      <div class="modal-body" id="foBody" style="max-height:65vh;overflow-y:auto">
        <div class="empty-state"><h3>${esc(t('common.loading'))}</h3></div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  function close() { overlay.remove(); document.removeEventListener('keydown', onKey); }
  function onKey(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelectorAll('[data-fo-close]').forEach((b) => b.addEventListener('click', close));

  const body = overlay.querySelector('#foBody');
  const query = (format) => {
    const params = new URLSearchParams({ period: overlay.querySelector('#foPeriod').value, format });
    const date = overlay.querySelector('#foDate').value;
    if (date) params.set('date', date);
    return `/api/reports/field-operations?${params}`;
  };

  async function load() {
    body.innerHTML = `<div class="empty-state"><h3>${esc(t('common.loading'))}</h3></div>`;
    try {
      const res = await fetch(query('json'), { headers: authHeaders() });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || t('fieldops.load_failed'));
      body.innerHTML = renderReport(json);
    } catch (err) {
      body.innerHTML = `<div class="empty-state"><h3>${esc(t('report.error'))}</h3><p>${esc(err.message)}</p></div>`;
    }
  }

  async function download(format) {
    try {
      const res = await fetch(query(format), { headers: authHeaders() });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || t('fieldops.export_failed'));
      }
      const name = (/filename=([^;]+)/.exec(res.headers.get('Content-Disposition') || '') || [])[1] || `field-operations.${format}`;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name.trim();
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  overlay.querySelector('#foLoad').addEventListener('click', load);
  overlay.querySelector('#foPeriod').addEventListener('change', load);
  overlay.querySelectorAll('[data-fo-format]').forEach((b) => b.addEventListener('click', () => download(b.dataset.foFormat)));
  load();
}
