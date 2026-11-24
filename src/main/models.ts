// Model registry: the list of language models the user can pick in Settings.
// Each entry is tagged (Local) or (Remote).
// - Local models run through Ollama on this machine. No API key, no network
//   beyond localhost. The default is qwen3:8b-q8_0 (~8 GB VRAM).
// - Remote models call an OpenAI-compatible /chat/completions endpoint with
//   the user's own API key. The key is encrypted with the OS credential store
//   (see credentials.ts) and never written to a plain file. Remote is strictly
//   opt-in; the default stays local, so the local-only privacy default holds.
// Selection is MANUAL only in this version. Automatic model selection by task
// difficulty is a planned future feature (see BUILD_STATUS.md), not built here.
// All code, comments, log messages and docs in this project are English only.

import { getSetting, setSetting } from './store.js';
import { getSecret, setSecret, deleteSecret, isEncryptionAvailable } from './credentials.js';
import { DEFAULT_MODEL } from './setup.js';

export type ModelKind = 'local' | 'remote';

export interface ModelEntry {
  id: string;
  kind: ModelKind;
  /** Display name, e.g. 'qwen3:8b-q8_0' or 'GPT-4o (OpenAI)'. */
  label: string;
  /** Local only: the Ollama model tag, e.g. 'qwen3:8b-q8_0'. */
  ollamaTag?: string;
  /** Remote only: OpenAI-compatible base URL, e.g. 'https://api.openai.com/v1'. */
  baseUrl?: string;
  /** Remote only: the model name at the provider, e.g. 'gpt-4o'. */
  modelName?: string;
  /** Remote only: which preset filled in the base URL ('openai' | 'deepseek' | 'custom'). */
  preset?: string;
}

export interface RemotePreset {
  id: string;
  label: string;
  baseUrl: string;
}

/** Well-known OpenAI-compatible endpoints. 'custom' lets the user type any URL. */
export const REMOTE_PRESETS: RemotePreset[] = [
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' },
  { id: 'custom', label: 'Custom endpoint', baseUrl: '' },
];

const REGISTRY_KEY = 'modelRegistry';
const SELECTED_KEY = 'selectedModelId';

export function localModelId(tag: string): string {
  return `local:${tag}`;
}

export function remoteModelId(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `remote:${slug || 'model'}`;
}

export function defaultLocalEntry(): ModelEntry {
  return {
    id: localModelId(DEFAULT_MODEL),
    kind: 'local',
    label: DEFAULT_MODEL,
    ollamaTag: DEFAULT_MODEL,
  };
}

/** Migrate a stored registry JSON (or nothing) plus the legacy 'model' setting
 *  into a registry. Pure function, unit-tested. */
export function migrateRegistry(storedJson: string | null, legacyModel: string | null): ModelEntry[] {
  const entries: ModelEntry[] = [];
  if (storedJson) {
    try {
      const parsed = JSON.parse(storedJson) as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item !== 'object' || item === null) continue;
          const e = item as Partial<ModelEntry>;
          if (typeof e.id !== 'string' || (e.kind !== 'local' && e.kind !== 'remote')) continue;
          if (typeof e.label !== 'string' || !e.label) continue;
          if (e.kind === 'local' && typeof e.ollamaTag !== 'string') continue;
          if (e.kind === 'remote' && (typeof e.baseUrl !== 'string' || typeof e.modelName !== 'string')) continue;
          entries.push(e as ModelEntry);
        }
      }
    } catch {
      // Corrupt stored registry; fall through to the defaults below.
    }
  }
  if (entries.length === 0) {
    // First run (or corrupt registry): keep the user's existing model choice
    // from the legacy setting when there is one, then the default.
    const legacy = (legacyModel ?? '').trim();
    if (legacy) {
      entries.push({ id: localModelId(legacy), kind: 'local', label: legacy, ollamaTag: legacy });
    }
    if (!entries.some((e) => e.id === defaultLocalEntry().id)) {
      entries.push(defaultLocalEntry());
    }
  }
  return entries;
}

export function getModelRegistry(): ModelEntry[] {
  const entries = migrateRegistry(getSetting(REGISTRY_KEY) || null, getSetting('model') || null);
  setSetting(REGISTRY_KEY, JSON.stringify(entries));
  return entries;
}

function saveRegistry(entries: ModelEntry[]): void {
  setSetting(REGISTRY_KEY, JSON.stringify(entries));
}

export function getSelectedModelId(): string {
  const entries = getModelRegistry();
  const saved = getSetting(SELECTED_KEY);
  if (saved && entries.some((e) => e.id === saved)) return saved;
  return defaultLocalEntry().id;
}

export function getSelectedModel(): ModelEntry {
  const entries = getModelRegistry();
  const id = getSelectedModelId();
  return entries.find((e) => e.id === id) ?? defaultLocalEntry();
}

export function selectModel(id: string): ModelEntry {
  const entries = getModelRegistry();
  const entry = entries.find((e) => e.id === id);
  if (!entry) throw new Error(`Unknown model: ${id}`);
  setSetting(SELECTED_KEY, id);
  return entry;
}

/** Validate an Ollama model tag. Pure function, unit-tested. */
export function validateLocalTag(tag: string): string {
  const clean = tag.trim();
  if (!clean) throw new Error('Enter an Ollama model tag, e.g. qwen3:8b-q8_0.');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(clean)) {
    throw new Error(`"${clean}" is not a valid Ollama model tag.`);
  }
  return clean;
}

export function addLocalModel(tag: string): ModelEntry {
  const clean = validateLocalTag(tag);
  const entries = getModelRegistry();
  const id = localModelId(clean);
  const existing = entries.find((e) => e.id === id);
  if (existing) return existing;
  const entry: ModelEntry = { id, kind: 'local', label: clean, ollamaTag: clean };
  entries.push(entry);
  saveRegistry(entries);
  return entry;
}

/** Validate remote-model input and normalize it into an entry (without an id
 *  collision check). Pure function, unit-tested. */
export function buildRemoteEntry(input: {
  label: string;
  preset: string;
  baseUrl: string;
  modelName: string;
}): ModelEntry {
  const preset = REMOTE_PRESETS.find((p) => p.id === input.preset) ?? REMOTE_PRESETS[2];
  let baseUrl = preset.id === 'custom' ? input.baseUrl.trim() : preset.baseUrl;
  baseUrl = baseUrl.replace(/\/+$/, '');
  if (!/^https?:\/\/.+/.test(baseUrl)) {
    throw new Error('Enter a valid base URL starting with https:// (e.g. https://api.openai.com/v1).');
  }
  const modelName = input.modelName.trim();
  if (!modelName) throw new Error('Enter the model name at the provider, e.g. gpt-4o.');
  const label = input.label.trim() || `${modelName} (${preset.label})`;
  return {
    id: remoteModelId(label),
    kind: 'remote',
    label,
    baseUrl,
    modelName,
    preset: preset.id,
  };
}

export function addRemoteModel(input: {
  label: string;
  preset: string;
  baseUrl: string;
  modelName: string;
}): ModelEntry {
  const entry = buildRemoteEntry(input);
  const entries = getModelRegistry();
  if (entries.some((e) => e.id === entry.id)) {
    throw new Error(`A remote model named "${entry.label}" already exists. Pick a different name.`);
  }
  entries.push(entry);
  saveRegistry(entries);
  return entry;
}

export function updateRemoteModel(
  id: string,
  patch: { label?: string; baseUrl?: string; modelName?: string },
): ModelEntry {
  const entries = getModelRegistry();
  const entry = entries.find((e) => e.id === id);
  if (!entry) throw new Error(`Unknown model: ${id}`);
  if (entry.kind !== 'remote') throw new Error('Only remote models can be edited this way.');
  if (patch.label !== undefined) {
    const label = patch.label.trim();
    if (!label) throw new Error('The model name cannot be empty.');
    entry.label = label;
  }
  if (patch.baseUrl !== undefined) {
    const baseUrl = patch.baseUrl.trim().replace(/\/+$/, '');
    if (!/^https?:\/\/.+/.test(baseUrl)) {
      throw new Error('Enter a valid base URL starting with https://.');
    }
    entry.baseUrl = baseUrl;
  }
  if (patch.modelName !== undefined) {
    const modelName = patch.modelName.trim();
    if (!modelName) throw new Error('The model name cannot be empty.');
    entry.modelName = modelName;
  }
  saveRegistry(entries);
  return entry;
}

export function removeModel(id: string): void {
  const entries = getModelRegistry();
  if (entries.length <= 1) {
    throw new Error('Cannot remove the last model. Add another one first.');
  }
  const kept = entries.filter((e) => e.id !== id);
  if (kept.length === entries.length) throw new Error(`Unknown model: ${id}`);
  saveRegistry(kept);
  if (getSetting(SELECTED_KEY) === id) {
    setSetting(SELECTED_KEY, defaultLocalEntry().id);
    // The default entry always exists after migration; re-add it if it was
    // the one removed.
    if (!kept.some((e) => e.id === defaultLocalEntry().id)) {
      kept.push(defaultLocalEntry());
      saveRegistry(kept);
    }
  }
}

/** API-key storage. The key is encrypted with the OS credential store
 *  (safeStorage / Windows Credential Manager) and never written in plain text.
 *  Throws when OS encryption is unavailable, so a key is never saved plain. */
export function setRemoteApiKey(id: string, key: string): void {
  const entries = getModelRegistry();
  const entry = entries.find((e) => e.id === id);
  if (!entry) throw new Error(`Unknown model: ${id}`);
  if (entry.kind !== 'remote') throw new Error('Only remote models use an API key.');
  const clean = key.trim();
  if (!clean) {
    deleteSecret(`remote-api-key:${id}`);
    return;
  }
  if (!isEncryptionAvailable()) {
    throw new Error('OS encryption is not available on this machine, so the API key was not saved.');
  }
  setSecret(`remote-api-key:${id}`, clean);
}

export function hasRemoteApiKey(id: string): boolean {
  return getSecret(`remote-api-key:${id}`) !== null;
}

export function getRemoteApiKey(id: string): string | null {
  return getSecret(`remote-api-key:${id}`);
}

export interface ResolvedModel {
  entry: ModelEntry;
  /** Local only. */
  ollamaTag?: string;
  /** Remote only. */
  baseUrl?: string;
  modelName?: string;
  apiKey?: string;
}

/** Resolve the selected model for a chat turn. For a remote model without a
 *  saved API key, throws a plain-language error shown in the chat. */
export function resolveSelectedModel(): ResolvedModel {
  const entry = getSelectedModel();
  if (entry.kind === 'local') {
    return { entry, ollamaTag: entry.ollamaTag ?? DEFAULT_MODEL };
  }
  const apiKey = getRemoteApiKey(entry.id);
  if (!apiKey) {
    throw new Error(
      `No API key saved for "${entry.label}". Open Settings → Models, select it, and add your API key first.`,
    );
  }
  return { entry, baseUrl: entry.baseUrl, modelName: entry.modelName, apiKey };
}
