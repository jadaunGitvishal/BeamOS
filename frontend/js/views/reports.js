import { api } from "../api.js";
import { showToast } from "../components/toast.js";
import { esc } from "../utils.js";
import { t } from "../i18n.js";

const API = (url, opts = {}) =>
  fetch("/api" + url, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem("token")}`,
      ...opts.headers,
    },
    ...opts,
  }).then((r) => r.json());

export async function render(container) {
  const devices = await api.getDevices();
  const today = new Date();
  const thirtyDaysAgo = new Date(today);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  container.innerHTML = `
    <div class="page-header">
      <div><h1>${t("report.title")} <span class="help-tip" data-tip="${t("report.help_tip")}">?</span></h1><div class="subtitle">${t("report.subtitle")}</div></div>
      <div class="export-menu-wrap" id="exportMenuWrap">
        <button type="button" class="btn btn-secondary" id="exportBtn" aria-haspopup="true" aria-expanded="false">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
          ${t("report.export_csv")}
        </button>
        <div class="export-menu" id="exportMenu" role="menu">
          <button type="button" class="export-menu-item" data-format="csv" role="menuitem">CSV</button>
          <button type="button" class="export-menu-item" data-format="xlsx" role="menuitem">XLSX</button>
          <button type="button" class="export-menu-item" data-format="pdf" role="menuitem">PDF</button>
        </div>
      </div>
    </div>

    <div style="display:flex;gap:12px;margin-bottom:20px;flex-wrap:wrap;align-items:flex-end">
      <div class="form-group" style="margin:0"><label>${t("report.device")}</label>
        <select id="reportDevice" class="input" style="width:200px;background:var(--bg-input)">
          <option value="">${t("report.all_devices")}</option>
          ${devices.map((d) => `<option value="${d.id}">${d.name}</option>`).join("")}
        </select>
      </div>
      <div class="form-group" style="margin:0"><label>${t("report.start_date")}</label>
        <input type="date" id="reportStart" class="input" value="${thirtyDaysAgo.toISOString().split("T")[0]}">
      </div>
      <div class="form-group" style="margin:0"><label>${t("report.end_date")}</label>
        <input type="date" id="reportEnd" class="input" value="${today.toISOString().split("T")[0]}">
      </div>
      <button class="btn btn-primary btn-sm" id="loadReportBtn">${t("report.load_report")}</button>
    </div>

    <div id="reportContent"><div class="empty-state"><h3>${t("report.select_range")}</h3></div></div>
  `;

  document.getElementById("loadReportBtn").onclick = loadReport;
  loadReport();

  // document.getElementById('exportBtn').onclick = () => {
  //   const deviceId = document.getElementById('reportDevice').value;
  //   const start = document.getElementById('reportStart').value;
  //   const end = document.getElementById('reportEnd').value;
  //   const token = localStorage.getItem('token');
  //   window.open(`/api/reports/export?device_id=${deviceId}&start=${start}&end=${end}&token=${token}`, '_blank');
  // };

  const exportMenuWrap = document.getElementById("exportMenuWrap");
  const exportBtn = document.getElementById("exportBtn");

  exportBtn.onclick = (e) => {
    e.stopPropagation();
    const opening = !exportMenuWrap.classList.contains("open");
    exportMenuWrap.classList.toggle("open");
    exportBtn.setAttribute("aria-expanded", String(opening));
  };

  // Self-removing: this view has no teardown hook, and render() re-runs on
  // every visit to the Reports tab, so a plain addEventListener here would
  // stack one stale listener per visit. Once exportMenuWrap is no longer in
  // the document (replaced by the next render), the listener detaches itself.
  document.addEventListener("click", function onDocClick(e) {
    if (!document.body.contains(exportMenuWrap)) {
      document.removeEventListener("click", onDocClick);
      return;
    }
    if (!exportMenuWrap.contains(e.target)) {
      exportMenuWrap.classList.remove("open");
      exportBtn.setAttribute("aria-expanded", "false");
    }
  });

  exportMenuWrap.querySelectorAll(".export-menu-item").forEach((item) => {
    item.onclick = async () => {
      exportMenuWrap.classList.remove("open");
      exportBtn.setAttribute("aria-expanded", "false");

      const format = item.dataset.format;
      const deviceId = document.getElementById("reportDevice").value;
      const start = document.getElementById("reportStart").value;
      const end = document.getElementById("reportEnd").value;

      const token = localStorage.getItem("token");

      const url = `/api/reports/export?device_id=${deviceId}&start=${start}&end=${end}&format=${format}`;

      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        const error = await response.json();
        showToast(error.error || "Export failed", "error");
        return;
      }

      const blob = await response.blob();

      const downloadUrl = window.URL.createObjectURL(blob);

      const a = document.createElement("a");
      a.href = downloadUrl;
      a.download = `proof-of-play.${format}`;

      document.body.appendChild(a);
      a.click();

      a.remove();
      window.URL.revokeObjectURL(downloadUrl);
    };
  });

  async function loadReport() {
    const deviceId = document.getElementById("reportDevice").value;
    const start = document.getElementById("reportStart").value;
    const end = document.getElementById("reportEnd").value;
    const content = document.getElementById("reportContent");

    content.innerHTML = `<div class="empty-state"><h3>${t("common.loading")}</h3></div>`;

    try {
      const summary = await API(
        `/reports/summary?device_id=${deviceId}&start=${start}&end=${end}`,
      );

      content.innerHTML = `
        <div class="info-grid" style="margin-bottom:24px">
          <div class="info-card">
            <div class="info-card-label">${t("report.total_plays")}</div>
            <div class="info-card-value">${summary.overall.total_plays.toLocaleString()}</div>
          </div>
          <div class="info-card">
            <div class="info-card-label">${t("report.total_hours")}</div>
            <div class="info-card-value">${summary.overall.total_hours}</div>
          </div>
          <div class="info-card">
            <div class="info-card-label">${t("report.unique_content")}</div>
            <div class="info-card-value">${summary.overall.unique_content}</div>
          </div>
          <div class="info-card">
            <div class="info-card-label">${t("report.active_devices")}</div>
            <div class="info-card-value">${summary.overall.unique_devices}</div>
          </div>
          <div class="info-card">
            <div class="info-card-label">${t("report.avg_duration")}</div>
            <div class="info-card-value small">${formatDuration(summary.overall.avg_duration_sec)}</div>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:24px">
          <div class="settings-section" style="margin:0">
            <h3 style="font-size:14px;margin-bottom:12px">${t("report.plays_per_day")}</h3>
            <div id="dailyChart" style="height:200px;display:flex;align-items:flex-end;gap:2px"></div>
          </div>

          <div class="settings-section" style="margin:0">
            <h3 style="font-size:14px;margin-bottom:12px">${t("report.plays_by_hour")}</h3>
            <div id="hourlyChart" style="height:200px;display:flex;align-items:flex-end;gap:1px"></div>
          </div>
        </div>

        <div class="settings-section" style="margin-bottom:20px">
          <h3 style="font-size:14px;margin-bottom:12px">${t("report.top_content")}</h3>
          <div class="table-wrap">
          <table style="width:100%;border-collapse:collapse;font-size:13px;min-width:460px">
            <thead><tr style="border-bottom:1px solid var(--border)">
              <th style="padding:8px;text-align:left;color:var(--text-muted)">${t("report.col.content")}</th>
              <th style="padding:8px;text-align:right;color:var(--text-muted)">${t("report.col.plays")}</th>
              <th style="padding:8px;text-align:right;color:var(--text-muted)">${t("report.col.total_hours")}</th>
              <th style="padding:8px;text-align:right;color:var(--text-muted)">${t("report.col.completion")}</th>
            </tr></thead>
            <tbody>
              ${
                summary.by_content
                  .map(
                    (c) => `
                <tr style="border-bottom:1px solid var(--border)">
                  <td style="padding:8px">${c.content_name || t("common.unknown")}</td>
                  <td style="padding:8px;text-align:right">${c.plays}</td>
                  <td style="padding:8px;text-align:right">${(c.total_seconds / 3600).toFixed(1)}</td>
                  <td style="padding:8px;text-align:right">${c.plays > 0 ? Math.round((c.completed_plays / c.plays) * 100) : 0}%</td>
                </tr>
              `,
                  )
                  .join("") ||
                `<tr><td colspan="4" style="padding:16px;text-align:center;color:var(--text-muted)">${t("report.no_data")}</td></tr>`
              }
            </tbody>
          </table>
          </div>
        </div>

        <div class="settings-section">
          <h3 style="font-size:14px;margin-bottom:12px">${t("report.by_device")}</h3>
          <div class="table-wrap">
          <table style="width:100%;border-collapse:collapse;font-size:13px;min-width:400px">
            <thead><tr style="border-bottom:1px solid var(--border)">
              <th style="padding:8px;text-align:left;color:var(--text-muted)">${t("report.col.device")}</th>
              <th style="padding:8px;text-align:right;color:var(--text-muted)">${t("report.col.plays")}</th>
              <th style="padding:8px;text-align:right;color:var(--text-muted)">${t("report.col.total_hours")}</th>
            </tr></thead>
            <tbody>
              ${
                summary.by_device
                  .map(
                    (d) => `
                <tr style="border-bottom:1px solid var(--border)">
                  <td style="padding:8px">${d.device_name}</td>
                  <td style="padding:8px;text-align:right">${d.plays}</td>
                  <td style="padding:8px;text-align:right">${(d.total_seconds / 3600).toFixed(1)}</td>
                </tr>
              `,
                  )
                  .join("") ||
                `<tr><td colspan="3" style="padding:16px;text-align:center;color:var(--text-muted)">${t("report.no_data")}</td></tr>`
              }
            </tbody>
          </table>
          </div>
        </div>
      `;

      renderBarChart(
        "dailyChart",
        summary.by_day.map((d) => ({
          label: new Date(d.day).toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
          }),
          value: d.plays,
        })),
      );

      const hourData = Array.from({ length: 24 }, (_, i) => {
        const found = summary.by_hour.find((h) => h.hour === i);
        return {
          label:
            i === 0
              ? "12a"
              : i < 12
                ? i + "a"
                : i === 12
                  ? "12p"
                  : i - 12 + "p",
          value: found?.plays || 0,
        };
      });
      renderBarChart("hourlyChart", hourData);
    } catch (err) {
      content.innerHTML = `<div class="empty-state"><h3>${t("report.error")}</h3><p>${esc(err.message)}</p></div>`;
    }
  }
}

function renderBarChart(containerId, data) {
  const container = document.getElementById(containerId);
  if (!container || !data.length) return;

  const maxVal = Math.max(...data.map((d) => d.value), 1);

  container.innerHTML = data
    .map(
      (d) => `
    <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;min-width:0" title="${d.label}: ${d.value}">
      <div style="font-size:9px;color:var(--text-muted);margin-bottom:2px;display:${d.value > 0 ? "block" : "none"}">${d.value}</div>
      <div style="width:100%;max-width:20px;height:${Math.max(2, (d.value / maxVal) * 160)}px;background:var(--accent);border-radius:2px 2px 0 0;min-height:2px"></div>
      <div style="font-size:8px;color:var(--text-muted);margin-top:4px;transform:rotate(-45deg);white-space:nowrap">${d.label}</div>
    </div>
  `,
    )
    .join("");
}

function formatDuration(seconds) {
  if (!seconds) return "0s";
  if (seconds < 60) return Math.round(seconds) + "s";
  if (seconds < 3600) return Math.round(seconds / 60) + "m";
  return (seconds / 3600).toFixed(1) + "h";
}

export function cleanup() {}
