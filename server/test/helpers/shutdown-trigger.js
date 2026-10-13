'use strict';

// Test-only preload (`node --require test/helpers/shutdown-trigger.js server.js`), used by
// shutdown-audit-drain.test.js on Windows. There a SIGTERM sent from another process
// can't be caught - Node ends the target at once - so the server's own SIGTERM handler
// would never run. Instead the test creates <DATA_DIR>/shutdown-trigger and this preload,
// polling for it every 25ms, emits 'SIGTERM' on the process: the same listeners a real
// signal reaches. On POSIX the test sends a real SIGTERM and this file just stays unused.
// Never run as a test itself: the runner's explicit file list excludes test/helpers/.

const fs = require('fs');
const path = require('path');

const file = path.join(process.env.DATA_DIR || '.', 'shutdown-trigger');
const timer = setInterval(() => {
  if (!fs.existsSync(file)) return;
  clearInterval(timer);
  console.log('[shutdown-trigger] emitting SIGTERM');
  process.emit('SIGTERM', 'SIGTERM');
}, 25);
timer.unref();
