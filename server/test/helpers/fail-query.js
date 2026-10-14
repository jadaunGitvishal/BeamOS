'use strict';

// Test-only preload (`node --require test/helpers/fail-query.js server.js`), used by
// fingerprint-reclaim-errors.test.js and dashboard-connect-failure.test.js. Wraps
// db/database's prepare() so the FIRST run(), get() or all() of a statement whose SQL
// contains FAIL_QUERY_SQL AND whose params include FAIL_QUERY_ID rejects with an
// injected error, as a DB failure would. It fires once per process: every later call
// (including retries of the same statement) runs normally.
//
// Prints one "[fail-query] failing <sql> for <id>" line when it fires, so a test can see
// exactly where the failure landed. With either variable unset nothing is wrapped. No
// other statement, and no other behaviour, is touched. Never run as a test itself: the
// runner's explicit file list excludes test/helpers/.

const database = require('../../db/database');

const MATCH = process.env.FAIL_QUERY_SQL;
const ID = process.env.FAIL_QUERY_ID;
const origPrepare = database.db.prepare;
let fired = false;

if (MATCH && ID) {
  database.db.prepare = function prepare(sql) {
    const stmt = origPrepare.call(this, sql);
    if (typeof sql !== 'string' || !sql.includes(MATCH)) return stmt;
    for (const method of ['run', 'get', 'all']) {
      const orig = stmt[method];
      stmt[method] = async function (...params) {
        if (!fired && params.includes(ID)) {
          fired = true;
          console.log(`[fail-query] failing ${MATCH} for ${ID}`);
          throw new Error(`fail-query: injected failure for ${MATCH}`);
        }
        return orig.apply(this, params);
      };
    }
    return stmt;
  };
}
