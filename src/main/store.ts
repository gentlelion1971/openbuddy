// SQLite storage (better-sqlite3, synchronous API).
// Holds chats, messages, projects, memories, tasks, watches, accounts,
// calendar events and reminders. Passwords and secrets are NEVER stored here;
// they live in Windows Credential Manager and are referenced by credentialKey.
// All code, comments, log messages and docs in this project are English only.

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { ProjectPermissions } from './tools/types.js';

let db: Database.Database | null = null;
let dataDirPath = '';

/** Application data folder passed to initDb (per-user data dir). Used for
 *  app-owned files such as cached email attachments and OCR data. */
export function getDataDir(): string {
  if (!dataDirPath) throw new Error('Database is not initialized. Call initDb first.');
  return dataDirPath;
}

export interface ChatRow {
  id: string;
  title: string;
  projectId: string | null;
  archived: number;
  createdAt: string;
  updatedAt: string;
}

export interface MessageRow {
  id: string;
  chatId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  createdAt: string;
}

export interface ProjectRow {
  id: string;
  name: string;
  folderPath: string;
  notes: string;
  permissions: ProjectPermissions;
  createdAt: string;
}

export interface MemoryRow {
  id: string;
  scope: 'global' | 'project';
  projectId: string | null;
  key: string;
  value: string;
  createdAt: string;
}

export interface TaskRow {
  id: string;
  title: string;
  status: 'open' | 'done';
  projectId: string | null;
  dueAt: string | null;
  createdAt: string;
}

export interface WatchRow {
  id: string;
  name: string;
  kind: 'email' | 'web';
  config: Record<string, unknown>;
  active: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
}

export interface AccountRow {
  id: string;
  label: string;
  kind: 'imap' | 'smtp' | 'graph';
  host: string;
  port: number;
  secure: number;
  username: string;
  /** Key under which the secret is stored in Windows Credential Manager. */
  credentialKey: string;
  createdAt: string;
}

export interface EventRow {
  id: string;
  title: string;
  startAt: string;
  endAt: string;
  location: string;
  notes: string;
  source: string;
  createdAt: string;
}

export interface ReminderRow {
  id: string;
  title: string;
  remindAt: string;
  done: number;
  createdAt: string;
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function initDb(dataDir: string): Database.Database {
  dataDirPath = dataDir;
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'local-agent.db');
  db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, project_id TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, role TEXT NOT NULL,
      content TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages (chat_id, created_at);
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, folder_path TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '', permissions TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, project_id TEXT,
      key TEXT NOT NULL, value TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
      project_id TEXT, due_at TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS watches (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
      config TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
      last_run_at TEXT, next_run_at TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY, label TEXT NOT NULL, kind TEXT NOT NULL,
      host TEXT NOT NULL DEFAULT '', port INTEGER NOT NULL DEFAULT 0,
      secure INTEGER NOT NULL DEFAULT 1, username TEXT NOT NULL DEFAULT '',
      credential_key TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, start_at TEXT NOT NULL,
      end_at TEXT NOT NULL, location TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'local',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reminders (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, remind_at TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL,
      created_at TEXT NOT NULL, last_seen_at TEXT
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '', chat_id TEXT,
      created_at TEXT NOT NULL, read INTEGER NOT NULL DEFAULT 0
    );
  `);
  return db;
}

export function getDb(): Database.Database {
  if (!db) throw new Error('Database is not initialized. Call initDb first.');
  return db;
}

function nowIso(): string {
  return new Date().toISOString();
}

// ---- Settings ----
export function getSetting(key: string, fallback = ''): string {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : fallback;
}

export function setSetting(key: string, value: string): void {
  getDb()
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

// ---- Chats ----
export function listChats(projectId: string | null | undefined, includeArchived = false): ChatRow[] {
  const d = getDb();
  const rows = (
    projectId === undefined
      ? d.prepare(`SELECT * FROM chats ${includeArchived ? '' : 'WHERE archived = 0'} ORDER BY updated_at DESC`).all()
      : d.prepare(`SELECT * FROM chats WHERE project_id ${projectId === null ? 'IS NULL' : '= ?'} ${includeArchived ? '' : 'AND archived = 0'} ORDER BY updated_at DESC`).all(
          ...(projectId === null ? [] : [projectId]),
        )
  ) as Record<string, unknown>[];
  return rows.map(toChatRow);
}

export function createChat(title: string, projectId: string | null): ChatRow {
  const id = newId();
  const now = nowIso();
  getDb()
    .prepare('INSERT INTO chats (id, title, project_id, archived, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)')
    .run(id, title, projectId, now, now);
  return { id, title, projectId, archived: 0, createdAt: now, updatedAt: now };
}

export function renameChat(id: string, title: string): void {
  getDb().prepare('UPDATE chats SET title = ?, updated_at = ? WHERE id = ?').run(title, nowIso(), id);
}

export function archiveChat(id: string, archived: boolean): void {
  getDb().prepare('UPDATE chats SET archived = ?, updated_at = ? WHERE id = ?').run(archived ? 1 : 0, nowIso(), id);
}

export function deleteChat(id: string): void {
  const d = getDb();
  d.prepare('DELETE FROM messages WHERE chat_id = ?').run(id);
  d.prepare('DELETE FROM chats WHERE id = ?').run(id);
}

export function touchChat(id: string): void {
  getDb().prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(nowIso(), id);
}

function toChatRow(r: Record<string, unknown>): ChatRow {
  return {
    id: r.id as string,
    title: r.title as string,
    projectId: (r.project_id as string | null) ?? null,
    archived: r.archived as number,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

// ---- Messages ----
export function listMessages(chatId: string, limit = 200): MessageRow[] {
  const rows = getDb()
    .prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC LIMIT ?')
    .all(chatId, limit) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as string,
    chatId: r.chat_id as string,
    role: r.role as 'user' | 'assistant' | 'system' | 'tool',
    content: r.content as string,
    createdAt: r.created_at as string,
  }));
}

export function addMessage(chatId: string, role: MessageRow['role'], content: string): MessageRow {
  const id = newId();
  const now = nowIso();
  getDb()
    .prepare('INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, chatId, role, content, now);
  touchChat(chatId);
  return { id, chatId, role, content, createdAt: now };
}

// ---- Projects ----
export function listProjects(): ProjectRow[] {
  const rows = getDb().prepare('SELECT * FROM projects ORDER BY created_at ASC').all() as Record<string, unknown>[];
  return rows.map(toProjectRow);
}

export function createProject(name: string, folderPath: string, permissions: ProjectPermissions): ProjectRow {
  const id = newId();
  const now = nowIso();
  getDb()
    .prepare('INSERT INTO projects (id, name, folder_path, notes, permissions, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, name, folderPath, '', JSON.stringify(permissions), now);
  return { id, name, folderPath, notes: '', permissions, createdAt: now };
}

export function getProject(id: string): ProjectRow | undefined {
  const row = getDb().prepare('SELECT * FROM projects WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? toProjectRow(row) : undefined;
}

export function updateProject(id: string, patch: Partial<Pick<ProjectRow, 'name' | 'folderPath' | 'notes' | 'permissions'>>): void {
  const current = getProject(id);
  if (!current) throw new Error(`Project not found: ${id}`);
  const next = { ...current, ...patch };
  getDb()
    .prepare('UPDATE projects SET name = ?, folder_path = ?, notes = ?, permissions = ? WHERE id = ?')
    .run(next.name, next.folderPath, next.notes, JSON.stringify(next.permissions), id);
}

export function deleteProject(id: string): void {
  getDb().prepare('DELETE FROM projects WHERE id = ?').run(id);
}

function toProjectRow(r: Record<string, unknown>): ProjectRow {
  return {
    id: r.id as string,
    name: r.name as string,
    folderPath: r.folder_path as string,
    notes: r.notes as string,
    permissions: JSON.parse(r.permissions as string) as ProjectPermissions,
    createdAt: r.created_at as string,
  };
}

// ---- Memories ----
export function listMemories(scope: 'global' | 'project', projectId: string | null = null): MemoryRow[] {
  const rows = getDb()
    .prepare('SELECT * FROM memories WHERE scope = ? AND project_id IS ? ORDER BY key ASC')
    .all(scope, projectId) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as string,
    scope: r.scope as 'global' | 'project',
    projectId: (r.project_id as string | null) ?? null,
    key: r.key as string,
    value: r.value as string,
    createdAt: r.created_at as string,
  }));
}

export function setMemory(scope: 'global' | 'project', projectId: string | null, key: string, value: string): MemoryRow {
  const d = getDb();
  const existing = d
    .prepare('SELECT id FROM memories WHERE scope = ? AND project_id IS ? AND key = ?')
    .get(scope, projectId, key) as { id: string } | undefined;
  const now = nowIso();
  if (existing) {
    d.prepare('UPDATE memories SET value = ? WHERE id = ?').run(value, existing.id);
    return { id: existing.id, scope, projectId, key, value, createdAt: now };
  }
  const id = newId();
  d.prepare('INSERT INTO memories (id, scope, project_id, key, value, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    id, scope, projectId, key, value, now,
  );
  return { id, scope, projectId, key, value, createdAt: now };
}

export function deleteMemory(id: string): void {
  getDb().prepare('DELETE FROM memories WHERE id = ?').run(id);
}

// ---- Tasks ----
export function listTasks(projectId: string | null | undefined): TaskRow[] {
  const d = getDb();
  const rows = (
    projectId === undefined
      ? d.prepare('SELECT * FROM tasks ORDER BY created_at ASC').all()
      : d.prepare(`SELECT * FROM tasks WHERE project_id ${projectId === null ? 'IS NULL' : '= ?'} ORDER BY created_at ASC`).all(
          ...(projectId === null ? [] : [projectId]),
        )
  ) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as string,
    title: r.title as string,
    status: r.status as 'open' | 'done',
    projectId: (r.project_id as string | null) ?? null,
    dueAt: (r.due_at as string | null) ?? null,
    createdAt: r.created_at as string,
  }));
}

export function createTask(title: string, projectId: string | null, dueAt: string | null): TaskRow {
  const id = newId();
  const now = nowIso();
  getDb()
    .prepare('INSERT INTO tasks (id, title, status, project_id, due_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, title, 'open', projectId, dueAt, now);
  return { id, title, status: 'open', projectId, dueAt, createdAt: now };
}

export function setTaskStatus(id: string, status: 'open' | 'done'): void {
  getDb().prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, id);
}

// ---- Watches (recurring checks) ----
export function listWatches(): WatchRow[] {
  const rows = getDb().prepare('SELECT * FROM watches ORDER BY created_at ASC').all() as Record<string, unknown>[];
  return rows.map(toWatchRow);
}

export function createWatch(name: string, kind: 'email' | 'web', config: Record<string, unknown>): WatchRow {
  const id = newId();
  const now = nowIso();
  getDb()
    .prepare('INSERT INTO watches (id, name, kind, config, active, last_run_at, next_run_at, created_at) VALUES (?, ?, ?, ?, 1, NULL, NULL, ?)')
    .run(id, name, kind, JSON.stringify(config), now);
  return { id, name, kind, config, active: 1, lastRunAt: null, nextRunAt: null, createdAt: now };
}

export function setWatchActive(id: string, active: boolean): void {
  getDb().prepare('UPDATE watches SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
}

export function deleteWatch(id: string): void {
  getDb().prepare('DELETE FROM watches WHERE id = ?').run(id);
}

export function markWatchRun(id: string, nextRunAt: string | null): void {
  getDb().prepare('UPDATE watches SET last_run_at = ?, next_run_at = ? WHERE id = ?').run(nowIso(), nextRunAt, id);
}

function toWatchRow(r: Record<string, unknown>): WatchRow {
  return {
    id: r.id as string,
    name: r.name as string,
    kind: r.kind as 'email' | 'web',
    config: JSON.parse(r.config as string) as Record<string, unknown>,
    active: r.active as number,
    lastRunAt: (r.last_run_at as string | null) ?? null,
    nextRunAt: (r.next_run_at as string | null) ?? null,
    createdAt: r.created_at as string,
  };
}

// ---- Accounts ----
export function listAccounts(): AccountRow[] {
  const rows = getDb().prepare('SELECT * FROM accounts ORDER BY created_at ASC').all() as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as string,
    label: r.label as string,
    kind: r.kind as 'imap' | 'smtp' | 'graph',
    host: r.host as string,
    port: r.port as number,
    secure: r.secure as number,
    username: r.username as string,
    credentialKey: r.credential_key as string,
    createdAt: r.created_at as string,
  }));
}

export function addAccount(a: Omit<AccountRow, 'id' | 'createdAt'>): AccountRow {
  const id = newId();
  const now = nowIso();
  getDb()
    .prepare('INSERT INTO accounts (id, label, kind, host, port, secure, username, credential_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, a.label, a.kind, a.host, a.port, a.secure, a.username, a.credentialKey, now);
  return { ...a, id, createdAt: now };
}

export function deleteAccount(id: string): void {
  getDb().prepare('DELETE FROM accounts WHERE id = ?').run(id);
}

// ---- Calendar events ----
export function listEvents(fromIso: string, toIso: string): EventRow[] {
  const rows = getDb()
    .prepare('SELECT * FROM events WHERE start_at >= ? AND start_at < ? ORDER BY start_at ASC')
    .all(fromIso, toIso) as Record<string, unknown>[];
  return rows.map(toEventRow);
}

export function addEvent(e: Omit<EventRow, 'id' | 'createdAt'>): EventRow {
  const id = newId();
  const now = nowIso();
  getDb()
    .prepare('INSERT INTO events (id, title, start_at, end_at, location, notes, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, e.title, e.startAt, e.endAt, e.location, e.notes, e.source, now);
  return { ...e, id, createdAt: now };
}

export function deleteEvent(id: string): void {
  getDb().prepare('DELETE FROM events WHERE id = ?').run(id);
}

function toEventRow(r: Record<string, unknown>): EventRow {
  return {
    id: r.id as string,
    title: r.title as string,
    startAt: r.start_at as string,
    endAt: r.end_at as string,
    location: r.location as string,
    notes: r.notes as string,
    source: r.source as string,
    createdAt: r.created_at as string,
  };
}

// ---- Reminders ----
export function listReminders(includeDone = false): ReminderRow[] {
  const rows = getDb()
    .prepare(`SELECT * FROM reminders ${includeDone ? '' : 'WHERE done = 0'} ORDER BY remind_at ASC`)
    .all() as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as string,
    title: r.title as string,
    remindAt: r.remind_at as string,
    done: r.done as number,
    createdAt: r.created_at as string,
  }));
}

export function addReminder(title: string, remindAt: string): ReminderRow {
  const id = newId();
  const now = nowIso();
  getDb()
    .prepare('INSERT INTO reminders (id, title, remind_at, done, created_at) VALUES (?, ?, ?, 0, ?)')
    .run(id, title, remindAt, now);
  return { id, title, remindAt, done: 0, createdAt: now };
}

export function completeReminder(id: string): void {
  getDb().prepare('UPDATE reminders SET done = 1 WHERE id = ?').run(id);
}

// ---- Paired phone devices (companion app) ----
// Only a SHA-256 hash of each device token is stored; the token itself lives
// on the phone. Revoking a device deletes its row.
export interface DeviceRow {
  id: string;
  name: string;
  tokenHash: string;
  createdAt: string;
  lastSeenAt: string | null;
}

export function addDevice(name: string, tokenHash: string): DeviceRow {
  const id = newId();
  const now = nowIso();
  getDb()
    .prepare('INSERT INTO devices (id, name, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, NULL)')
    .run(id, name, tokenHash, now);
  return { id, name, tokenHash, createdAt: now, lastSeenAt: null };
}

export function listDevices(): DeviceRow[] {
  const rows = getDb().prepare('SELECT * FROM devices ORDER BY created_at ASC').all() as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    tokenHash: r.token_hash as string,
    createdAt: r.created_at as string,
    lastSeenAt: (r.last_seen_at as string | null) ?? null,
  }));
}

export function findDeviceByTokenHash(tokenHash: string): DeviceRow | undefined {
  const r = getDb().prepare('SELECT * FROM devices WHERE token_hash = ?').get(tokenHash) as
    | Record<string, unknown>
    | undefined;
  if (!r) return undefined;
  return {
    id: r.id as string,
    name: r.name as string,
    tokenHash: r.token_hash as string,
    createdAt: r.created_at as string,
    lastSeenAt: (r.last_seen_at as string | null) ?? null,
  };
}

export function touchDevice(id: string): void {
  getDb().prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(nowIso(), id);
}

export function removeDevice(id: string): void {
  getDb().prepare('DELETE FROM devices WHERE id = ?').run(id);
}

// ---- Completion notifications (for the companion phone app) ----
export interface NotificationRow {
  id: string;
  kind: string;
  title: string;
  body: string;
  chatId: string | null;
  createdAt: string;
  read: number;
}

export function addNotification(kind: string, title: string, body: string, chatId: string | null = null): NotificationRow {
  const id = newId();
  const now = nowIso();
  getDb()
    .prepare('INSERT INTO notifications (id, kind, title, body, chat_id, created_at, read) VALUES (?, ?, ?, ?, ?, ?, 0)')
    .run(id, kind, title, body, chatId, now);
  return { id, kind, title, body, chatId, createdAt: now, read: 0 };
}

export function listNotifications(unreadOnly = false): NotificationRow[] {
  const rows = getDb()
    .prepare(`SELECT * FROM notifications ${unreadOnly ? 'WHERE read = 0 ' : ''}ORDER BY created_at DESC LIMIT 50`)
    .all() as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as string,
    kind: r.kind as string,
    title: r.title as string,
    body: r.body as string,
    chatId: (r.chat_id as string | null) ?? null,
    createdAt: r.created_at as string,
    read: r.read as number,
  }));
}

export function markNotificationsRead(): void {
  getDb().prepare('UPDATE notifications SET read = 1 WHERE read = 0').run();
}
