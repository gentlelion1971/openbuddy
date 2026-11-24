// Electron main process: window, IPC, tool registry, agent chat flow,
// confirmation queue, scheduler and voice sidecar.
// All code, comments, log messages and docs in this project are English only.

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ESM has no __dirname; derive it from the module URL.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import * as store from './store.js';
import { getSecret, isEncryptionAvailable, setSecret } from './credentials.js';
import {
  DEFAULT_MODEL,
  checkOllama,
  checkVoice,
  getSetupStatus,
  installOcrData,
  installOllama,
  installVoice,
  pullModel,
  waitForOllama,
} from './setup.js';
import { listOllamaModels } from './ollama.js';
import {
  REMOTE_PRESETS,
  addLocalModel,
  addRemoteModel,
  getModelRegistry,
  getSelectedModelId,
  hasRemoteApiKey,
  removeModel,
  resolveSelectedModel,
  selectModel,
  setRemoteApiKey,
  updateRemoteModel,
} from './models.js';
import { buildSystemPrompt, runAgentTurn } from './agent.js';
import { VoiceSidecar } from './voice.js';
import { Scheduler } from './scheduler.js';
import { cleanupAttachments } from './tools/attachments.js';
import { terminateOcr } from './tools/ocr.js';
import type { ConfirmationRequest, ToolDefinition } from './tools/types.js';
import { DEFAULT_PROJECT_PERMISSIONS, MAIN_CHAT_PERMISSIONS } from './tools/types.js';
import { builtinTools } from './tools/builtin.js';
import { calendarTools } from './tools/calendar.js';
import { emailService, emailTools } from './tools/email.js';
import { browserTools } from './tools/browser.js';
import { filesTools } from './tools/files.js';
import {
  DEFAULT_REMOTE_PORT,
  generatePairing,
  getRemoteStatus,
  getTailscaleStatus,
  installTailscale,
  listPairedDevices,
  revokeDevice,
  startRemoteServer,
  stopRemoteServer,
} from './remote.js';

let mainWindow: BrowserWindow | null = null;
let scheduler: Scheduler | null = null;
const voiceSidecar = new VoiceSidecar();
const pendingConfirmations = new Map<string, (approved: boolean) => void>();
const abortControllers = new Map<string, AbortController>();

const ALL_TOOLS: ToolDefinition[] = [
  ...builtinTools,
  ...emailTools,
  ...calendarTools,
  ...browserTools,
  ...filesTools,
];

function dataDir(): string {
  return app.getPath('userData');
}

function sendToRenderer(channel: string, ...args: unknown[]): void {
  mainWindow?.webContents.send(channel, ...args);
}

function requestConfirmation(req: ConfirmationRequest): Promise<boolean> {
  return new Promise((resolve) => {
    pendingConfirmations.set(req.id, resolve);
    sendToRenderer('agent:confirm', req);
    // Auto-deny after 5 minutes without an answer.
    setTimeout(() => {
      if (pendingConfirmations.has(req.id)) {
        pendingConfirmations.delete(req.id);
        resolve(false);
      }
    }, 5 * 60_000);
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  }
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function registerIpc(): void {
  // App
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('app:open-data-folder', async () => {
    await shell.openPath(dataDir());
  });

  // Setup wizard
  ipcMain.handle('setup:get-status', async () => getSetupStatus(store.getSetting('setupComplete') === 'true'));
  ipcMain.handle('setup:install-ollama', async () =>
    installOllama((p) => sendToRenderer('setup:progress', p)),
  );
  ipcMain.handle('setup:wait-ollama', async () => waitForOllama());
  ipcMain.handle('setup:pull-model', async (_e, model: string) =>
    pullModel(model, (p) => sendToRenderer('setup:progress', p)),
  );
  ipcMain.handle('setup:install-voice', async () =>
    installVoice((p) => sendToRenderer('setup:progress', p)),
  );
  ipcMain.handle('setup:install-ocr', async () =>
    installOcrData((p) => sendToRenderer('setup:progress', p)),
  );
  ipcMain.handle('attachments:cleanup-now', async () => cleanupAttachments());
  ipcMain.handle('setup:complete', async () => {
    store.setSetting('setupComplete', 'true');
  });

  // Chats
  ipcMain.handle('chat:list', (_e, projectId: string | null) => store.listChats(projectId));
  ipcMain.handle('chat:create', (_e, title: string, projectId: string | null) => store.createChat(title, projectId));
  ipcMain.handle('chat:rename', (_e, id: string, title: string) => store.renameChat(id, title));
  ipcMain.handle('chat:archive', (_e, id: string, archived: boolean) => store.archiveChat(id, archived));
  ipcMain.handle('chat:delete', (_e, id: string) => store.deleteChat(id));
  ipcMain.handle('chat:messages', (_e, chatId: string) => store.listMessages(chatId));
  ipcMain.handle('chat:stop', (_e, chatId: string) => {
    abortControllers.get(chatId)?.abort();
  });
  ipcMain.handle('chat:send', async (_e, chatId: string, text: string) => {
    await handleChatSend(chatId, text);
  });

  // Agent confirmations
  ipcMain.handle('agent:confirm', (_e, id: string, approved: boolean) => {
    const resolve = pendingConfirmations.get(id);
    if (resolve) {
      pendingConfirmations.delete(id);
      resolve(approved);
    }
  });

  // Projects
  ipcMain.handle('projects:list', () => store.listProjects());
  ipcMain.handle('projects:create', (_e, name: string, folderPath: string) =>
    store.createProject(name, folderPath, DEFAULT_PROJECT_PERMISSIONS),
  );
  ipcMain.handle('projects:update', (_e, id: string, patch: Record<string, unknown>) => {
    const p = patch as Partial<Parameters<typeof store.updateProject>[1]>;
    store.updateProject(id, p);
  });
  ipcMain.handle('projects:delete', (_e, id: string) => store.deleteProject(id));

  // Memories
  ipcMain.handle('memories:list', (_e, scope: 'global' | 'project', projectId: string | null) =>
    store.listMemories(scope, projectId),
  );
  ipcMain.handle('memories:set', (_e, scope: 'global' | 'project', projectId: string | null, key: string, value: string) =>
    store.setMemory(scope, projectId, key, value),
  );
  ipcMain.handle('memories:delete', (_e, id: string) => store.deleteMemory(id));

  // Tasks
  ipcMain.handle('tasks:list', (_e, projectId: string | null) => store.listTasks(projectId));
  ipcMain.handle('tasks:create', (_e, title: string, projectId: string | null, dueAt: string | null) =>
    store.createTask(title, projectId, dueAt),
  );
  ipcMain.handle('tasks:set-status', (_e, id: string, status: 'open' | 'done') => store.setTaskStatus(id, status));

  // Email
  ipcMain.handle('email:accounts', () =>
    store.listAccounts().map((a) => ({ id: a.id, label: a.label, kind: a.kind, username: a.username })),
  );
  ipcMain.handle('email:add-account', async (_e, account: Record<string, unknown>, password: string) => {
    const credentialKey = `cred-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const row = store.addAccount({
      label: String(account.label ?? 'Email'),
      kind: (account.kind as 'imap' | 'smtp' | 'graph') ?? 'imap',
      host: String(account.host ?? ''),
      port: Number(account.port ?? 993),
      secure: Number(account.secure ?? 1),
      username: String(account.username ?? ''),
      credentialKey,
    });
    setSecret(credentialKey, password);
    return { id: row.id, label: row.label, kind: row.kind, username: row.username };
  });
  ipcMain.handle('email:remove-account', (_e, id: string) => {
    const row = store.listAccounts().find((a) => a.id === id);
    if (row) {
      try {
        setSecret(row.credentialKey, '');
      } catch {
        // Ignore secret cleanup errors.
      }
    }
    store.deleteAccount(id);
  });
  ipcMain.handle('email:inbox', (_e, accountId: string, limit: number) => emailService.listInbox(accountId, limit));
  ipcMain.handle('email:search', (_e, accountId: string, query: string) => emailService.searchInbox(accountId, query));
  ipcMain.handle('email:read', (_e, accountId: string, uid: number) => emailService.getMessage(accountId, uid));
  ipcMain.handle('email:send', (_e, accountId: string, draft: Record<string, unknown>) =>
    emailService.sendMessage(accountId, draft as { to: string; subject: string; body: string; cc?: string }),
  );
  ipcMain.handle('email:digest', async (_e, accountId: string) => (await emailService.getDigest(accountId)).digest);

  // Calendar & reminders
  ipcMain.handle('calendar:events', (_e, fromIso: string, toIso: string) => store.listEvents(fromIso, toIso));
  ipcMain.handle('calendar:add', (_e, event: Record<string, unknown>) =>
    store.addEvent({
      title: String(event.title ?? 'Untitled'),
      startAt: String(event.startAt ?? ''),
      endAt: String(event.endAt ?? ''),
      location: String(event.location ?? ''),
      notes: String(event.notes ?? ''),
      source: 'local',
    }),
  );
  ipcMain.handle('calendar:delete', (_e, id: string) => store.deleteEvent(id));
  ipcMain.handle('reminders:list', () => store.listReminders(false));
  ipcMain.handle('reminders:add', (_e, title: string, remindAt: string) => store.addReminder(title, remindAt));
  ipcMain.handle('reminders:complete', (_e, id: string) => store.completeReminder(id));

  // Watches
  ipcMain.handle('watches:list', () => store.listWatches());
  ipcMain.handle('watches:create', (_e, name: string, kind: string, config: Record<string, unknown>) =>
    store.createWatch(name, kind as 'email' | 'web', config),
  );
  ipcMain.handle('watches:delete', (_e, id: string) => store.deleteWatch(id));
  ipcMain.handle('watches:set-active', (_e, id: string, active: boolean) => store.setWatchActive(id, active));

  // Settings
  ipcMain.handle('settings:get', (_e, key: string, fallback: string) => store.getSetting(key, fallback));
  ipcMain.handle('settings:set', (_e, key: string, value: string) => store.setSetting(key, value));
  ipcMain.handle('settings:set-secret', (_e, key: string, value: string) => setSecret(key, value));
  ipcMain.handle('settings:models', async () => {
    try {
      return await listOllamaModels();
    } catch {
      return [];
    }
  });
  ipcMain.handle('settings:ollama-status', async () => checkOllama());

  // Models (Settings → Models): manual selection of local (Ollama) or remote
  // (OpenAI-compatible) models. Remote API keys are encrypted, never plain.
  ipcMain.handle('models:list', () => ({
    entries: getModelRegistry(),
    selectedId: getSelectedModelId(),
    presets: REMOTE_PRESETS,
  }));
  ipcMain.handle('models:select', (_e, id: string) => selectModel(id));
  ipcMain.handle('models:add-local', (_e, tag: string) => addLocalModel(tag));
  ipcMain.handle(
    'models:add-remote',
    (_e, input: { label: string; preset: string; baseUrl: string; modelName: string }) => addRemoteModel(input),
  );
  ipcMain.handle(
    'models:update-remote',
    (_e, id: string, patch: { label?: string; baseUrl?: string; modelName?: string }) => updateRemoteModel(id, patch),
  );
  ipcMain.handle('models:remove', (_e, id: string) => removeModel(id));
  ipcMain.handle('models:set-api-key', (_e, id: string, key: string) => setRemoteApiKey(id, key));
  ipcMain.handle('models:has-api-key', (_e, id: string) => hasRemoteApiKey(id));
  ipcMain.handle('models:encryption-available', () => isEncryptionAvailable());

  // Remote access (companion phone app)
  ipcMain.handle('remote:status', async () => {
    const status = getRemoteStatus();
    const tailscale = await getTailscaleStatus().catch(() => null);
    return { ...status, tailscaleIp: tailscale?.ip ?? '', tailscale };
  });
  ipcMain.handle('remote:pairing', async () => {
    const port = Number(store.getSetting('remotePort', String(DEFAULT_REMOTE_PORT))) || DEFAULT_REMOTE_PORT;
    return generatePairing(port);
  });
  ipcMain.handle('remote:devices', () => listPairedDevices());
  ipcMain.handle('remote:revoke', (_e, id: string) => revokeDevice(id));
  ipcMain.handle('remote:tailscale', async () => getTailscaleStatus());
  ipcMain.handle('remote:install-tailscale', async () => installTailscale());
  ipcMain.handle('remote:set-enabled', async (_e, enabled: boolean) => {
    store.setSetting('remoteEnabled', enabled ? 'true' : 'false');
    if (enabled) {
      const port = Number(store.getSetting('remotePort', String(DEFAULT_REMOTE_PORT))) || DEFAULT_REMOTE_PORT;
      return startRemoteServer(port, (chatId, text) => handleChatSend(chatId, text, 'remote'));
    }
    stopRemoteServer();
    return getRemoteStatus();
  });

  // Voice
  ipcMain.handle('voice:status', async () => checkVoice());
  ipcMain.handle('voice:save-recording', (_e, base64: string, mime: string) => {
    const ext = mime.includes('wav') ? 'wav' : mime.includes('ogg') ? 'ogg' : 'webm';
    const dir = path.join(dataDir(), 'voice');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `rec-${Date.now()}.${ext}`);
    fs.writeFileSync(file, Buffer.from(base64, 'base64'));
    return file;
  });
  ipcMain.handle('voice:transcribe', (_e, audioPath: string) => voiceSidecar.transcribe(audioPath));
  ipcMain.handle('voice:speak', async (_e, text: string) => {
    const wavPath = await voiceSidecar.speak(text);
    const data = fs.readFileSync(wavPath);
    return `data:audio/wav;base64,${data.toString('base64')}`;
  });

  // Files
  ipcMain.handle('files:pick-folder', async () => {
    if (!mainWindow) return null;
    const res = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
    return res.canceled ? null : res.filePaths[0] ?? null;
  });
}

async function handleChatSend(chatId: string, text: string, source: 'local' | 'remote' = 'local'): Promise<void> {
  const chats = store.listChats(undefined, true);
  const chat = chats.find((c) => c.id === chatId);
  if (!chat) {
    sendToRenderer('agent:error', chatId, 'Chat not found.');
    return;
  }
  const project = chat.projectId ? store.getProject(chat.projectId) : undefined;
  const permissions = project ? project.permissions : MAIN_CHAT_PERMISSIONS;
  // Resolve the model the user picked in Settings → Models. A remote model
  // without a saved API key fails here with a plain-language error.
  let resolved;
  try {
    resolved = resolveSelectedModel();
  } catch (e) {
    sendToRenderer('agent:error', chatId, e instanceof Error ? e.message : String(e));
    return;
  }
  const model = resolved.entry.kind === 'local' ? (resolved.ollamaTag ?? DEFAULT_MODEL) : (resolved.modelName ?? DEFAULT_MODEL);
  const remote =
    resolved.entry.kind === 'remote'
      ? {
          label: resolved.entry.label,
          baseUrl: resolved.baseUrl ?? '',
          apiKey: resolved.apiKey ?? '',
          modelName: resolved.modelName ?? '',
        }
      : null;
  const think = store.getSetting('thinking', 'false') === 'true';

  store.addMessage(chatId, 'user', text);
  if (chat.title === 'New chat') {
    store.renameChat(chatId, text.slice(0, 48));
  }
  const history = store.listMessages(chatId, 60);
  const memories = [
    ...store.listMemories('global'),
    ...(chat.projectId ? store.listMemories('project', chat.projectId) : []),
  ];
  const messages = [
    { role: 'system' as const, content: buildSystemPrompt(memories, project ?? null) },
    ...history.map((m) => ({ role: m.role as 'user' | 'assistant' | 'tool', content: m.content })),
  ];
  const controller = new AbortController();
  abortControllers.set(chatId, controller);
  let streamed = '';
  try {
    const answer = await runAgentTurn({
      model,
      think,
      remote,
      projectId: chat.projectId,
      permissions,
      messages,
      tools: ALL_TOOLS,
      onToken: (token) => {
        streamed += token;
        sendToRenderer('agent:token', chatId, token);
      },
      requestConfirmation,
      signal: controller.signal,
    });
    const finalText = answer || streamed;
    if (finalText.trim()) store.addMessage(chatId, 'assistant', finalText);
    if (source === 'remote') {
      store.addNotification('chat_done', chat.title, finalText.slice(0, 200), chatId);
    }
    sendToRenderer('agent:done', chatId);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    sendToRenderer('agent:error', chatId, message);
  } finally {
    abortControllers.delete(chatId);
  }
}

void app.whenReady().then(() => {
  store.initDb(dataDir());
  if (!store.getSetting('model')) store.setSetting('model', DEFAULT_MODEL);
  registerIpc();
  try {
    createWindow();
  } catch (e) {
    // The window is the UI, but the scheduler and phone-access server are
    // still useful without it (e.g. headless or remote-only use).
    console.error('[main] could not create window:', e instanceof Error ? e.message : String(e));
  }
  if (store.getSetting('remoteEnabled', 'true') !== 'false') {
    const port = Number(store.getSetting('remotePort', String(DEFAULT_REMOTE_PORT))) || DEFAULT_REMOTE_PORT;
    void startRemoteServer(port, (chatId, text) => handleChatSend(chatId, text, 'remote')).then((status) => {
      if (!status.running) console.error(`[remote] could not start phone-access server: ${status.error ?? 'unknown error'}`);
    });
  }
  scheduler = new Scheduler({
    notify: (title, body) => sendToRenderer('agent:notify', title, body),
  });
  scheduler.start();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  scheduler?.stop();
  voiceSidecar.stop();
  void terminateOcr();
  stopRemoteServer();
});

// Keep secrets out of logs: never print credential values.
export { getSecret };
