'use strict';

// lib/test-db-guard.js: the test-database name rule and the refusal cases of
// assertSafeTestDb. Pure - no DB, no server.

const test = require('node:test');
const assert = require('node:assert/strict');
const { isAllowedTestDbName, assertSafeTestDb } = require('../lib/test-db-guard');

test('name rule: exactly beamos_test, or beamos_test_ prefix', () => {
  assert.equal(isAllowedTestDbName('beamos_test'), true);
  assert.equal(isAllowedTestDbName('beamos_test_x'), true);
  assert.equal(isAllowedTestDbName('beamos_test_audit_prune_1a2b3c4d'), true);
  for (const bad of ['beamos', 'beamos_tests', 'foo_test', 'beamos_testx', '', 'BEAMOS_TEST', ' beamos_test', undefined, null]) {
    assert.equal(isAllowedTestDbName(bad), false, `must refuse ${JSON.stringify(bad)}`);
  }
});

function withTestUser(value, fn) {
  const saved = process.env.MYSQL_TEST_USER;
  if (value === undefined) delete process.env.MYSQL_TEST_USER;
  else process.env.MYSQL_TEST_USER = value;
  try { fn(); } finally {
    if (saved === undefined) delete process.env.MYSQL_TEST_USER;
    else process.env.MYSQL_TEST_USER = saved;
  }
}

test('assertSafeTestDb refuses when MYSQL_TEST_USER is unset', () => {
  withTestUser(undefined, () => {
    assert.throws(() => assertSafeTestDb({ database: 'beamos_test', user: 'beamos_test_user' }), /MYSQL_TEST_USER is not set/);
  });
});

test('assertSafeTestDb refuses a user other than MYSQL_TEST_USER', () => {
  withTestUser('guard_test_user', () => {
    assert.throws(() => assertSafeTestDb({ database: 'beamos_test', user: 'beamos_user' }), /refusing to connect as "beamos_user"/);
  });
});

test('assertSafeTestDb refuses a database name that breaks the rule', () => {
  withTestUser('guard_test_user', () => {
    for (const database of ['beamos', 'foo_test', 'beamos_testx']) {
      assert.throws(() => assertSafeTestDb({ database, user: 'guard_test_user' }), /refusing to use database/);
    }
    assert.doesNotThrow(() => assertSafeTestDb({ database: 'beamos_test', user: 'guard_test_user' }));
    assert.doesNotThrow(() => assertSafeTestDb({ database: 'beamos_test_scratch', user: 'guard_test_user' }));
  });
});
