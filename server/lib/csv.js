'use strict';

// RFC 4180-style field escaping: only quote-wrap (and double up internal
// quotes) when a field actually needs it, so most cells stay plain text.
function escapeCsvField(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsvRow(values) {
  return values.map(escapeCsvField).join(',');
}

module.exports = { escapeCsvField, toCsvRow };
