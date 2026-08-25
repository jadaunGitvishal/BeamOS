'use strict';

// The merged-in Dashboard bundle's source lives at frontend/dashboard-src,
// outside server/'s own directory tree, but its dependencies (react,
// react-dom, react-router-dom, vite, @vitejs/plugin-react) are deliberately
// kept in server/package.json - ONE dependency tree, one `npm audit`
// surface, not a second node_modules for a handful of packages. Node/Vite's
// bare-import resolution (`import "react"`) walks UP from the importing
// file's own directory though, and frontend/dashboard-src has no node_modules
// ancestor to find - so this creates frontend/dashboard-src/node_modules as
// a link to server/node_modules, making the shared tree resolvable from the
// separate source tree. Idempotent (skips if already linked) and safe to run
// on every build/dev invocation - see package.json's build:dashboard/dev:dashboard.
const fs = require('fs');
const path = require('path');

const target = path.join(__dirname, '..', 'node_modules');
const linkPath = path.join(__dirname, '..', '..', 'frontend', 'dashboard-src', 'node_modules');

if (fs.existsSync(linkPath)) {
  const stat = fs.lstatSync(linkPath);
  if (stat.isSymbolicLink() || stat.isDirectory()) {
    // Already linked (or, on some setups, already a real directory) - nothing to do.
    process.exit(0);
  }
}

try {
  // 'junction' works on Windows without admin/Developer Mode; symlink works
  // everywhere else. fs.symlinkSync's type argument is ignored on POSIX.
  fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  console.log(`[link-dashboard-deps] linked ${linkPath} -> ${target}`);
} catch (err) {
  console.error(`[link-dashboard-deps] failed to link node_modules: ${err.message}`);
  process.exit(1);
}
