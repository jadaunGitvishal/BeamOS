'use strict';

// Ask the OS for an unused TCP port on 127.0.0.1 (listen on 0, read it, close).
// Lets spawned-server tests avoid hard-coded ports that collide with each other
// or with a dev server. Same approach as field-auth-hardening.test.js freePort().

const net = require('net');

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

module.exports = { freePort };
