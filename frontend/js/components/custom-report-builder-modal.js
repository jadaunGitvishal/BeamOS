// Ref 74 Stage 4: ad-hoc custom report builder modal. Opened from the
// "Export custom reports" button on the Reports view (views/reports.js),
// parallel to that view's existing fixed proof-of-play Export button.
//
// Flow: fetch the Stage 1 field registry (GET /api/reports/custom/fields) ->
// user picks columns (grouped by domain) + builds filter rows + optional date
// range + format -> Preview (POST .../custom/preview, Stage 2's safety-checked
// query, 20-row cap) -> Export (POST .../custom/export, Stage 3, same query
// uncapped-in-shape but row-capped, rendered through the shared CSV/XLSX/PDF
// engine). Export stays disabled until a Preview has succeeded for the
// CURRENT selection - changing anything after a preview re-disables it, so
// what gets exported was always seen first.
import { showToast } from './toast.js';

const OPERATOR_LABELS = {
  eq: 'equals', neq: 'not equals', contains: 'contains',
  gt: '>', gte: '>=', lt: '<', lte: '<=', between: 'between',
};
const OPERATORS_BY_TYPE = {
  string: ['eq', 'neq', 'contains'],
  number: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between'],
  date: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between'],
  boolean: ['eq', 'neq'],
};

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function authHeaders() {
  const token = localStorage.getItem('token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function apiJson(url, opts = {}) {
  const res = await fetch('/api' + url, {
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(opts.headers || {}) },
    ...opts,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || 'Request failed');
  return json;
}

export async function openCustomReportBuilderModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:720px;width:96%">
      <div class="modal-header">
        <h3>Export custom report</h3>
        <button class="btn-icon" type="button" data-crb-close aria-label="Close">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
      <div class="modal-body" id="crbBody" style="max-height:70vh;overflow-y:auto">
        <div class="empty-state"><h3>Loading fields...</h3></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" type="button" data-crb-close>Cancel</button>
        <button class="btn btn-secondary" type="button" id="crbPreviewBtn">Preview</button>
        <button class="btn btn-primary" type="button" id="crbExportBtn" disabled>Export</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  function close() { overlay.remove(); document.removeEventListener('keydown', onKey); }
  function onKey(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelectorAll('[data-crb-close]').forEach((b) => b.addEventListener('click', close));

  const body = overlay.querySelector('#crbBody');
  const previewBtn = overlay.querySelector('#crbPreviewBtn');
  const exportBtn = overlay.querySelector('#crbExportBtn');

  let registry;
  try {
    registry = await apiJson('/reports/custom/fields');
  } catch (err) {
    body.innerHTML = `<div class="empty-state"><h3>Could not load report fields</h3><p>${esc(err.message)}</p></div>`;
    return;
  }

  const fieldsById = new Map(registry.fields.map((f) => [f.id, f]));
  const fieldsByDomain = new Map();
  for (const f of registry.fields) {
    if (!fieldsByDomain.has(f.domain)) fieldsByDomain.set(f.domain, []);
    fieldsByDomain.get(f.domain).push(f);
  }

  const columnPickerHtml = [...fieldsByDomain.entries()].map(([domain, fields]) => `
    <div class="crb-domain-group" style="margin-bottom:10px">
      <div style="font-size:12px;font-weight:600;color:var(--text-muted);margin-bottom:4px">${esc(registry.domains[domain] || domain)}</div>
      <div style="display:flex;flex-wrap:wrap;gap:8px 16px">
        ${fields.map((f) => `
          <label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer">
            <input type="checkbox" class="crb-field-checkbox" value="${esc(f.id)}">
            ${esc(f.label)}
          </label>
        `).join('')}
      </div>
    </div>
  `).join('');

  const fieldOptionsHtml = [...fieldsByDomain.entries()].map(([domain, fields]) => `
    <optgroup label="${esc(registry.domains[domain] || domain)}">
      ${fields.map((f) => `<option value="${esc(f.id)}">${esc(f.label)}</option>`).join('')}
    </optgroup>
  `).join('');

  body.innerHTML = `
    <div class="form-group">
      <label>Columns</label>
      ${columnPickerHtml}
    </div>

    <div class="form-group">
      <label>Filters</label>
      <div id="crbFilterRows"></div>
      <button type="button" class="btn btn-secondary btn-sm" id="crbAddFilter">+ Add filter</button>
    </div>

    <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end;margin-bottom:12px">
      <div class="form-group" style="margin:0">
        <label>From date <span style="color:var(--text-muted);font-weight:400">(optional)</span></label>
        <input type="date" id="crbDateStart" class="input">
      </div>
      <div class="form-group" style="margin:0">
        <label>To date <span style="color:var(--text-muted);font-weight:400">(optional)</span></label>
        <input type="date" id="crbDateEnd" class="input">
      </div>
      <div class="form-group" style="margin:0">
        <label>Format</label>
        <select id="crbFormat" class="input">
          <option value="csv">CSV</option>
          <option value="xlsx">XLSX</option>
          <option value="pdf">PDF</option>
        </select>
      </div>
    </div>

    <div id="crbError" style="display:none;color:var(--danger);font-size:13px;margin-bottom:12px"></div>
    <div id="crbPreviewWrap"></div>
  `;

  const filterRowsEl = body.querySelector('#crbFilterRows');
  const errorEl = body.querySelector('#crbError');
  const previewWrap = body.querySelector('#crbPreviewWrap');

  function showError(msg) { errorEl.textContent = msg; errorEl.style.display = 'block'; }
  function clearError() { errorEl.style.display = 'none'; }

  // Any change to the selection invalidates the last preview - export must
  // reflect what the user actually looked at.
  function invalidatePreview() {
    exportBtn.disabled = true;
    previewWrap.innerHTML = '';
  }

  function valueInputHtml(field, cls) {
    if (field.type === 'boolean') {
      return `<select class="${cls} input"><option value="true">Yes</option><option value="false">No</option></select>`;
    }
    if (field.type === 'date') return `<input type="date" class="${cls} input">`;
    if (field.type === 'number') return `<input type="number" class="${cls} input" style="width:100px">`;
    return `<input type="text" class="${cls} input" style="width:140px">`;
  }

  function addFilterRow() {
    const row = document.createElement('div');
    row.className = 'crb-filter-row';
    row.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:6px;flex-wrap:wrap';
    row.innerHTML = `
      <select class="crb-filter-field input" style="width:180px">${fieldOptionsHtml}</select>
      <select class="crb-filter-operator input" style="width:110px"></select>
      <span class="crb-value-cell" style="display:flex;gap:6px"></span>
      <button type="button" class="btn-icon crb-remove-filter" aria-label="Remove filter">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    `;
    filterRowsEl.appendChild(row);

    const fieldSelect = row.querySelector('.crb-filter-field');
    const operatorSelect = row.querySelector('.crb-filter-operator');
    const valueCell = row.querySelector('.crb-value-cell');

    function renderOperators() {
      const field = fieldsById.get(fieldSelect.value);
      const ops = OPERATORS_BY_TYPE[field.type] || [];
      operatorSelect.innerHTML = ops.map((op) => `<option value="${op}">${OPERATOR_LABELS[op]}</option>`).join('');
      renderValueInputs();
    }
    function renderValueInputs() {
      const field = fieldsById.get(fieldSelect.value);
      const op = operatorSelect.value;
      if (op === 'between') {
        valueCell.innerHTML = valueInputHtml(field, 'crb-filter-value-from') + valueInputHtml(field, 'crb-filter-value-to');
      } else {
        valueCell.innerHTML = valueInputHtml(field, 'crb-filter-value');
      }
      valueCell.querySelectorAll('input,select').forEach((el) => el.addEventListener('input', invalidatePreview));
    }

    fieldSelect.addEventListener('change', () => { renderOperators(); invalidatePreview(); });
    operatorSelect.addEventListener('change', () => { renderValueInputs(); invalidatePreview(); });
    row.querySelector('.crb-remove-filter').addEventListener('click', () => { row.remove(); invalidatePreview(); });

    renderOperators();
  }

  body.querySelector('#crbAddFilter').addEventListener('click', addFilterRow);
  body.querySelectorAll('.crb-field-checkbox').forEach((cb) => cb.addEventListener('change', invalidatePreview));
  body.querySelector('#crbDateStart').addEventListener('input', invalidatePreview);
  body.querySelector('#crbDateEnd').addEventListener('input', invalidatePreview);
  body.querySelector('#crbFormat').addEventListener('change', invalidatePreview);

  function coerceFilterValue(field, raw) {
    if (field.type === 'boolean') return raw === 'true';
    if (field.type === 'number') return raw === '' ? null : Number(raw);
    return raw;
  }

  function collectSelection() {
    const fields = [...body.querySelectorAll('.crb-field-checkbox:checked')].map((cb) => cb.value);
    const filters = [];
    for (const row of filterRowsEl.querySelectorAll('.crb-filter-row')) {
      const fieldId = row.querySelector('.crb-filter-field').value;
      const operator = row.querySelector('.crb-filter-operator').value;
      const field = fieldsById.get(fieldId);
      if (operator === 'between') {
        const from = row.querySelector('.crb-filter-value-from').value;
        const to = row.querySelector('.crb-filter-value-to').value;
        if (from === '' || to === '') continue; // incomplete row, skip rather than send a broken filter
        filters.push({ fieldId, operator, value: [coerceFilterValue(field, from), coerceFilterValue(field, to)] });
      } else {
        const valueEl = row.querySelector('.crb-filter-value');
        const raw = valueEl.value;
        if (raw === '') continue;
        filters.push({ fieldId, operator, value: coerceFilterValue(field, raw) });
      }
    }
    const start = body.querySelector('#crbDateStart').value;
    const end = body.querySelector('#crbDateEnd').value;
    const dateRange = (start || end) ? { start: start || undefined, end: end || undefined } : undefined;
    const format = body.querySelector('#crbFormat').value;
    return { fields, filters, dateRange, format };
  }

  function renderPreviewTable(data) {
    if (data.rows.length === 0) {
      previewWrap.innerHTML = `<div class="empty-state"><h3>No matching rows</h3></div>`;
      return;
    }
    previewWrap.innerHTML = `
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:6px">
        Preview - first ${data.rows.length} row${data.rows.length === 1 ? '' : 's'}
      </div>
      <div class="table-wrap">
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead><tr style="border-bottom:1px solid var(--border)">
            ${data.columns.map((c) => `<th style="padding:6px;text-align:left;color:var(--text-muted)">${esc(c)}</th>`).join('')}
          </tr></thead>
          <tbody>
            ${data.rows.map((r) => `
              <tr style="border-bottom:1px solid var(--border)">
                ${r.map((v) => `<td style="padding:6px">${esc(v === null || v === undefined ? '' : v)}</td>`).join('')}
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  previewBtn.addEventListener('click', async () => {
    clearError();
    const selection = collectSelection();
    if (selection.fields.length === 0) { showError('Pick at least one column.'); return; }
    previewBtn.disabled = true;
    previewBtn.textContent = 'Loading...';
    try {
      const data = await apiJson('/reports/custom/preview', { method: 'POST', body: JSON.stringify(selection) });
      renderPreviewTable(data);
      exportBtn.disabled = false;
    } catch (err) {
      showError(err.message || 'Preview failed');
      exportBtn.disabled = true;
    } finally {
      previewBtn.disabled = false;
      previewBtn.textContent = 'Preview';
    }
  });

  exportBtn.addEventListener('click', async () => {
    clearError();
    const selection = collectSelection();
    exportBtn.disabled = true;
    exportBtn.textContent = 'Exporting...';
    try {
      const res = await fetch('/api/reports/custom/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(selection),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Export failed');
      }
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `custom-report.${selection.format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      showToast('Report exported', 'success');
    } catch (err) {
      showError(err.message || 'Export failed');
    } finally {
      exportBtn.disabled = false;
      exportBtn.textContent = 'Export';
    }
  });

  addFilterRow();
}
