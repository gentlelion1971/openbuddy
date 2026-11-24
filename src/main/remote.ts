// Remote access for the companion phone app.
//
// The desktop app runs a small authenticated HTTP API on the home PC so the
// companion phone app can show the same chat history and receive completion
// notifications. Design decisions (user-approved):
// - Pairing happens ONCE at home: the PC shows a QR code, the phone scans it.
//   The QR carries the PC's LAN address, its Tailscale address (if any) and a
//   one-time pairing code. The user never types a URL or an IP address.
// - After pairing the phone holds a long-lived random token; only a SHA-256
//   hash of the token is stored on the PC. A paired device can be revoked.
// - Away from home the phone reaches the PC over Tailscale (a private mesh
//   network), so no fixed public IP is needed. The home IP is dynamic
//   (Verizon FIOS) and the app never depends on it.
// - All data stays on the home PC. The API serves local data only; there is
//   no cloud relay and no third-party server in the path.
// - The API binds the LAN interface (0.0.0.0) on port 47831. Every endpoint
//   except /api/pair requires a valid Bearer device token.
// All code, comments, log messages and docs in this project are English only.

import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { app as electronApp } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createWriteStream } from 'node:fs';
import QRCode from 'qrcode';
import * as store from './store.js';

export const DEFAULT_REMOTE_PORT = 47831;
export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_BODY_BYTES = 1024 * 1024;

export interface RemoteStatus {
  running: boolean;
  port: number;
  lanIp: string;
  tailscaleIp: string;
  error?: string;
}

export interface PairingInfo {
  code: string;
  qrDataUrl: string;
  expiresAt: string;
  lanIp: string;
  tailscaleIp: string;
  port: number;
}

export interface DeviceInfo {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt: string | null;
}

export interface TailscaleStatus {
  installed: boolean;
  loggedIn: boolean;
  ip: string;
  hostname: string;
  detail: string;
}

type SendHandler = (chatId: string, text: string) => Promise<void>;

let server: http.Server | null = null;
let runningPort = 0;
let serverError = '';
let sendHandler: SendHandler | null = null;
let currentPairing: { code: string; expiresAt: number } | null = null;

const PAIRING_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function newPairingCode(): string {
  const bytes = crypto.randomBytes(8);
  let code = '';
  for (const b of bytes) code += PAIRING_ALPHABET[b % PAIRING_ALPHABET.length];
  return code;
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** First non-internal IPv4 address (the home LAN address). */
export function getLanIp(): string {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return '127.0.0.1';
}

/** Run a command and capture stdout. Rejects with the exit code / spawn error. */
function runCommand(cmd: string, args: string[], timeoutMs = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(stdout);
    });
  });
}

export async function getTailscaleStatus(): Promise<TailscaleStatus> {
  try {
    const out = await runCommand('tailscale', ['status', '--json']);
    const data = JSON.parse(out) as {
      Self?: { TailscaleIPs?: string[]; HostName?: string; Online?: boolean };
      BackendState?: string;
    };
    const self = data.Self;
    if (!self || !self.TailscaleIPs || self.TailscaleIPs.length === 0) {
      return { installed: true, loggedIn: false, ip: '', hostname: '', detail: 'Tailscale is installed but not logged in. Sign in once with your Tailscale account.' };
    }
    return {
      installed: true,
      loggedIn: true,
      ip: self.TailscaleIPs[0],
      hostname: self.HostName ?? '',
      detail: `Connected as ${self.HostName ?? 'this PC'} (${self.TailscaleIPs[0]}).`,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (/ENOENT|not found/i.test(message)) {
      return { installed: false, loggedIn: false, ip: '', hostname: '', detail: 'Tailscale is not installed.' };
    }
    return { installed: true, loggedIn: false, ip: '', hostname: '', detail: `Tailscale is installed but not connected (${message}). Sign in once with your Tailscale account.` };
  }
}

const TAILSCALE_MSI_URL = 'https://pkgs.tailscale.com/stable/tailscale-setup-latest-amd64.msi';

/**
 * Install Tailscale by downloading its MSI straight from Tailscale's own
 * server and running it. Windows only. Deliberately NOT via winget: this
 * app never routes anything through a Microsoft service. The user signs
 * in once afterwards; the app never handles Tailscale credentials itself.
 */
export async function installTailscale(): Promise<string> {
  if (process.platform !== 'win32') {
    throw new Error('Automatic Tailscale install is only supported on Windows. Install Tailscale from tailscale.com/download on this machine.');
  }
  const msiPath = path.join(os.tmpdir(), 'tailscale-setup-latest-amd64.msi');
  const res = await fetch(TAILSCALE_MSI_URL, { redirect: 'follow' });
  if (!res.ok || !res.body) {
    throw new Error(`Could not download the Tailscale installer (HTTP ${res.status}).`);
  }
  await pipeline(
    Readable.fromWeb(res.body as unknown as Parameters<typeof Readable.fromWeb>[0]),
    createWriteStream(msiPath),
  );
  await new Promise<void>((resolve, reject) => {
    // /passive shows progress without questions; elevation comes via UAC.
    const child = spawn('msiexec', ['/i', msiPath, '/passive'], { windowsHide: false });
    child.on('error', (err) => reject(new Error(`Could not start the Tailscale installer: ${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Tailscale install failed (exit ${code}).`));
    });
  });
  return 'Tailscale installed. Open Tailscale from the Start menu and sign in once.';
}

/** Generate a fresh one-time pairing code and a QR code the phone scans. */
export async function generatePairing(port: number): Promise<PairingInfo> {
  const code = newPairingCode();
  currentPairing = { code, expiresAt: Date.now() + PAIRING_CODE_TTL_MS };
  const tailscale = await getTailscaleStatus().catch(() => ({ ip: '' }) as Partial<TailscaleStatus>);
  const lanIp = getLanIp();
  const payload = JSON.stringify({
    v: 1,
    app: 'openbuddy',
    host: lanIp,
    tailscale: tailscale.ip ?? '',
    port,
    code,
  });
  const qrDataUrl = await QRCode.toDataURL(payload, { errorCorrectionLevel: 'M', width: 280 });
  return {
    code,
    qrDataUrl,
    expiresAt: new Date(currentPairing.expiresAt).toISOString(),
    lanIp,
    tailscaleIp: tailscale.ip ?? '',
    port,
  };
}

export function listPairedDevices(): DeviceInfo[] {
  return store.listDevices().map((d) => ({ id: d.id, name: d.name, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt }));
}

export function revokeDevice(id: string): void {
  store.removeDevice(id);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('Request body too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
      } catch {
        reject(new Error('Invalid JSON body.'));
      }
    });
    req.on('error', reject);
  });
}

function authenticate(req: http.IncomingMessage): store.DeviceRow | null {
  const auth = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/.exec(auth);
  if (!match) return null;
  const device = store.findDeviceByTokenHash(hashToken(match[1]));
  if (!device) return null;
  store.touchDevice(device.id);
  return device;
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;

  if (req.method === 'GET' && path === '/api/status') {
    sendJson(res, 200, { ok: true, app: 'openbuddy', version: electronApp.getVersion() });
    return;
  }

  if (req.method === 'POST' && path === '/api/pair') {
    const body = await readBody(req);
    const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
    const deviceName = typeof body.deviceName === 'string' && body.deviceName.trim() ? body.deviceName.trim().slice(0, 80) : 'Phone';
    if (!currentPairing || currentPairing.code !== code || Date.now() > currentPairing.expiresAt) {
      sendJson(res, 403, { ok: false, error: 'Invalid or expired pairing code. Generate a new code on the PC and try again.' });
      return;
    }
    currentPairing = null; // One-time use.
    const token = crypto.randomBytes(32).toString('hex');
    const device = store.addDevice(deviceName, hashToken(token));
    sendJson(res, 200, { ok: true, token, deviceId: device.id });
    return;
  }

  const device = authenticate(req);
  if (!device) {
    sendJson(res, 401, { ok: false, error: 'Unauthorized. Pair this phone first by scanning the QR code on the PC.' });
    return;
  }

  if (req.method === 'GET' && path === '/api/chats') {
    const chats = store.listChats(undefined, false).map((c) => ({
      id: c.id,
      title: c.title,
      projectId: c.projectId,
      updatedAt: c.updatedAt,
    }));
    sendJson(res, 200, { ok: true, chats });
    return;
  }

  const chatMessages = /^\/api\/chats\/([^/]+)\/messages$/.exec(path);
  if (req.method === 'GET' && chatMessages) {
    const messages = store.listMessages(decodeURIComponent(chatMessages[1]), 200).map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      createdAt: m.createdAt,
    }));
    sendJson(res, 200, { ok: true, messages });
    return;
  }

  const chatSend = /^\/api\/chats\/([^/]+)\/send$/.exec(path);
  if (req.method === 'POST' && chatSend) {
    const chatId = decodeURIComponent(chatSend[1]);
    const chat = store.listChats(undefined, true).find((c) => c.id === chatId);
    if (!chat) {
      sendJson(res, 404, { ok: false, error: 'Chat not found.' });
      return;
    }
    const body = await readBody(req);
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) {
      sendJson(res, 400, { ok: false, error: 'Message text is required.' });
      return;
    }
    if (!sendHandler) {
      sendJson(res, 503, { ok: false, error: 'The agent is not ready yet.' });
      return;
    }
    // Fire and forget: the phone polls /api/chats/:id/messages and
    // /api/notifications for the answer and the completion notice.
    void sendHandler(chatId, text).catch((e: unknown) => {
      console.error('[remote] remote send failed:', e instanceof Error ? e.message : String(e));
    });
    sendJson(res, 202, { ok: true, accepted: true });
    return;
  }

  if (req.method === 'GET' && path === '/api/tasks') {
    const tasks = store.listTasks(undefined).map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      dueAt: t.dueAt,
      createdAt: t.createdAt,
    }));
    sendJson(res, 200, { ok: true, tasks });
    return;
  }

  if (req.method === 'GET' && path === '/api/notifications') {
    const notifications = store.listNotifications(false).map((n) => ({
      id: n.id,
      kind: n.kind,
      title: n.title,
      body: n.body,
      chatId: n.chatId,
      createdAt: n.createdAt,
      read: n.read,
    }));
    sendJson(res, 200, { ok: true, notifications });
    return;
  }

  if (req.method === 'POST' && path === '/api/notifications/read') {
    store.markNotificationsRead();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' && path === '/api/memories') {
    const memories = store.listMemories('global').map((m) => ({ key: m.key, value: m.value }));
    sendJson(res, 200, { ok: true, memories });
    return;
  }

  sendJson(res, 404, { ok: false, error: 'Unknown endpoint.' });
}

export function startRemoteServer(port: number, onRemoteSend: SendHandler): Promise<RemoteStatus> {
  return new Promise((resolve) => {
    if (server) {
      resolve({ running: true, port: runningPort, lanIp: getLanIp(), tailscaleIp: '' });
      return;
    }
    sendHandler = onRemoteSend;
    serverError = '';
    server = http.createServer((req, res) => {
      void handleRequest(req, res).catch((e: unknown) => {
        console.error('[remote] request failed:', e instanceof Error ? e.message : String(e));
        if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'Internal error.' });
      });
    });
    server.on('error', (err: NodeJS.ErrnoException) => {
      serverError = err.message;
      server = null;
      resolve({ running: false, port, lanIp: getLanIp(), tailscaleIp: '', error: err.message });
    });
    server.listen(port, '0.0.0.0', () => {
      runningPort = port;
      resolve({ running: true, port, lanIp: getLanIp(), tailscaleIp: '' });
    });
  });
}

export function stopRemoteServer(): void {
  if (server) {
    server.close();
    server = null;
    sendHandler = null;
  }
}

export function getRemoteStatus(): RemoteStatus {
  return {
    running: server !== null,
    port: runningPort || DEFAULT_REMOTE_PORT,
    lanIp: getLanIp(),
    tailscaleIp: '',
    ...(serverError ? { error: serverError } : {}),
  };
}
