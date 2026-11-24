// Unit tests for the model registry (src/main/models.ts).
// Run: npm run build && npm run test:unit
// All code, comments, log messages and docs in this project are English only.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  __resetStore,
  getSetting,
} from './store-stub.mjs';
import {
  addLocalModel,
  addRemoteModel,
  buildRemoteEntry,
  defaultLocalEntry,
  getModelRegistry,
  getSelectedModel,
  getSelectedModelId,
  hasRemoteApiKey,
  localModelId,
  migrateRegistry,
  removeModel,
  resolveSelectedModel,
  selectModel,
  setRemoteApiKey,
  updateRemoteModel,
  validateLocalTag,
} from '../../dist/main/models.js';

test.beforeEach(() => {
  __resetStore();
});

test('migrateRegistry: fresh install gets the default local model', () => {
  const entries = migrateRegistry(null, null);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, localModelId('qwen3:8b-q8_0'));
  assert.equal(entries[0].kind, 'local');
  assert.equal(entries[0].ollamaTag, 'qwen3:8b-q8_0');
});

test('migrateRegistry: legacy model setting is preserved first', () => {
  const entries = migrateRegistry(null, 'qwen3:8b');
  assert.equal(entries[0].ollamaTag, 'qwen3:8b');
  assert.equal(entries[1].ollamaTag, 'qwen3:8b-q8_0');
});

test('migrateRegistry: corrupt stored JSON falls back to defaults', () => {
  const entries = migrateRegistry('{not json', null);
  assert.deepEqual(entries, [defaultLocalEntry()]);
});

test('migrateRegistry: a stored remote entry survives', () => {
  const stored = JSON.stringify([
    { id: 'local:qwen3:8b-q8_0', kind: 'local', label: 'qwen3:8b-q8_0', ollamaTag: 'qwen3:8b-q8_0' },
    { id: 'remote:gpt-4o', kind: 'remote', label: 'GPT-4o', baseUrl: 'https://api.openai.com/v1', modelName: 'gpt-4o', preset: 'openai' },
  ]);
  const entries = migrateRegistry(stored, null);
  assert.equal(entries.length, 2);
  assert.equal(entries[1].kind, 'remote');
});

test('validateLocalTag: accepts tags, rejects empty and unsafe values', () => {
  assert.equal(validateLocalTag('  qwen3:14b-q4_K_M  '), 'qwen3:14b-q4_K_M');
  assert.throws(() => validateLocalTag(''), /Enter an Ollama model tag/);
  assert.throws(() => validateLocalTag('has space'), /not a valid Ollama model tag/);
  assert.throws(() => validateLocalTag('../escape'), /not a valid Ollama model tag/);
});

test('buildRemoteEntry: OpenAI preset fills in the base URL', () => {
  const entry = buildRemoteEntry({ label: '', preset: 'openai', baseUrl: '', modelName: 'gpt-4o' });
  assert.equal(entry.baseUrl, 'https://api.openai.com/v1');
  assert.equal(entry.modelName, 'gpt-4o');
  assert.equal(entry.label, 'gpt-4o (OpenAI)');
  assert.equal(entry.preset, 'openai');
});

test('buildRemoteEntry: custom preset validates the URL and strips trailing slashes', () => {
  const entry = buildRemoteEntry({ label: 'My gateway', preset: 'custom', baseUrl: 'https://example.com/v1/', modelName: 'llama' });
  assert.equal(entry.baseUrl, 'https://example.com/v1');
  assert.throws(
    () => buildRemoteEntry({ label: '', preset: 'custom', baseUrl: 'not-a-url', modelName: 'x' }),
    /valid base URL/,
  );
  assert.throws(
    () => buildRemoteEntry({ label: '', preset: 'custom', baseUrl: 'https://example.com/v1', modelName: '  ' }),
    /model name/,
  );
});

test('registry: addLocal dedupes, addRemote rejects duplicates, select works', () => {
  const first = addLocalModel('qwen3:14b');
  const again = addLocalModel('qwen3:14b');
  assert.equal(first.id, again.id);
  assert.equal(getModelRegistry().length, 2); // default + qwen3:14b

  const remote = addRemoteModel({ label: 'GPT-4o', preset: 'openai', baseUrl: '', modelName: 'gpt-4o' });
  assert.throws(
    () => addRemoteModel({ label: 'GPT-4o', preset: 'openai', baseUrl: '', modelName: 'gpt-4o' }),
    /already exists/,
  );
  assert.equal(getSelectedModelId(), defaultLocalEntry().id);
  selectModel(remote.id);
  assert.equal(getSelectedModel().id, remote.id);
  assert.throws(() => selectModel('local:nope'), /Unknown model/);
});

test('registry: removing the selected model falls back to the default local', () => {
  const remote = addRemoteModel({ label: 'GPT-4o', preset: 'openai', baseUrl: '', modelName: 'gpt-4o' });
  selectModel(remote.id);
  removeModel(remote.id);
  assert.equal(getSelectedModelId(), defaultLocalEntry().id);
  assert.equal(getModelRegistry().length, 1);
  assert.throws(() => removeModel(defaultLocalEntry().id), /last model/);
});

test('remote API key: round-trips encrypted, resolve requires it', () => {
  const remote = addRemoteModel({ label: 'GPT-4o', preset: 'openai', baseUrl: '', modelName: 'gpt-4o' });
  selectModel(remote.id);
  assert.equal(hasRemoteApiKey(remote.id), false);
  assert.throws(() => resolveSelectedModel(), /No API key saved/);

  setRemoteApiKey(remote.id, 'sk-test-123');
  assert.equal(hasRemoteApiKey(remote.id), true);
  const resolved = resolveSelectedModel();
  assert.equal(resolved.entry.kind, 'remote');
  assert.equal(resolved.baseUrl, 'https://api.openai.com/v1');
  assert.equal(resolved.modelName, 'gpt-4o');
  assert.equal(resolved.apiKey, 'sk-test-123');

  // The stored value is the encrypted form, never the plain key.
  const stored = getSetting(`secret:remote-api-key:${remote.id}`);
  assert.ok(stored && !stored.includes('sk-test-123'));
});

test('updateRemoteModel: edits URL and name, rejects bad input', () => {
  const remote = addRemoteModel({ label: 'GPT-4o', preset: 'openai', baseUrl: '', modelName: 'gpt-4o' });
  const updated = updateRemoteModel(remote.id, { modelName: 'gpt-4o-mini' });
  assert.equal(updated.modelName, 'gpt-4o-mini');
  assert.throws(() => updateRemoteModel(remote.id, { baseUrl: 'ftp://x' }), /valid base URL/);
  assert.throws(() => updateRemoteModel(defaultLocalEntry().id, { modelName: 'x' }), /Only remote models/);
});
