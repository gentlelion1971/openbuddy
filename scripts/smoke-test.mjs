// Smoke test for the packaged Linux build (run: npm run test:smoke).
// Launches the unpacked app under Xvfb with a throwaway user-data dir and
// checks three things:
//   1. The process stays alive.
//   2. The phone-access API answers on port 47831 (main process fully up).
//   3. The renderer actually mounts: via Chrome DevTools Protocol the page
//      body must contain visible text (a blank window means the preload or
//      the React app failed — this caught the ESM-preload bug on 2026-11-22).
// Needs xvfb-run and a display-less Linux environment. Exits non-zero on
// any failure. The app is killed at the end either way.
// All code, comments, log messages and docs in this project are English only.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appPath = path.join(root, 'dist-packaged', 'linux-unpacked', 'local-agent-app');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'local-agent-smoke-'));
const profile = path.join(tmp, 'profile');
const logFile = path.join(tmp, 'app.log');
const logFd = fs.openSync(logFile, 'w');

let failures = [];
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

const child = spawn(
  'xvfb-run',
  ['-a', appPath, '--no-sandbox', '--remote-debugging-port=9222', `--user-data-dir=${profile}`],
  { stdio: ['ignore', logFd, logFd] },
);
child.on('error', (e) => {
  console.error('Could not start the app:', e.message);
  process.exit(1);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getPageTarget() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch('http://127.0.0.1:9222/json');
      const targets = await res.json();
      const page = targets.find((t) => t.type === 'page');
      if (page) return page;
    } catch { /* not up yet */ }
    await sleep(1000);
  }
  return null;
}

async function pageText(page) {
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const send = (method, params = {}) => new Promise((resolve) => {
    const mid = ++id;
    pending.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const res = await send('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true });
  ws.close();
  return res.result?.result?.value ?? '';
}

try {
  await sleep(12000);
  check('app process still running', child.exitCode === null);

  let statusOk = false;
  try {
    const res = await fetch('http://127.0.0.1:47831/api/status');
    const body = await res.json();
    statusOk = res.ok && body.ok === true;
  } catch { /* not up */ }
  check('phone-access API answers (main process up)', statusOk);

  const page = await getPageTarget();
  check('renderer page target exists (window opened)', !!page);
  if (page) {
    const text = await pageText(page);
    check('renderer mounted with visible text', text.trim().length > 0, JSON.stringify(text.slice(0, 120)));
  }

  const dbExists = fs.existsSync(path.join(profile, 'local-agent.db'));
  check('SQLite database created in user-data folder', dbExists);
} finally {
  child.kill('SIGTERM');
  await sleep(2000);
  if (child.exitCode === null) child.kill('SIGKILL');
  fs.closeSync(logFd);
  const log = fs.readFileSync(logFile, 'utf8');
  if (/__dirname is not defined|Cannot use import statement outside a module|UnhandledPromiseRejection/.test(log)) {
    check('no fatal errors in app log', false, 'see ' + logFile);
  } else {
    check('no fatal errors in app log', true);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\nSMOKE TEST FAILED: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nSMOKE TEST PASSED');
