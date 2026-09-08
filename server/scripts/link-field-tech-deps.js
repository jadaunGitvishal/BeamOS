'use strict';

// The Field Technician app's source lives at frontend/field-tech-src, outside
// server/'s own directory tree, but its dependencies (react, react-dom, vite,
// @vitejs/plugin-react) are deliberately kept in server/package.json - ONE
// dependency tree, one `npm audit` surface, not a second node_modules for a
// handful of packages. Node/Vite's bare-import resolution (`import "react"`)
// walks UP from the importing file's own directory though, and
// frontend/field-tech-src has no node_modules ancestor to find - so this
// creates frontend/field-tech-src/node_modules as a link to
// server/node_modules, making the shared tree resolvable from the separate
// source tree. Idempotent (skips if already linked) and safe to run on every
// build/dev invocation - see package.json's build:field-tech/dev:field-tech.
//
// Exact sibling of scripts/link-dashboard-deps.js (kept as a separate file
// rather than parameterizing that one, so the dashboard build's script stays
// untouched).
const fs = require('fs');
const path = require('path');

const target = path.join(__dirname, '..', 'node_modules');
const linkPath = path.join(__dirname, '..', '..', 'frontend', 'field-tech-src', 'node_modules');

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
  console.log(`[link-field-tech-deps] linked ${linkPath} -> ${target}`);
} catch (err) {
  console.error(`[link-field-tech-deps] failed to link node_modules: ${err.message}`);
  process.exit(1);
}
