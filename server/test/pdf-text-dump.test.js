'use strict';

// scripts/pdf-text-dump.js - the PDF text extractor several report-export tests read
// PDFs with. Regression for the CI flake in field-ops-report's PDF-cap test: the old
// extractor trimmed a trailing "\n" AND then a trailing "\r" from each stream and
// silently skipped any stream that failed to inflate. pdfkit writes
// "stream\n" + data + "\nendstream", so a compressed stream whose own last byte is 0x0D
// (~1 in 256 - the last byte of the zlib checksum) lost that byte, failed to inflate,
// and its page's text vanished without an error.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const PDFDocument = require('pdfkit');
const { extractCells } = require('../scripts/pdf-text-dump');

const hex = (s) => Buffer.from(s, 'latin1').toString('hex');
const textOf = (cells) => cells.map((c) => c.str).join(' ');

// A page content stream the way pdfkit writes text: one BT..ET block per cell.
const content = (pad) => `BT\n1 0 0 1 50 700 Tm\n/F1 10 Tf\n[<${hex('cap remark 199')}> 0] TJ\nET\n% ${pad}\n`;

// A minimal PDF with one stream object, laid out exactly like pdfkit's
// ("<< ... >>\nstream\n" + data + "\nendstream\nendobj").
function pdfWithStream(data, { filter = '/FlateDecode', length = data.length } = {}) {
  return Buffer.concat([
    Buffer.from(`%PDF-1.3\n%\xff\xff\xff\xff\n5 0 obj\n<<\n/Length ${length}\n/Filter ${filter}\n>>\nstream\n`, 'latin1'),
    data,
    Buffer.from('\nendstream\nendobj\ntrailer\n<<\n/Size 6\n>>\n%%EOF\n', 'latin1'),
  ]);
}

// The PRE-FIX stream handling, kept here only to show what it lost (not used elsewhere).
function oldExtractCells(file) {
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
    try { inflated = zlib.inflateSync(raw).toString('latin1'); } catch (e) { continue; }
    if (!/Tj|TJ/.test(inflated)) continue;
    const blockRe = /1 0 0 1 ([\d.]+) ([\d.]+) Tm[\s\S]*?\[((?:<[0-9a-fA-F]*>|-?[\d.]+|\s)*)\]\s*TJ/g;
    let b;
    while ((b = blockRe.exec(inflated))) {
      let str = '';
      const hexRe = /<([0-9a-fA-F]*)>/g;
      let h;
      while ((h = hexRe.exec(b[3]))) str += Buffer.from(h[1], 'hex').toString('latin1');
      cells.push({ x: parseFloat(b[1]), y: parseFloat(b[2]), str });
    }
  }
  return cells;
}

const tmpFiles = [];
function writeTmp(buf) {
  const f = path.join(os.tmpdir(), `pdf-text-dump-${crypto.randomBytes(4).toString('hex')}.pdf`);
  fs.writeFileSync(f, buf);
  tmpFiles.push(f);
  return f;
}
test.after(() => { for (const f of tmpFiles) fs.rmSync(f, { force: true }); });

test('a deflate stream whose last byte is 0x0D: the old trim loses the page text, the fixed extractor decodes it', () => {
  // Deterministic search for content whose compressed form ends in 0x0D (~1 in 256).
  // The pad is a hash of the counter: a bare counter changes the zlib checksum too
  // little between tries to hit a given last byte quickly.
  let data;
  for (let n = 0; ; n++) {
    const pad = crypto.createHash('sha256').update(String(n)).digest('hex');
    data = zlib.deflateSync(Buffer.from(content(pad), 'latin1'));
    if (data[data.length - 1] === 0x0d) break;
  }
  assert.equal(data[data.length - 1], 0x0d, 'precondition: the compressed stream ends in 0x0D');
  assert.match(zlib.inflateSync(data).toString('latin1'), /TJ/, 'precondition: the stream itself is valid');
  const file = writeTmp(pdfWithStream(data));

  assert.ok(!textOf(oldExtractCells(file)).includes('cap remark 199'), 'the OLD logic silently loses the text (the CI failure)');
  assert.equal(textOf(extractCells(file)), 'cap remark 199', 'the fixed extractor decodes it');
});

test('a genuinely corrupt FlateDecode stream throws a clear error naming the object (never silently missing text)', () => {
  const data = Buffer.from(zlib.deflateSync(Buffer.from(content('corrupt'), 'latin1')));
  data[Math.floor(data.length / 2)] ^= 0xff;
  data[Math.floor(data.length / 2) + 1] ^= 0xff;
  assert.throws(() => zlib.inflateSync(data), 'precondition: the stream really is corrupt');
  const file = writeTmp(pdfWithStream(data));
  assert.throws(() => extractCells(file), /^Error: pdf-text-dump: object 5 0: FlateDecode stream failed to inflate \(Z_[A-Z_]+: /);
  assert.deepEqual(oldExtractCells(file), [], 'the OLD logic returned no cells and no error');
});

test('a /Length that does not end at "endstream" throws (the stream boundary is never guessed)', () => {
  const data = zlib.deflateSync(Buffer.from(content('length'), 'latin1'));
  const file = writeTmp(pdfWithStream(data, { length: data.length - 3 }));
  assert.throws(() => extractCells(file), /pdf-text-dump: object 5 0: no "endstream" after \/Length \d+ bytes/);
});

test('real pdfkit output: every page\'s text is extracted, in order', async () => {
  const doc = new PDFDocument();
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((r) => doc.on('end', r));
  for (let p = 1; p <= 5; p++) { if (p > 1) doc.addPage(); doc.text(`page ${p} cell`); }
  doc.end();
  await done;
  const file = writeTmp(Buffer.concat(chunks));
  assert.equal(textOf(extractCells(file)), 'page 1 cell page 2 cell page 3 cell page 4 cell page 5 cell');
});
