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
//
// Streams are located by walking the PDF's objects and reading exactly /Length
// bytes after `stream`. An earlier version found them by searching for
// "stream\n" ... "endstream", trimmed a trailing "\n" AND then a trailing "\r",
// and silently skipped any stream that failed to inflate. pdfkit writes
// "stream\n" + data + "\nendstream", so when the compressed data's own last byte
// was 0x0D (~1 in 256 streams - it is the last byte of the zlib checksum) that
// second trim cut real data, inflate failed, and the whole page's text vanished
// without an error (field-ops-report's PDF-cap test failed in CI that way). Now
// a stream that cannot be decoded throws, naming the object.
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

// Index just past the `>>` closing the dictionary that opens at text[i] ('<<'),
// skipping literal strings `( ... )` and hex strings `< ... >`; -1 if unterminated.
function dictEnd(text, i) {
  let depth = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '(') {                       // literal string: nested parens, backslash escapes
      let nest = 0;
      for (; i < text.length; i++) {
        if (text[i] === '\\') { i++; continue; }
        if (text[i] === '(') nest++;
        else if (text[i] === ')' && --nest === 0) break;
      }
      i++;
    } else if (c === '<' && text[i + 1] === '<') { depth++; i += 2; }
    else if (c === '>' && text[i + 1] === '>') { depth--; i += 2; if (depth === 0) return i; }
    else if (c === '<') { const j = text.indexOf('>', i); if (j === -1) return -1; i = j + 1; }
    else i++;
  }
  return -1;
}

// Every stream in the file, in document order: { obj: 'N G', dict, data }, where
// data is exactly the /Length bytes after `stream` + EOL.
function readStreams(buf) {
  const text = buf.toString('latin1');   // 1 char per byte, so indices are byte offsets
  const objRe = /(\d+) (\d+) obj\b/g;
  const streams = [];
  let m;
  while ((m = objRe.exec(text))) {
    const obj = `${m[1]} ${m[2]}`;
    let i = m.index + m[0].length;
    while (/\s/.test(text[i] || '')) i++;
    if (!text.startsWith('<<', i)) continue;
    const dEnd = dictEnd(text, i);
    if (dEnd === -1) throw new Error(`pdf-text-dump: object ${obj}: unterminated dictionary`);
    const after = /^\s*stream(\r\n|\n)/.exec(text.slice(dEnd, dEnd + 16));
    if (!after) { objRe.lastIndex = dEnd; continue; }   // not a stream object
    const dict = text.slice(i, dEnd);
    const len = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
    if (!len) throw new Error(`pdf-text-dump: object ${obj}: stream without a direct /Length`);
    const start = dEnd + after[0].length;
    const end = start + Number(len[1]);
    if (!/^(\r\n|\n|\r)?endstream/.test(text.slice(end, end + 12))) {
      throw new Error(`pdf-text-dump: object ${obj}: no "endstream" after /Length ${len[1]} bytes`);
    }
    streams.push({ obj, dict, data: buf.slice(start, end) });
    objRe.lastIndex = end;
  }
  return streams;
}

function extractCells(file) {
  const buf = fs.readFileSync(file);
  const cells = [];
  for (const { obj, dict, data } of readStreams(buf)) {
    let inflated;
    if (/\/Filter\s*\/FlateDecode\b/.test(dict)) {
      try {
        inflated = zlib.inflateSync(data).toString('latin1');
      } catch (e) {
        throw new Error(`pdf-text-dump: object ${obj}: FlateDecode stream failed to inflate (${e.code || 'error'}: ${e.message})`);
      }
    } else if (!/\/Filter\b/.test(dict)) {
      inflated = data.toString('latin1');   // unfiltered stream
    } else {
      continue;                             // other filters (e.g. DCTDecode images) carry no text
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

module.exports = { extractCells, dumpGrid, readStreams };
