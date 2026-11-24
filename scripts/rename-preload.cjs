// Electron loads preload scripts as CommonJS, but this project is ESM
// ("type": "module"), so the compiled preload must end in .cjs or Electron
// fails with "Cannot use import statement outside a module" and the whole
// UI stays blank (window.agent is never exposed).
// All code, comments, log messages and docs in this project are English only.
const fs = require('node:fs');
const path = require('node:path');

const from = path.join(__dirname, '..', 'dist', 'preload', 'preload.js');
const to = path.join(__dirname, '..', 'dist', 'preload', 'preload.cjs');
if (fs.existsSync(from)) {
  fs.renameSync(from, to);
  console.log('preload: renamed preload.js -> preload.cjs');
} else if (!fs.existsSync(to)) {
  console.error('preload: dist/preload/preload.js not found; run tsc first.');
  process.exit(1);
}
