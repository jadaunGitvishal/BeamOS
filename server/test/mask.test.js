'use strict';

// lib/mask.js maskPhone: '***' + the last 3 digits, 'none' for a missing value.
// Pure unit tests, no database.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { maskPhone } = require('../lib/mask');

test('an E.164 number keeps only its last 3 digits', () => {
  assert.equal(maskPhone('+919876543210'), '***210');
  assert.equal(maskPhone('+447700900123'), '***123');
});

test('non-digits are ignored (the same number in any format masks the same)', () => {
  assert.equal(maskPhone('919876543210'), '***210');
  assert.equal(maskPhone('+91 98765-43 210'), '***210');
  assert.equal(maskPhone('(987) 654-3210'), '***210');
  assert.equal(maskPhone(9876543210), '***210');
});

test('short values keep what digits there are; no digits leaves just the prefix', () => {
  assert.equal(maskPhone('12'), '***12');
  assert.equal(maskPhone('7'), '***7');
  assert.equal(maskPhone('abc'), '***');
  assert.equal(maskPhone('+'), '***');
});

test('a missing value is "none"', () => {
  assert.equal(maskPhone(''), 'none');
  assert.equal(maskPhone(null), 'none');
  assert.equal(maskPhone(undefined), 'none');
});

test('the result never carries more than 3 digits', () => {
  for (const p of ['+919876543210', '0012345678901234567890', '+1 (555) 010-9999']) {
    const digits = maskPhone(p).replace(/\D/g, '');
    assert.ok(digits.length <= 3, `${maskPhone(p)} has at most 3 digits`);
    assert.ok(maskPhone(p).startsWith('***'));
  }
});
