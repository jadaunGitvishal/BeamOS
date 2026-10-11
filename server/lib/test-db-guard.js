'use strict';

// Test-run safety guard: tests may only touch a dedicated test database, as the
// restricted test account. db/database.js calls assertSafeTestDb() before creating
// its pool whenever it is loaded under `node --test` (NODE_TEST_CONTEXT is set in
// every test-file process and inherited by servers those tests spawn); the test
// files that open their own connections call it too. scripts/run-tests.js applies
// the same name rule before it resets the test database.
//
// Allowed database names: exactly `beamos_test`, or starting with `beamos_test_`.

function isAllowedTestDbName(name) {
  return typeof name === 'string' && (name === 'beamos_test' || name.startsWith('beamos_test_'));
}

function assertSafeTestDb({ database, user }) {
  const testUser = process.env.MYSQL_TEST_USER;
  if (!testUser) {
    throw new Error('[test-db-guard] refusing to connect: MYSQL_TEST_USER is not set. Run tests via `npm test` (scripts/run-tests.js).');
  }
  if (user !== testUser) {
    throw new Error(`[test-db-guard] refusing to connect as "${user}": tests must connect as the test account MYSQL_TEST_USER ("${testUser}"). Run tests via \`npm test\` (scripts/run-tests.js).`);
  }
  if (!isAllowedTestDbName(database)) {
    throw new Error(`[test-db-guard] refusing to use database "${database}": test databases must be named "beamos_test" or start with "beamos_test_". Run tests via \`npm test\` (scripts/run-tests.js).`);
  }
}

module.exports = { isAllowedTestDbName, assertSafeTestDb };
