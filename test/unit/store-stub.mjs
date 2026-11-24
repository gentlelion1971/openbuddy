// In-memory stand-in for src/main/store.ts: settings plus a temp data dir.
// Only the settings/data-dir surface the unit-tested modules use is faked.
// All code, comments, log messages and docs in this project are English only.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const settings = new Map();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuddy-unit-test-'));

export function getSetting(key, fallback = '') {
  return settings.has(key) ? settings.get(key) : fallback;
}

export function setSetting(key, value) {
  settings.set(key, value);
}

export function getDataDir() {
  return dataDir;
}

export function __resetStore() {
  settings.clear();
}

export function __dataDir() {
  return dataDir;
}
