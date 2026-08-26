'use strict';
// Dev utility: dumps the text grid out of a pdfkit-generated PDF for manual
// verification of table exports (report-export.js). Not wired into the app
// or the test suite - run directly: `node scripts/pdf-text-dump.js <file.pdf>`.
//
// pdfkit encodes text as WinAnsi hex strings inside Tj/TJ operators, one
// BT..ET block per doc.text() call, each preceded by a `1 0 0 1 <x> <y> Tm`
// that sets its position. This walks the inflated content stream in
// document order, decodes each string, and groups cells into rows by y
// position / columns by x position (using the header row's x positions as
// column boundaries).
//
// The WinAnsi high-byte map below matters more than it looks: pdfkit's
// `ellipsis: true` truncation marker is WinAnsi 0x85, which is NOT the same
// code point as Unicode's 0x85 (NEL, an invisible control character). An
// earlier version of this script passed high bytes through as raw Latin-1
// code points and silently rendered every truncated cell's ellipsis as
// nothing - so truncated cells looked like clean, complete text and a real
// truncation bug went unnoticed. Always decode through this map, not a
// direct byte->charCode pass-through.
const fs = require('fs');
const zlib = require('zlib');

const WINANSI_HIGH = {
  0x85: '…', // ellipsis - the pdfkit truncation marker
  0x91: '‘', 0x92: '’',
  0x93: '“', 0x94: '”',
  0x96: '–', 0x97: '—',
};

function hexToWinAnsiString(hex) {
  const bytes = Buffer.from(hex, 'hex');
  let out = '';
  for (const b of bytes) {
    out += WINANSI_HIGH[b] || String.fromCharCode(b);
  }
  return out;
}

function extractCells(file) {
  const buf = fs.readFileSync(file);
  const text = buf.toString('latin1');
  const streamRe = /stream\r?\n/g;
  let m;
  const cells = [];
  while ((m = streamRe.exec(text))) {
    const start = m.index + m[0].length;
    const end = text.indexOf('endstream', start);
    if (end === -1) continue;
    let raw = buf.slice(start, end);
    if (raw[raw.length - 1] === 0x0a) raw = raw.slice(0, -1);
    if (raw[raw.length - 1] === 0x0d) raw = raw.slice(0, -1);
    let inflated;
    try {
      inflated = zlib.inflateSync(raw).toString('latin1');
    } catch (e) {
      continue;
    }
    if (!/Tj|TJ/.test(inflated)) continue;

    const blockRe = /1 0 0 1 ([\d.]+) ([\d.]+) Tm[\s\S]*?\[((?:<[0-9a-fA-F]*>|-?[\d.]+|\s)*)\]\s*TJ/g;
    let b;
    while ((b = blockRe.exec(inflated))) {
      const x = parseFloat(b[1]);
      const y = parseFloat(b[2]);
      const arr = b[3];
      const hexRe = /<([0-9a-fA-F]*)>/g;
      let h;
      let str = '';
      while ((h = hexRe.exec(arr))) str += hexToWinAnsiString(h[1]);
      cells.push({ x, y, str });
    }
  }
  return cells;
}

function dumpGrid(file) {
  const cells = extractCells(file);

  const rows = new Map();
  for (const c of cells) {
    const key = c.y.toFixed(1);
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key).push(c);
  }
  const sortedYs = [...rows.keys()].sort((a, b) => parseFloat(b) - parseFloat(a));

  // First non-title row is the header - use its cell x-positions as column boundaries.
  const headerRowKey = sortedYs[1];
  const headerCells = (rows.get(headerRowKey) || []).sort((a, b) => a.x - b.x);
  const headers = headerCells.map((c) => c.str);
  const boundaries = headerCells.map((c) => c.x);

  function colIndexForX(x) {
    let idx = 0;
    for (let i = 0; i < boundaries.length; i++) {
      if (x >= boundaries[i] - 2) idx = i;
    }
    return idx;
  }

  console.log(`--- ${file} (${sortedYs.length} text rows, ${cells.length} cells) ---`);
  console.log('Headers:', headers.join(' | '));
  console.log('');

  for (let r = 1; r < sortedYs.length; r++) {
    const y = sortedYs[r];
    const rowCells = rows.get(y).sort((a, b) => a.x - b.x);
    const byCol = new Array(headers.length).fill('');
    for (const c of rowCells) {
      const idx = colIndexForX(c.x);
      byCol[idx] = c.str;
    }
    const label = r === 1 ? 'HEADER' : `row ${r - 1}`;
    console.log(`[${label}] y=${y}`);
    byCol.forEach((val, i) => {
      const truncated = val.includes('…');
      console.log(`    ${headers[i] || '(col ' + i + ')'}: ${JSON.stringify(val)}${truncated ? '   <-- TRUNCATED' : ''}`);
    });
    console.log('');
  }
}

if (require.main === module) {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node scripts/pdf-text-dump.js <file.pdf>');
    process.exit(1);
  }
  dumpGrid(file);
}

module.exports = { extractCells, dumpGrid };
