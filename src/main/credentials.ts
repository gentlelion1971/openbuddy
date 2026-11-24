// Credential storage using Electron safeStorage (DPAPI on Windows).
// Secrets are encrypted by the OS and stored as base64 in the settings table.
// Nothing secret is ever written to a plain file.
// All code, comments, log messages and docs in this project are English only.

import { safeStorage } from 'electron';
import { getSetting, setSetting } from './store.js';

/** Store a secret (password, app password, token) under a key. */
export function setSecret(key: string, value: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS encryption is not available; cannot store credentials safely.');
  }
  const encrypted = safeStorage.encryptString(value);
  setSetting(`secret:${key}`, encrypted.toString('base64'));
}

/** Retrieve a secret stored with setSecret. Returns null when missing. */
export function getSecret(key: string): string | null {
  const stored = getSetting(`secret:${key}`);
  if (!stored) return null;
  try {
    return safeStorage.decryptString(Buffer.from(stored, 'base64'));
  } catch {
    return null;
  }
}

export function deleteSecret(key: string): void {
  setSetting(`secret:${key}`, '');
}

export function isEncryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable();
}
