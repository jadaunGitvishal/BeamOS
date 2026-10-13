'use strict';

// Masking for values that may be recorded (audit rows, logs) but must not be stored in
// full. Pure functions, no I/O.

// A phone number as '***' + its last 3 digits ('+919876543210' -> '***210'). The fixed
// '***' hides the length and the country code; non-digits are ignored. A missing value
// ('' / null / undefined) is 'none'.
function maskPhone(p) {
  return p ? '***' + String(p).replace(/\D/g, '').slice(-3) : 'none';
}

module.exports = { maskPhone };
