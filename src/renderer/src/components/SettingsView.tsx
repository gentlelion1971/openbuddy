import React, { useEffect, useState } from 'react';
import type { ModelEntry, Project, RemotePreset } from '../../../preload/preload.js';

export default function SettingsView() {
  const [thinking, setThinking] = useState(false);
  const [ollama, setOllama] = useState<{ available: boolean; models: string[] } | null>(null);
  const [modelEntries, setModelEntries] = useState<ModelEntry[]>([]);
  const [selectedModelId, setSelectedModelId] = useState('');
  const [remotePresets, setRemotePresets] = useState<RemotePreset[]>([]);
  const [newLocalTag, setNewLocalTag] = useState('');
  const [newRemotePreset, setNewRemotePreset] = useState('openai');
  const [newRemoteBaseUrl, setNewRemoteBaseUrl] = useState('https://api.openai.com/v1');
  const [newRemoteModelName, setNewRemoteModelName] = useState('');
  const [newRemoteLabel, setNewRemoteLabel] = useState('');
  const [remoteKey, setRemoteKey] = useState('');
  const [remoteKeySaved, setRemoteKeySaved] = useState(false);
  const [encryptionAvailable, setEncryptionAvailable] = useState(true);
  const [editBaseUrl, setEditBaseUrl] = useState('');
  const [editModelName, setEditModelName] = useState('');
  const [modelsMsg, setModelsMsg] = useState('');
  const [voice, setVoice] = useState<{ ready: boolean; detail: string } | null>(null);
  const [ocr, setOcr] = useState<{ ready: boolean; detail: string } | null>(null);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [retention, setRetention] = useState('60');
  const [cleanupMsg, setCleanupMsg] = useState('');
  const [dataFolder, setDataFolder] = useState('');
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState('');
  const [perms, setPerms] = useState('');
  const [remoteEnabled, setRemoteEnabled] = useState(true);
  const [remoteStatus, setRemoteStatus] = useState<{ running: boolean; port: number; lanIp: string; tailscaleIp: string; error?: string } | null>(null);
  const [tailscale, setTailscale] = useState<{ installed: boolean; loggedIn: boolean; ip: string; hostname: string; detail: string } | null>(null);
  const [pairing, setPairing] = useState<{ code: string; qrDataUrl: string; expiresAt: string; lanIp: string; tailscaleIp: string; port: number } | null>(null);
  const [devices, setDevices] = useState<{ id: string; name: string; createdAt: string; lastSeenAt: string | null }[]>([]);
  const [tsBusy, setTsBusy] = useState(false);
  const [tsMsg, setTsMsg] = useState('');

  const refreshModels = async () => {
    const ml = await window.agent.models.list();
    setModelEntries(ml.entries);
    setSelectedModelId(ml.selectedId);
    setRemotePresets(ml.presets);
    setEncryptionAvailable(await window.agent.models.encryptionAvailable());
    const sel = ml.entries.find((e) => e.id === ml.selectedId);
    if (sel?.kind === 'remote') {
      setEditBaseUrl(sel.baseUrl ?? '');
      setEditModelName(sel.modelName ?? '');
      setRemoteKeySaved(await window.agent.models.hasApiKey(sel.id));
    } else {
      setRemoteKeySaved(false);
    }
  };

  const load = async () => {
    setThinking((await window.agent.settings.get('thinking', 'false')) === 'true');
    setOllama((await window.agent.settings.ollamaStatus()) as { available: boolean; models: string[] });
    setVoice((await window.agent.voice.status()) as { ready: boolean; detail: string });
    setRetention(await window.agent.settings.get('attachmentRetentionDays', '60'));
    await refreshModels();
    try {
      const s = (await window.agent.setup.getStatus()) as { ocr?: { ready: boolean; detail: string } };
      if (s.ocr) setOcr(s.ocr);
    } catch {
      // Setup status unavailable; leave OCR status blank.
    }
    setRemoteEnabled((await window.agent.settings.get('remoteEnabled', 'true')) !== 'false');
    setRemoteStatus((await window.agent.remote.status()) as { running: boolean; port: number; lanIp: string; tailscaleIp: string; error?: string });
    setTailscale((await window.agent.remote.tailscale()) as { installed: boolean; loggedIn: boolean; ip: string; hostname: string; detail: string });
    setDevices((await window.agent.remote.devices()) as { id: string; name: string; createdAt: string; lastSeenAt: string | null }[]);
    setDataFolder(await window.agent.settings.get('dataFolder', ''));
    const ps = await window.agent.projects.list();
    setProjects(ps);
    if (ps.length > 0 && !selectedProject) {
      setSelectedProject(ps[0].id);
      setPerms(JSON.stringify(ps[0].permissions, null, 2));
    }
  };

  useEffect(() => { load().catch(() => undefined); }, []);

  useEffect(() => {
    const p = projects.find((x) => x.id === selectedProject);
    if (p) setPerms(JSON.stringify(p.permissions, null, 2));
  }, [selectedProject]);

  const showModelsError = (e: unknown) => {
    setModelsMsg(e instanceof Error ? e.message : String(e));
  };

  const selectModelEntry = async (id: string) => {
    setModelsMsg('');
    try {
      await window.agent.models.select(id);
      await refreshModels();
    } catch (e) {
      showModelsError(e);
    }
  };

  const addLocalModel = async (tag?: string) => {
    setModelsMsg('');
    try {
      const entry = await window.agent.models.addLocal(tag ?? newLocalTag);
      setNewLocalTag('');
      setModelsMsg(`Added local model ${entry.label}.`);
      await refreshModels();
    } catch (e) {
      showModelsError(e);
    }
  };

  const addRemoteModel = async () => {
    setModelsMsg('');
    try {
      const entry = await window.agent.models.addRemote({
        label: newRemoteLabel,
        preset: newRemotePreset,
        baseUrl: newRemoteBaseUrl,
        modelName: newRemoteModelName,
      });
      setNewRemoteModelName('');
      setNewRemoteLabel('');
      setModelsMsg(`Added remote model ${entry.label}. Select it to add your API key.`);
      await refreshModels();
    } catch (e) {
      showModelsError(e);
    }
  };

  const removeModelEntry = async (id: string) => {
    setModelsMsg('');
    try {
      await window.agent.models.remove(id);
      await refreshModels();
    } catch (e) {
      showModelsError(e);
    }
  };

  const saveRemoteKey = async () => {
    setModelsMsg('');
    try {
      await window.agent.models.setApiKey(selectedModelId, remoteKey);
      setRemoteKey('');
      setRemoteKeySaved(true);
      setModelsMsg('API key saved (encrypted with the OS credential store).');
    } catch (e) {
      showModelsError(e);
    }
  };

  const saveRemoteConfig = async () => {
    setModelsMsg('');
    try {
      await window.agent.models.updateRemote(selectedModelId, { baseUrl: editBaseUrl, modelName: editModelName });
      setModelsMsg('Remote model updated.');
      await refreshModels();
    } catch (e) {
      showModelsError(e);
    }
  };

  const changeRemotePreset = (presetId: string) => {
    setNewRemotePreset(presetId);
    const preset = remotePresets.find((p) => p.id === presetId);
    setNewRemoteBaseUrl(preset?.baseUrl ?? '');
  };

  const saveThinking = async (value: boolean) => {
    setThinking(value);
    await window.agent.settings.set('thinking', value ? 'true' : 'false');
  };

  const saveRetention = async (value: string) => {
    setRetention(value);
    await window.agent.settings.set('attachmentRetentionDays', value);
  };

  const cleanupNow = async () => {
    setCleanupMsg('');
    const res = (await window.agent.attachments.cleanupNow()) as { deleted: number; freedBytes: number; skipped: boolean };
    setCleanupMsg(
      res.skipped
        ? 'Retention is set to Never, so nothing was deleted.'
        : res.deleted === 0
          ? 'Nothing to delete — no cached attachments are past the retention period.'
          : `Deleted ${res.deleted} cached attachment file(s), freed ${(res.freedBytes / 1024).toFixed(0)} KB.`,
    );
  };

  const installOcr = async () => {
    setOcrBusy(true);
    try {
      await window.agent.setup.installOcr();
      const s = (await window.agent.setup.getStatus()) as { ocr?: { ready: boolean; detail: string } };
      if (s.ocr) setOcr(s.ocr);
    } catch (e) {
      setOcr({ ready: false, detail: e instanceof Error ? e.message : String(e) });
    }
    setOcrBusy(false);
  };

  const newPairing = async () => {
    setPairing((await window.agent.remote.pairing()) as { code: string; qrDataUrl: string; expiresAt: string; lanIp: string; tailscaleIp: string; port: number });
  };

  const toggleRemote = async (enabled: boolean) => {
    setRemoteEnabled(enabled);
    setRemoteStatus((await window.agent.remote.setEnabled(enabled)) as { running: boolean; port: number; lanIp: string; tailscaleIp: string; error?: string });
  };

  const installTs = async () => {
    setTsBusy(true);
    setTsMsg('');
    try {
      setTsMsg(await window.agent.remote.installTailscale());
    } catch (e) {
      setTsMsg(e instanceof Error ? e.message : String(e));
    }
    setTsBusy(false);
    setTailscale((await window.agent.remote.tailscale()) as { installed: boolean; loggedIn: boolean; ip: string; hostname: string; detail: string });
  };

  const revokeDevice = async (id: string) => {
    await window.agent.remote.revoke(id);
    setDevices((await window.agent.remote.devices()) as { id: string; name: string; createdAt: string; lastSeenAt: string | null }[]);
  };

  const savePerms = async () => {
    try {
      const parsed = JSON.parse(perms) as Record<string, unknown>;
      await window.agent.projects.update(selectedProject, { permissions: parsed });
    } catch {
      // Invalid JSON; ignore.
    }
  };

  const selectedEntry = modelEntries.find((e) => e.id === selectedModelId) ?? null;
  const installedNotListed = (ollama?.models ?? []).filter(
    (tag) => !modelEntries.some((e) => e.kind === 'local' && e.ollamaTag === tag),
  );

  return (
    <div className="view">
      <h2>Settings</h2>
      <div className="card">
        <h3>Models</h3>
        <p>
          {ollama === null ? 'Checking Ollama…' : ollama.available
            ? `Ollama is running. Installed models: ${ollama.models.join(', ') || 'none'}.`
            : 'Ollama is not running. Start Ollama, or re-run the first-run setup.'}
        </p>
        <p className="muted">
          Pick which model answers your chats. Local models run on this PC (private, no API key).
          Remote models use your own API key with an OpenAI-compatible service.
          The default is local — remote is opt-in. Your pick applies to your next message.
        </p>
        {modelEntries.map((entry) => (
          <div key={entry.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 0', borderTop: '1px solid var(--hatch-widget-border)' }}>
            <div style={{ flex: 1 }}>
              <strong>{entry.label}</strong>{' '}
              <span className="muted">({entry.kind === 'local' ? 'Local' : 'Remote'})</span>
              <div className="muted">
                {entry.kind === 'local'
                  ? `Ollama · ${entry.ollamaTag ?? ''}`
                  : `Remote · ${entry.baseUrl ?? ''} · ${entry.modelName ?? ''}`}
              </div>
            </div>
            {entry.id === selectedModelId ? (
              <span><strong>Selected</strong></span>
            ) : (
              <button className="btn" onClick={() => void selectModelEntry(entry.id)}>Select</button>
            )}
            <button className="btn" onClick={() => void removeModelEntry(entry.id)}>Remove</button>
          </div>
        ))}
        <div style={{ marginTop: 12 }}>
          <div className="field"><label>Add a local model (Ollama tag)</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input value={newLocalTag} onChange={(e) => setNewLocalTag(e.target.value)} placeholder="qwen3:14b" style={{ flex: 1 }} />
              <button className="btn" onClick={() => void addLocalModel()}>Add local model</button>
            </div>
          </div>
          {installedNotListed.length > 0 && (
            <p className="muted">
              Installed in Ollama but not listed:{' '}
              {installedNotListed.map((tag) => (
                <button key={tag} className="btn" style={{ margin: '2px 4px 2px 0' }} onClick={() => void addLocalModel(tag)}>
                  Add {tag}
                </button>
              ))}
            </p>
          )}
        </div>
        <div style={{ marginTop: 12 }}>
          <div className="field"><label>Add a remote model (OpenAI-compatible API)</label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <select value={newRemotePreset} onChange={(e) => changeRemotePreset(e.target.value)}>
                {remotePresets.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
              <input
                value={newRemoteBaseUrl}
                onChange={(e) => setNewRemoteBaseUrl(e.target.value)}
                placeholder="https://api.openai.com/v1"
                disabled={newRemotePreset !== 'custom'}
                style={{ flex: 1, minWidth: 220 }}
              />
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <input value={newRemoteModelName} onChange={(e) => setNewRemoteModelName(e.target.value)} placeholder="Model name, e.g. gpt-4o" style={{ flex: 1 }} />
              <input value={newRemoteLabel} onChange={(e) => setNewRemoteLabel(e.target.value)} placeholder="Display name (optional)" style={{ flex: 1 }} />
              <button className="btn" onClick={() => void addRemoteModel()}>Add remote model</button>
            </div>
          </div>
          <p className="muted">Presets fill in the base URL for you. Choose Custom endpoint for any other OpenAI-compatible service (DeepSeek, OpenRouter, a self-hosted gateway).</p>
        </div>
        {selectedEntry?.kind === 'remote' && (
          <div style={{ marginTop: 12, borderTop: '1px solid var(--hatch-widget-border)', paddingTop: 12 }}>
            <h4>Selected remote model: {selectedEntry.label}</h4>
            <div className="field"><label>Base URL</label>
              <input value={editBaseUrl} onChange={(e) => setEditBaseUrl(e.target.value)} style={{ width: '100%' }} />
            </div>
            <div className="field"><label>Model name</label>
              <input value={editModelName} onChange={(e) => setEditModelName(e.target.value)} style={{ width: '100%' }} />
            </div>
            <button className="btn" onClick={() => void saveRemoteConfig()}>Save remote settings</button>
            <div className="field" style={{ marginTop: 12 }}><label>API key</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  type="password"
                  value={remoteKey}
                  onChange={(e) => setRemoteKey(e.target.value)}
                  placeholder={remoteKeySaved ? 'API key saved — enter a new one to replace it' : 'Paste your API key'}
                  style={{ flex: 1 }}
                  autoComplete="off"
                />
                <button className="btn primary" onClick={() => void saveRemoteKey()}>Save API key</button>
              </div>
            </div>
            <p className="muted">
              {remoteKeySaved ? 'API key: saved.' : 'API key: not set yet — chats with this model need one.'}
              {' '}Your key is encrypted with the OS credential store (Windows Credential Manager)
              and never stored as plain text. Remote models send your messages to the provider above.
            </p>
            {!encryptionAvailable && (
              <p><strong>OS encryption is not available on this machine, so an API key cannot be saved here.</strong></p>
            )}
          </div>
        )}
        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', margin: '12px 0 0' }}>
          <input type="checkbox" checked={thinking} onChange={(e) => void saveThinking(e.target.checked)} style={{ marginTop: 4 }} />
          <span>
            <strong>Thinking mode</strong>
            <div className="muted">When on, the model reasons step by step before answering (local Qwen3 models only). Slower, but better for hard questions. Off by default for faster replies.</div>
          </span>
        </label>
        {modelsMsg && <p>{modelsMsg}</p>}
        <p className="muted">Default: qwen3:8b-q8_0 (8-bit, about 8 GB VRAM). qwen3:14b with 4-bit quantization also fits a 12 GB card. Pull a model first with Ollama, then add it here.</p>
      </div>
      <div className="card">
        <h3>Voice</h3>
        <p>{voice === null ? 'Checking…' : voice.detail}</p>
        {!voice?.ready && (
          <button className="btn" onClick={async () => { await window.agent.setup.installVoice(); load(); }}>
            Install voice engine
          </button>
        )}
      </div>
      <div className="card">
        <h3>Phone access (companion app)</h3>
        <p className="muted">
          Pair your phone once at home by scanning the QR code. Afterwards the phone shows the same chats
          and gets a notification when a task finishes. Data stays on this PC. Away from home the phone
          reaches this PC over Tailscale — no fixed IP needed.
        </p>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '8px 0' }}>
          <input type="checkbox" checked={remoteEnabled} onChange={(e) => void toggleRemote(e.target.checked)} />
          <span>Enable phone access</span>
        </label>
        {remoteStatus && (
          <p>
            {remoteStatus.running
              ? `Phone-access server is running on port ${remoteStatus.port} (LAN ${remoteStatus.lanIp}).`
              : `Phone-access server is not running.${remoteStatus.error ? ` ${remoteStatus.error}` : ''}`}
          </p>
        )}
        <p>{tailscale === null ? 'Checking Tailscale…' : tailscale.detail}</p>
        {tailscale && !tailscale.installed && (
          <button className="btn" disabled={tsBusy} onClick={() => void installTs()}>
            {tsBusy ? 'Installing…' : 'Install Tailscale (for access away from home)'}
          </button>
        )}
        {tsMsg && <p>{tsMsg}</p>}
        <div style={{ marginTop: 12 }}>
          <button className="btn primary" onClick={() => void newPairing()}>Generate pairing code</button>
        </div>
        {pairing && (
          <div style={{ marginTop: 12 }}>
            <img src={pairing.qrDataUrl} alt="Pairing QR code" style={{ width: 200, height: 200 }} />
            <p>
              Pairing code: <strong>{pairing.code}</strong> (valid until{' '}
              {new Date(pairing.expiresAt).toLocaleTimeString()})
            </p>
            <p className="muted">On your phone, open the companion app and scan this code while on the same Wi-Fi.</p>
          </div>
        )}
        <h4 style={{ marginTop: 16 }}>Paired devices</h4>
        {devices.length === 0 ? (
          <p className="muted">No phones paired yet.</p>
        ) : (
          <ul>
            {devices.map((d) => (
              <li key={d.id}>
                {d.name} — paired {new Date(d.createdAt).toLocaleDateString()}
                {d.lastSeenAt ? `, last seen ${new Date(d.lastSeenAt).toLocaleString()}` : ', never connected'}{' '}
                <button className="btn" onClick={() => void revokeDevice(d.id)}>Revoke</button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="card">
        <h3>Email attachments</h3>
        <p className="muted">
          When the agent reads an email, it downloads the attachments (Word, PDF, Excel, images)
          to a temporary folder and reads their text — including printed text in images (OCR).
          Copies are deleted automatically after the retention period below, so they never pile
          up on disk. The original emails are never touched.
        </p>
        <div className="field"><label>Keep downloaded attachments for</label>
          <select value={retention} onChange={(e) => void saveRetention(e.target.value)}>
            <option value="30">30 days</option>
            <option value="60">60 days (default)</option>
            <option value="90">90 days</option>
            <option value="never">Never delete</option>
          </select>
        </div>
        <button className="btn" onClick={() => void cleanupNow()}>Clean up old attachments now</button>
        {cleanupMsg && <p>{cleanupMsg}</p>}
        <h4 style={{ marginTop: 16 }}>Image text recognition (OCR)</h4>
        <p>{ocr === null ? 'Checking…' : ocr.detail}</p>
        {!ocr?.ready && (
          <button className="btn" disabled={ocrBusy} onClick={() => void installOcr()}>
            {ocrBusy ? 'Downloading…' : 'Download OCR language data (English, about 5 MB)'}
          </button>
        )}
        <p className="muted">Without this, Word, PDF and Excel attachments still work — only images need OCR data.</p>
      </div>
      <div className="card">
        <h3>Data folder</h3>
        <p className="muted">{dataFolder || 'Default application data folder.'}</p>
        <button className="btn" onClick={() => window.agent.app.openDataFolder()}>Open data folder</button>
      </div>
      <div className="card">
        <h3>Per-project permissions</h3>
        <div className="field"><label>Project</label>
          <select value={selectedProject} onChange={(e) => setSelectedProject(e.target.value)}>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div className="field"><label>Permissions (JSON)</label>
          <textarea rows={10} value={perms} onChange={(e) => setPerms(e.target.value)} />
        </div>
        <p className="muted">
          allowedFolders limits which folders the agent may read/write in this project.
          canSendEmail, canBrowseWeb, canRunBrowser and canWriteFiles gate the matching tools.
          Outward actions still ask for approval every time.
        </p>
        <button className="btn primary" onClick={savePerms}>Save permissions</button>
      </div>
      <div className="card">
        <h3>Privacy</h3>
        <p className="muted">
          All data stays on this machine. No telemetry. No cloud LLM calls.
          The only network use is Ollama model downloads (setup), email (IMAP/SMTP),
          and web lookups you explicitly ask for.
        </p>
      </div>
    </div>
  );
}
