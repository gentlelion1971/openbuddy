// First-run setup wizard backend.
// Checks for Ollama, downloads and launches the Ollama installer when missing,
// pulls the default model with progress, and installs the voice sidecar
// (embeddable Python + faster-whisper + Piper) with one click.
// The user never installs Python or packages by hand.
// All code, comments, log messages and docs in this project are English only.

import { app } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { createWriteStream } from 'node:fs';

export const OLLAMA_INSTALLER_URL = 'https://ollama.com/download/OllamaSetup.exe';
export const DEFAULT_MODEL = 'qwen3:8b-q8_0';
export const PYTHON_EMBED_URL =
  'https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip';
export const GET_PIP_URL = 'https://bootstrap.pypa.io/get-pip.py';
/** English OCR language data (tesseract fast model, ~5 MB). Downloaded once
 *  during setup (or later in Settings) so image text recognition works offline. */
export const OCR_DATA_URL =
  'https://github.com/tesseract-ocr/tessdata_fast/raw/main/eng.traineddata';
export const OCR_LANG_FILE = 'eng.traineddata';

export const PIPER_VOICES = [
  {
    id: 'zh_CN-huayan-medium',
    label: 'Chinese (Huayan, medium)',
    onnx: 'https://huggingface.co/rhasspy/piper-voices/resolve/main/zh/zh_CN/huayan/medium/zh_CN-huayan-medium.onnx',
    json: 'https://huggingface.co/rhasspy/piper-voices/resolve/main/zh/zh_CN/huayan/medium/zh_CN-huayan-medium.onnx.json',
  },
  {
    id: 'en_US-lessac-medium',
    label: 'English (Lessac, medium)',
    onnx: 'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx',
    json: 'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json',
  },
];

export interface SetupProgress {
  stage: string;
  detail: string;
  /** 0..1 when a download/pull reports progress, otherwise null. */
  progress: number | null;
}

export interface OllamaStatus {
  available: boolean;
  models: string[];
  baseUrl: string;
}

export function ollamaBaseUrl(): string {
  return process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
}

export async function checkOllama(): Promise<OllamaStatus> {
  const baseUrl = ollamaBaseUrl();
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { available: false, models: [], baseUrl };
    const data = (await res.json()) as { models?: { name: string }[] };
    return { available: true, models: (data.models ?? []).map((m) => m.name), baseUrl };
  } catch {
    return { available: false, models: [], baseUrl };
  }
}

async function downloadFile(url: string, destPath: string, onProgress: (p: SetupProgress) => void, stage: string): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}): ${url}`);
  const total = Number(res.headers.get('content-length') || 0);
  let done = 0;
  const fileStream = createWriteStream(destPath);
  const progressStream = new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: (err?: Error | null, data?: unknown) => void) {
      done += chunk.byteLength;
      if (total > 0) {
        onProgress({ stage, detail: `${(done / 1024 / 1024).toFixed(1)} MB of ${(total / 1024 / 1024).toFixed(1)} MB`, progress: done / total });
      }
      callback(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body as unknown as Parameters<typeof Readable.fromWeb>[0]), progressStream, fileStream);
}

/** Download the Ollama Windows installer to a temp file and launch it.
 *  The installer itself is a GUI the user clicks through; afterwards the
 *  wizard polls until Ollama answers. */
export async function installOllama(onProgress: (p: SetupProgress) => void): Promise<string> {
  const dest = path.join(os.tmpdir(), 'OllamaSetup.exe');
  onProgress({ stage: 'ollama', detail: 'Downloading Ollama installer…', progress: null });
  await downloadFile(OLLAMA_INSTALLER_URL, dest, onProgress, 'ollama');
  onProgress({ stage: 'ollama', detail: 'Launching the Ollama installer. Please complete it, then return here.', progress: 1 });
  const child = spawn(dest, [], { detached: true, stdio: 'ignore' });
  child.unref();
  return dest;
}

/** Poll until Ollama answers or the timeout expires. */
export async function waitForOllama(timeoutMs = 180_000, onProgress?: (p: SetupProgress) => void): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await checkOllama();
    if (status.available) return true;
    onProgress?.({ stage: 'ollama', detail: 'Waiting for Ollama to start…', progress: null });
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

/** Pull a model from Ollama with streaming progress. */
export async function pullModel(model: string, onProgress: (p: SetupProgress) => void): Promise<void> {
  const res = await fetch(`${ollamaBaseUrl()}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: model, stream: true }),
  });
  if (!res.ok || !res.body) throw new Error(`Model pull failed (${res.status}): ${model}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line) as { status?: string; total?: number; completed?: number };
        const pct = evt.total ? evt.completed ?? 0 : 0;
        onProgress({
          stage: 'model',
          detail: evt.status ?? 'Pulling model…',
          progress: evt.total ? pct / evt.total : null,
        });
      } catch {
        // Ignore malformed progress lines.
      }
    }
  }
  const status = await checkOllama();
  if (!status.models.some((m) => m === model || m.startsWith(`${model}:`))) {
    throw new Error(`Model ${model} was not found after pulling.`);
  }
}

// ---- Voice sidecar ----

export function voiceDataDir(): string {
  return path.join(app.getPath('userData'), 'voice');
}

export function voicePythonDir(): string {
  return path.join(voiceDataDir(), 'python');
}

/** Path of a prebuilt frozen sidecar exe, when the installer bundled one. */
export function bundledSidecarExe(): string | null {
  const candidates = [
    path.join(process.resourcesPath, 'python', 'voice-sidecar.exe'),
    path.join(app.getAppPath(), 'python', 'voice-sidecar.exe'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

export function sidecarEntryPoint(): { kind: 'exe' | 'python'; path: string } | null {
  const exe = bundledSidecarExe();
  if (exe) return { kind: 'exe', path: exe };
  const script = path.join(app.getAppPath(), 'python', 'sidecar', 'voice.py');
  const pythonExe = path.join(voicePythonDir(), 'python.exe');
  if (fs.existsSync(script) && fs.existsSync(pythonExe)) return { kind: 'python', path: script };
  return null;
}

export interface VoiceStatus {
  ready: boolean;
  mode: 'bundled-exe' | 'embeddable-python' | 'missing';
  detail: string;
}

export function checkVoice(): VoiceStatus {
  const entry = sidecarEntryPoint();
  if (!entry) return { ready: false, mode: 'missing', detail: 'Voice sidecar is not installed yet.' };
  if (entry.kind === 'exe') return { ready: true, mode: 'bundled-exe', detail: 'Bundled voice engine is ready.' };
  return { ready: true, mode: 'embeddable-python', detail: 'Voice engine is installed.' };
}

function runCommand(cmd: string, args: string[], cwd: string, onProgress: (p: SetupProgress) => void, stage: string, detail: string): Promise<void> {
  return new Promise((resolve, reject) => {
    onProgress({ stage, detail, progress: null });
    const child = spawn(cmd, args, { cwd, stdio: 'ignore', windowsHide: true });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`));
    });
  });
}

/** One-click voice install: embeddable Python + pip + faster-whisper + Piper,
 *  plus the two Piper voice models. Runs entirely in the app data folder. */
export async function installVoice(onProgress: (p: SetupProgress) => void): Promise<void> {
  const dataDir = voiceDataDir();
  const pyDir = voicePythonDir();
  const modelsDir = path.join(dataDir, 'models');
  fs.mkdirSync(modelsDir, { recursive: true });

  // 1. Embeddable Python.
  const zipPath = path.join(os.tmpdir(), 'python-embed.zip');
  if (!fs.existsSync(path.join(pyDir, 'python.exe'))) {
    onProgress({ stage: 'voice', detail: 'Downloading portable Python…', progress: null });
    await downloadFile(PYTHON_EMBED_URL, zipPath, onProgress, 'voice');
    onProgress({ stage: 'voice', detail: 'Extracting portable Python…', progress: null });
    fs.mkdirSync(pyDir, { recursive: true });
    await runCommand('powershell', ['-NoProfile', '-Command', `Expand-Archive -Path '${zipPath}' -DestinationPath '${pyDir}' -Force`], dataDir, onProgress, 'voice', 'Extracting portable Python…');
    // Enable site-packages in the embeddable build (needed for pip).
    const pth = path.join(pyDir, 'python312._pth');
    if (fs.existsSync(pth)) {
      const text = fs.readFileSync(pth, 'utf8');
      fs.writeFileSync(pth, text.replace('#import site', 'import site'));
    }
  }

  const pythonExe = path.join(pyDir, 'python.exe');
  // 2. pip.
  const getPip = path.join(pyDir, 'get-pip.py');
  if (!fs.existsSync(path.join(pyDir, 'Scripts', 'pip.exe'))) {
    await downloadFile(GET_PIP_URL, getPip, onProgress, 'voice');
    await runCommand(pythonExe, [getPip], pyDir, onProgress, 'voice', 'Installing pip…');
  }
  // 3. Voice packages.
  await runCommand(
    pythonExe,
    ['-m', 'pip', 'install', '--no-warn-script-location', '--disable-pip-version-check', 'faster-whisper', 'piper-tts'],
    pyDir, onProgress, 'voice', 'Installing voice packages (faster-whisper, Piper)…',
  );
  // 4. Piper voice models.
  for (const voice of PIPER_VOICES) {
    for (const [url, name] of [[voice.onnx, `${voice.id}.onnx`], [voice.json, `${voice.id}.onnx.json`]] as const) {
      const dest = path.join(modelsDir, name);
      if (!fs.existsSync(dest)) {
        await downloadFile(url, dest, onProgress, 'voice');
      }
    }
  }
  onProgress({ stage: 'voice', detail: 'Voice engine installed.', progress: 1 });
}

export interface SetupStatus {
  ollama: OllamaStatus;
  voice: VoiceStatus;
  ocr: OcrStatus;
  setupComplete: boolean;
}

export interface OcrStatus {
  ready: boolean;
  detail: string;
}

/** Folder holding the OCR language data (eng.traineddata). */
export function ocrDataDir(): string {
  return path.join(app.getPath('userData'), 'ocr');
}

/** Whether the English OCR language data is present on disk. */
export function checkOcr(): OcrStatus {
  const file = path.join(ocrDataDir(), OCR_LANG_FILE);
  if (fs.existsSync(file)) {
    return { ready: true, detail: 'OCR language data is installed (English).' };
  }
  return { ready: false, detail: 'OCR language data is not downloaded yet.' };
}

/** Download the English OCR language data once (about 5 MB). After this,
 *  image text recognition works fully offline. */
export async function installOcrData(onProgress: (p: SetupProgress) => void): Promise<void> {
  const dir = ocrDataDir();
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, OCR_LANG_FILE);
  if (fs.existsSync(dest)) {
    onProgress({ stage: 'ocr', detail: 'OCR language data is already installed.', progress: 1 });
    return;
  }
  onProgress({ stage: 'ocr', detail: 'Downloading OCR language data (English, about 5 MB)…', progress: null });
  await downloadFile(OCR_DATA_URL, dest, onProgress, 'ocr');
  onProgress({ stage: 'ocr', detail: 'OCR language data installed.', progress: 1 });
}

export async function getSetupStatus(setupComplete: boolean): Promise<SetupStatus> {
  return { ollama: await checkOllama(), voice: checkVoice(), ocr: checkOcr(), setupComplete };
}
