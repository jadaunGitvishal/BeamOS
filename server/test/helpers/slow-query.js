'use strict';

// Test-only preload (`node --require test/helpers/slow-query.js server.js`), used by
// audit-in-tx-first-user.test.js. Wraps db/database's prepare() so every run(), get() or
// all() of a statement whose SQL is EXACTLY SLOW_QUERY_SQL waits SLOW_QUERY_MS (default
// 300) ms before it runs - widening a check-then-act window so a race test can hit it
// every time instead of by luck. Statements run on a transaction handle (tx.prepare) are
// never touched. Prints one "[slow-query] delaying <ms>ms" line per delayed call. With
// SLOW_QUERY_SQL unset nothing is wrapped. Never run as a test itself: the runner's
// explicit file list excludes test/helpers/.

const database = require('../../db/database');

const SQL = process.env.SLOW_QUERY_SQL;
const MS = parseInt(process.env.SLOW_QUERY_MS, 10) || 300;

if (SQL) {
  const origPrepare = database.db.prepare;
  database.db.prepare = function prepare(sql) {
    const stmt = origPrepare.call(this, sql);
    if (sql !== SQL) return stmt;
    for (const method of ['run', 'get', 'all']) {
      const orig = stmt[method];
      stmt[method] = async function (...params) {
        console.log(`[slow-query] delaying ${MS}ms`);
        await new Promise((r) => setTimeout(r, MS));
        return orig.apply(this, params);
      };
    }
    return stmt;
  };
}
