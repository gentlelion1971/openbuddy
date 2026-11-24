// Preload bridge: exposes a safe, typed API to the renderer as window.agent.
// The renderer never touches Node or Electron directly.
// All code, comments, log messages and docs in this project are English only.

import { contextBridge, ipcRenderer } from 'electron';

export interface ChatSummary {
  id: string;
  title: string;
  projectId: string | null;
  archived: number;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  chatId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  createdAt: string;
}

export interface Project {
  id: string;
  name: string;
  folderPath: string;
  notes: string;
  permissions: Record<string, unknown>;
  createdAt: string;
}

export interface Memory {
  id: string;
  scope: 'global' | 'project';
  projectId: string | null;
  key: string;
  value: string;
}

export interface TaskItem {
  id: string;
  title: string;
  status: 'open' | 'done';
  projectId: string | null;
  dueAt: string | null;
}

export interface EmailAccount {
  id: string;
  label: string;
  kind: string;
  username: string;
}

export interface ModelEntry {
  id: string;
  kind: 'local' | 'remote';
  label: string;
  ollamaTag?: string;
  baseUrl?: string;
  modelName?: string;
  preset?: string;
}

export interface RemotePreset {
  id: string;
  label: string;
  baseUrl: string;
}

export interface EmailSummary {
  uid: number;
  from: string;
  subject: string;
  date: string;
  snippet: string;
  seen: boolean;
}

export interface ConfirmRequest {
  id: string;
  toolName: string;
  summary: string;
  details: unknown;
}

const api = {
  app: {
    version: (): Promise<string> => ipcRenderer.invoke('app:version'),
    openDataFolder: (): Promise<void> => ipcRenderer.invoke('app:open-data-folder'),
  },
  setup: {
    getStatus: (): Promise<unknown> => ipcRenderer.invoke('setup:get-status'),
    installOllama: (): Promise<void> => ipcRenderer.invoke('setup:install-ollama'),
    waitForOllama: (): Promise<boolean> => ipcRenderer.invoke('setup:wait-ollama'),
    pullModel: (model: string): Promise<void> => ipcRenderer.invoke('setup:pull-model', model),
    installVoice: (): Promise<void> => ipcRenderer.invoke('setup:install-voice'),
    installOcr: (): Promise<void> => ipcRenderer.invoke('setup:install-ocr'),
    completeSetup: (): Promise<void> => ipcRenderer.invoke('setup:complete'),
    onProgress: (cb: (p: unknown) => void): (() => void) => {
      const handler = (_e: unknown, p: unknown) => cb(p);
      ipcRenderer.on('setup:progress', handler as never);
      return () => ipcRenderer.removeListener('setup:progress', handler as never);
    },
  },
  chats: {
    list: (projectId?: string | null): Promise<ChatSummary[]> => ipcRenderer.invoke('chat:list', projectId ?? null),
    create: (title: string, projectId: string | null): Promise<ChatSummary> => ipcRenderer.invoke('chat:create', title, projectId),
    rename: (id: string, title: string): Promise<void> => ipcRenderer.invoke('chat:rename', id, title),
    archive: (id: string, archived: boolean): Promise<void> => ipcRenderer.invoke('chat:archive', id, archived),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('chat:delete', id),
    messages: (chatId: string): Promise<ChatMessage[]> => ipcRenderer.invoke('chat:messages', chatId),
    send: (chatId: string, text: string): Promise<void> => ipcRenderer.invoke('chat:send', chatId, text),
    stop: (chatId: string): Promise<void> => ipcRenderer.invoke('chat:stop', chatId),
  },
  agent: {
    onToken: (cb: (chatId: string, token: string) => void): (() => void) => {
      const handler = (_e: unknown, chatId: string, token: string) => cb(chatId, token);
      ipcRenderer.on('agent:token', handler as never);
      return () => ipcRenderer.removeListener('agent:token', handler as never);
    },
    onDone: (cb: (chatId: string) => void): (() => void) => {
      const handler = (_e: unknown, chatId: string) => cb(chatId);
      ipcRenderer.on('agent:done', handler as never);
      return () => ipcRenderer.removeListener('agent:done', handler as never);
    },
    onError: (cb: (chatId: string, error: string) => void): (() => void) => {
      const handler = (_e: unknown, chatId: string, error: string) => cb(chatId, error);
      ipcRenderer.on('agent:error', handler as never);
      return () => ipcRenderer.removeListener('agent:error', handler as never);
    },
    onConfirm: (cb: (req: ConfirmRequest) => void): (() => void) => {
      const handler = (_e: unknown, req: ConfirmRequest) => cb(req);
      ipcRenderer.on('agent:confirm', handler as never);
      return () => ipcRenderer.removeListener('agent:confirm', handler as never);
    },
    confirm: (id: string, approved: boolean): Promise<void> => ipcRenderer.invoke('agent:confirm', id, approved),
    onNotify: (cb: (title: string, body: string) => void): (() => void) => {
      const handler = (_e: unknown, title: string, body: string) => cb(title, body);
      ipcRenderer.on('agent:notify', handler as never);
      return () => ipcRenderer.removeListener('agent:notify', handler as never);
    },
  },
  projects: {
    list: (): Promise<Project[]> => ipcRenderer.invoke('projects:list'),
    create: (name: string, folderPath: string): Promise<Project> => ipcRenderer.invoke('projects:create', name, folderPath),
    update: (id: string, patch: Record<string, unknown>): Promise<void> => ipcRenderer.invoke('projects:update', id, patch),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('projects:delete', id),
  },
  memories: {
    list: (scope: 'global' | 'project', projectId?: string | null): Promise<Memory[]> =>
      ipcRenderer.invoke('memories:list', scope, projectId ?? null),
    set: (scope: 'global' | 'project', projectId: string | null, key: string, value: string): Promise<void> =>
      ipcRenderer.invoke('memories:set', scope, projectId, key, value),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('memories:delete', id),
  },
  tasks: {
    list: (projectId?: string | null): Promise<TaskItem[]> => ipcRenderer.invoke('tasks:list', projectId ?? null),
    create: (title: string, projectId: string | null, dueAt: string | null): Promise<TaskItem> =>
      ipcRenderer.invoke('tasks:create', title, projectId, dueAt),
    setStatus: (id: string, status: 'open' | 'done'): Promise<void> => ipcRenderer.invoke('tasks:set-status', id, status),
  },
  email: {
    accounts: (): Promise<EmailAccount[]> => ipcRenderer.invoke('email:accounts'),
    addAccount: (account: Record<string, unknown>, password: string): Promise<EmailAccount> =>
      ipcRenderer.invoke('email:add-account', account, password),
    removeAccount: (id: string): Promise<void> => ipcRenderer.invoke('email:remove-account', id),
    inbox: (accountId: string, limit?: number): Promise<EmailSummary[]> => ipcRenderer.invoke('email:inbox', accountId, limit ?? 30),
    search: (accountId: string, query: string): Promise<EmailSummary[]> => ipcRenderer.invoke('email:search', accountId, query),
    read: (accountId: string, uid: number): Promise<unknown> => ipcRenderer.invoke('email:read', accountId, uid),
    send: (accountId: string, draft: Record<string, unknown>): Promise<void> => ipcRenderer.invoke('email:send', accountId, draft),
    digest: (accountId: string): Promise<string> => ipcRenderer.invoke('email:digest', accountId),
  },
  calendar: {
    events: (fromIso: string, toIso: string): Promise<unknown[]> => ipcRenderer.invoke('calendar:events', fromIso, toIso),
    add: (event: Record<string, unknown>): Promise<void> => ipcRenderer.invoke('calendar:add', event),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('calendar:delete', id),
    reminders: (): Promise<unknown[]> => ipcRenderer.invoke('reminders:list'),
    addReminder: (title: string, remindAt: string): Promise<void> => ipcRenderer.invoke('reminders:add', title, remindAt),
    completeReminder: (id: string): Promise<void> => ipcRenderer.invoke('reminders:complete', id),
  },
  watches: {
    list: (): Promise<unknown[]> => ipcRenderer.invoke('watches:list'),
    create: (name: string, kind: string, config: Record<string, unknown>): Promise<void> =>
      ipcRenderer.invoke('watches:create', name, kind, config),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('watches:delete', id),
    setActive: (id: string, active: boolean): Promise<void> => ipcRenderer.invoke('watches:set-active', id, active),
  },
  settings: {
    get: (key: string, fallback?: string): Promise<string> => ipcRenderer.invoke('settings:get', key, fallback ?? ''),
    set: (key: string, value: string): Promise<void> => ipcRenderer.invoke('settings:set', key, value),
    setSecret: (key: string, value: string): Promise<void> => ipcRenderer.invoke('settings:set-secret', key, value),
    models: (): Promise<string[]> => ipcRenderer.invoke('settings:models'),
    ollamaStatus: (): Promise<unknown> => ipcRenderer.invoke('settings:ollama-status'),
  },
  models: {
    list: (): Promise<{ entries: ModelEntry[]; selectedId: string; presets: RemotePreset[] }> =>
      ipcRenderer.invoke('models:list'),
    select: (id: string): Promise<ModelEntry> => ipcRenderer.invoke('models:select', id),
    addLocal: (tag: string): Promise<ModelEntry> => ipcRenderer.invoke('models:add-local', tag),
    addRemote: (input: { label: string; preset: string; baseUrl: string; modelName: string }): Promise<ModelEntry> =>
      ipcRenderer.invoke('models:add-remote', input),
    updateRemote: (id: string, patch: { label?: string; baseUrl?: string; modelName?: string }): Promise<ModelEntry> =>
      ipcRenderer.invoke('models:update-remote', id, patch),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('models:remove', id),
    setApiKey: (id: string, key: string): Promise<void> => ipcRenderer.invoke('models:set-api-key', id, key),
    hasApiKey: (id: string): Promise<boolean> => ipcRenderer.invoke('models:has-api-key', id),
    encryptionAvailable: (): Promise<boolean> => ipcRenderer.invoke('models:encryption-available'),
  },
  remote: {
    status: (): Promise<unknown> => ipcRenderer.invoke('remote:status'),
    pairing: (): Promise<unknown> => ipcRenderer.invoke('remote:pairing'),
    devices: (): Promise<unknown> => ipcRenderer.invoke('remote:devices'),
    revoke: (id: string): Promise<void> => ipcRenderer.invoke('remote:revoke', id),
    tailscale: (): Promise<unknown> => ipcRenderer.invoke('remote:tailscale'),
    installTailscale: (): Promise<string> => ipcRenderer.invoke('remote:install-tailscale'),
    setEnabled: (enabled: boolean): Promise<unknown> => ipcRenderer.invoke('remote:set-enabled', enabled),
  },
  voice: {
    status: (): Promise<unknown> => ipcRenderer.invoke('voice:status'),
    saveRecording: (base64: string, mime: string): Promise<string> => ipcRenderer.invoke('voice:save-recording', base64, mime),
    transcribe: (audioPath: string): Promise<string> => ipcRenderer.invoke('voice:transcribe', audioPath),
    speak: (text: string): Promise<string> => ipcRenderer.invoke('voice:speak', text),
  },
  attachments: {
    cleanupNow: (): Promise<unknown> => ipcRenderer.invoke('attachments:cleanup-now'),
  },
  files: {
    pickFolder: (): Promise<string | null> => ipcRenderer.invoke('files:pick-folder'),
  },
};

contextBridge.exposeInMainWorld('agent', api);
export type AgentApi = typeof api;
