'use strict';

const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');

// Renders a single-sheet workbook and returns it as a Buffer.
// headers: string[]; rows: array of arrays (same order as headers).
async function renderXlsx(sheetName, headers, rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName);

  sheet.addRow(headers);
  sheet.getRow(1).font = { bold: true };
  rows.forEach((row) => sheet.addRow(row));

  sheet.columns.forEach((column) => {
    let maxLength = 10;
    column.eachCell({ includeEmpty: true }, (cell) => {
      const len = cell.value === null || cell.value === undefined ? 0 : String(cell.value).length;
      if (len > maxLength) maxLength = len;
    });
    column.width = Math.min(maxLength + 2, 40);
  });

  return workbook.xlsx.writeBuffer();
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// Derives real point-width columns from the actual header/data content
// instead of hand-tuned guesses, using pdfkit's own font metrics rather than
// a character-count proxy (character count doesn't map linearly to page
// width once you're comparing e.g. a narrow "Uptime" column against a wide
// Wi-Fi SSID column - a naive count let two independently-under-cap outlier
// columns jointly starve every short column down to 1-3 unreadable
// characters). Two clamps keep this from going degenerate:
//   - a column never drops below max(header width, median row-value width),
//     so a column every row actually needs (e.g. a fixed-format timestamp)
//     can't be shrunk away just because a single outlier row elsewhere on
//     the page is expensive. A column whose width is itself outlier-driven
//     keeps a low median even though its max is huge, so it stays eligible
//     to be the one sacrificed under space pressure.
//   - a column is capped at `maxShare` of the usable width, so one
//     pathologically long value can't claim the whole page
// After flooring and capping, remaining width is a genuine flex layout
// problem (like CSS flexbox): if the floored/capped columns still don't
// fit, shrink proportionally to each column's slack above its floor (never
// below it); if they leave the page under-filled, hand the leftover back
// out proportionally to current width.
function autoColumnWidths(doc, headers, rows, usableWidth, { padding = 8, maxShare = 0.38 } = {}) {
  const headerWidths = headers.map((h) => {
    doc.font('Helvetica-Bold').fontSize(8);
    return doc.widthOfString(String(h)) + padding;
  });
  const rowWidthsByCol = headers.map(() => []);
  headers.forEach((h, i) => {
    doc.font('Helvetica').fontSize(8);
    for (const row of rows) {
      const v = row[i];
      if (v === null || v === undefined || v === '') continue;
      rowWidthsByCol[i].push(doc.widthOfString(String(v)) + padding);
    }
  });
  const naturalWidths = headerWidths.map((hw, i) => Math.max(hw, ...rowWidthsByCol[i]));
  const floors = headerWidths.map((hw, i) => Math.max(hw, median(rowWidthsByCol[i])));

  const cap = usableWidth * maxShare;
  // Floor (header-fit or, if larger, typical-row-fit) is inviolable; the cap
  // is a soft safety net, so floor wins if the two ever conflict.
  let widths = naturalWidths.map((w, i) => Math.max(floors[i], Math.min(w, cap)));

  const total = widths.reduce((a, b) => a + b, 0);
  if (total > usableWidth) {
    const excess = total - usableWidth;
    const slack = widths.map((w, i) => w - floors[i]);
    const totalSlack = slack.reduce((a, b) => a + b, 0);
    if (totalSlack > 0) {
      widths = widths.map((w, i) => w - excess * (slack[i] / totalSlack));
    }
    // else: every column is already at its floor and it still doesn't fit -
    // too many columns for the page. Nothing left to give up without
    // breaking the floor guarantee; leave as-is and let the page run
    // slightly wide rather than clip below it.
  } else if (total < usableWidth) {
    const slackToDistribute = usableWidth - total;
    widths = widths.map((w) => w + slackToDistribute * (w / total));
  }

  return widths;
}

const PDF_FOOTER_NOTE = 'For complete, untruncated data, export as CSV or XLSX.';

// Renders a simple tabular PDF (title + header row + data rows) and
// returns it as a Buffer. Column widths auto-fit to content by default
// (see autoColumnWidths, computed from real font metrics); pass
// `columnWidths` (relative weights, same length as `headers`) to override
// with an explicit proportional layout instead.
function renderPdf(title, headers, rows, { columnWidths } = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 36, size: 'A4', layout: 'landscape' });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(16).font('Helvetica-Bold').text(title, { align: 'left' });
    doc.moveDown(0.5);

    const startX = doc.page.margins.left;
    const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    let colWidths;
    if (columnWidths) {
      const weightSum = columnWidths.reduce((a, b) => a + b, 0);
      colWidths = columnWidths.map((w) => (w / weightSum) * usableWidth);
    } else {
      colWidths = autoColumnWidths(doc, headers, rows, usableWidth);
    }
    const colX = colWidths.reduce((acc, w, i) => {
      acc.push(i === 0 ? startX : acc[i - 1] + colWidths[i - 1]);
      return acc;
    }, []);
    const rowHeight = 18;
    const bottomLimit = doc.page.height - doc.page.margins.bottom;

    function drawRow(values, y, bold) {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8);
      values.forEach((value, i) => {
        doc.text(value === null || value === undefined ? '' : String(value), colX[i], y, {
          width: colWidths[i] - 4,
          // height caps this to a single line so pdfkit truncates with an
          // ellipsis instead of wrapping - without it, `ellipsis` is a no-op
          // and overflow text wraps onto extra lines that overlap the next
          // fixed-height row.
          height: rowHeight - 6,
          ellipsis: true,
        });
      });
    }

    let y = doc.y;
    drawRow(headers, y, true);
    y += rowHeight;
    doc
      .moveTo(startX, y - 4)
      .lineTo(startX + usableWidth, y - 4)
      .strokeColor('#cccccc')
      .stroke();

    rows.forEach((row) => {
      if (y + rowHeight > bottomLimit) {
        doc.addPage();
        y = doc.page.margins.top;
        drawRow(headers, y, true);
        y += rowHeight;
      }
      drawRow(row, y, false);
      y += rowHeight;
    });

    // Footer note sits inside the bottom margin (below bottomLimit, the area
    // the table itself is kept out of). pdfkit's text() auto-paginates any
    // draw whose y falls past page.height - margins.bottom, which this one
    // deliberately does - so the bottom margin is dropped to 0 for just this
    // call, otherwise it silently spills onto a new, otherwise-blank page.
    const footerY = doc.page.height - doc.page.margins.bottom + 8;
    const savedBottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc
      .font('Helvetica')
      .fontSize(7)
      .fillColor('#999999')
      .text(PDF_FOOTER_NOTE, startX, footerY, { width: usableWidth, align: 'left' })
      .fillColor('black');
    doc.page.margins.bottom = savedBottomMargin;

    doc.end();
  });
}

module.exports = { renderXlsx, renderPdf };
