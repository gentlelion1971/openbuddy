// Voice sidecar manager: spawns the Python sidecar (frozen exe or embeddable
// Python) and speaks the newline-delimited JSON protocol over stdio.
// Requests are sequential: one request at a time, one response line each.
// All code, comments, log messages and docs in this project are English only.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { sidecarEntryPoint, voiceDataDir } from './setup.js';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

export class VoiceSidecar {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private queue: PendingRequest[] = [];
  private starting: Promise<void> | null = null;

  /** Start the sidecar if it is not already running. */
  start(): Promise<void> {
    if (this.child) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const entry = sidecarEntryPoint();
      if (!entry) throw new Error('Voice engine is not installed. Install it from Settings or the setup wizard.');
      const dataDir = voiceDataDir();
      fs.mkdirSync(dataDir, { recursive: true });
      const env = { ...process.env, VOICE_DATA_DIR: dataDir };
      if (entry.kind === 'exe') {
        this.child = spawn(entry.path, [], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      } else {
        const pythonExe = path.join(dataDir, 'python', 'python.exe');
        this.child = spawn(pythonExe, [entry.path], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      }
      this.child.stdout.setEncoding('utf8');
      this.child.stdout.on('data', (chunk: string) => this.onData(chunk));
      this.child.stderr.on('data', (chunk: Buffer) => {
        // Sidecar logs go to stderr; keep them out of the protocol stream.
        console.error(`[voice] ${chunk.toString().trim()}`);
      });
      this.child.on('exit', () => {
        this.child = null;
        this.starting = null;
        const err = new Error('Voice engine exited.');
        while (this.queue.length > 0) this.queue.shift()!.reject(err);
      });
      // Confirm the sidecar answers before reporting ready.
      const pong = (await this.request({ type: 'ping' })) as { type?: string };
      if (pong.type !== 'pong') throw new Error('Voice engine did not answer the ping.');
    })();
    return this.starting;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      const pending = this.queue.shift();
      if (!pending) continue;
      try {
        const msg = JSON.parse(line) as { type?: string; message?: string };
        if (msg.type === 'error') pending.reject(new Error(msg.message ?? 'Voice engine error.'));
        else pending.resolve(msg);
      } catch (e) {
        pending.reject(e instanceof Error ? e : new Error(String(e)));
      }
    }
  }

  private request(payload: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.child || !this.child.stdin.writable) {
        reject(new Error('Voice engine is not running.'));
        return;
      }
      this.queue.push({ resolve, reject });
      this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  /** Transcribe an audio file to text. */
  async transcribe(audioPath: string, model = 'tiny'): Promise<string> {
    await this.start();
    const res = (await this.request({ type: 'transcribe', audioPath, model })) as {
      type?: string;
      text?: string;
    };
    return res.text ?? '';
  }

  /** Synthesize speech to a wav file. Returns the wav path. */
  async speak(text: string, voice = 'zh_CN-huayan-medium'): Promise<string> {
    await this.start();
    const outPath = path.join(voiceDataDir(), `tts-${Date.now()}.wav`);
    const res = (await this.request({ type: 'speak', text, voice, outPath })) as {
      type?: string;
      audioPath?: string;
    };
    return res.audioPath ?? outPath;
  }

  stop(): void {
    if (!this.child) return;
    try {
      this.child.stdin.write('{"type":"shutdown"}\n');
    } catch {
      // Ignore write errors on shutdown.
    }
    this.child.kill();
    this.child = null;
    this.starting = null;
  }
}
