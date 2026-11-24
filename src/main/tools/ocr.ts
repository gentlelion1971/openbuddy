// OCR for image files (tesseract.js, pure JS/WASM, runs fully locally).
// Reads printed text out of PNG/JPG images, e.g. a photo of a swim schedule
// or a scanned school letter attached to an email. No cloud, no uploads.
// The English language data (eng.traineddata, ~5 MB) is downloaded once
// during first-run setup (or later in Settings) and stored under the app
// data folder; after that OCR works offline.
// All code, comments, log messages and docs in this project are English only.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createWorker } from 'tesseract.js';
import type { Worker } from 'tesseract.js';
import * as store from '../store.js';

export const OCR_LANG = 'eng';
/** Maximum OCR text returned for one image. */
export const OCR_TEXT_LIMIT = 6000;
/** Per-image OCR time budget; a stuck worker is dropped and recreated. */
const OCR_TIMEOUT_MS = 120_000;

/** Folder holding the OCR language data (eng.traineddata). */
export function ocrDataDir(): string {
  return path.join(store.getDataDir(), 'ocr');
}

/** True when the English OCR language data is present on disk. */
export function ocrDataReady(): boolean {
  try {
    return fs.existsSync(path.join(ocrDataDir(), `${OCR_LANG}.traineddata`));
  } catch {
    return false;
  }
}

/**
 * Resolve the tesseract.js node worker script to a real filesystem path.
 * In a packaged Electron app the package lives inside app.asar, but
 * worker_threads cannot load a script from inside an asar archive, so
 * electron-builder unpacks tesseract.js (see asarUnpack) and the path is
 * rewritten to app.asar.unpacked. Returns undefined when the script cannot
 * be found, in which case tesseract.js falls back to its default lookup.
 */
function resolveWorkerPath(): string | undefined {
  try {
    const req = createRequire(import.meta.url);
    const pkgJson = req.resolve('tesseract.js/package.json');
    let workerPath = path.join(
      path.dirname(pkgJson),
      'src',
      'worker-script',
      'node',
      'index.js',
    );
    const asar = `app.asar${path.sep}`;
    if (workerPath.includes(asar)) {
      workerPath = workerPath.replace(asar, `app.asar.unpacked${path.sep}`);
    }
    return fs.existsSync(workerPath) ? workerPath : undefined;
  } catch {
    return undefined;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

let cachedWorker: Worker | null = null;

/** Lazily create (and reuse) one OCR worker. The worker loads the WASM
 *  core and the English language data once, then stays warm for later
 *  images in the same session. */
async function getWorker(): Promise<Worker> {
  if (cachedWorker) return cachedWorker;
  if (!ocrDataReady()) {
    throw new Error(
      'OCR language data is not downloaded yet. Download it in Settings (Email attachments) ' +
        'or run the first-run setup again — it needs internet once, then works offline.',
    );
  }
  const options: { langPath: string; gzip: boolean; workerPath?: string } = {
    langPath: ocrDataDir(),
    gzip: false,
  };
  const workerPath = resolveWorkerPath();
  if (workerPath) options.workerPath = workerPath;
  cachedWorker = await createWorker(OCR_LANG, undefined, options);
  return cachedWorker;
}

/** Extract the printed text of an image file, plus tesseract's confidence
 *  (0-100). Text is whitespace-collapsed and truncated to OCR_TEXT_LIMIT. */
export async function recognizeImage(imagePath: string): Promise<{ text: string; confidence: number }> {
  const worker = await getWorker().catch((error: unknown) => {
    cachedWorker = null;
    throw error;
  });
  try {
    const result = await withTimeout(
      worker.recognize(imagePath),
      OCR_TIMEOUT_MS,
      'OCR timed out after 120 seconds.',
    );
    const raw = (result.data.text ?? '').replace(/\s+/g, ' ').trim();
    return {
      text: raw.length > OCR_TEXT_LIMIT ? raw.slice(0, OCR_TEXT_LIMIT) : raw,
      confidence: result.data.confidence ?? 0,
    };
  } catch (error) {
    // A failed worker is unusable afterwards; drop it so the next call
    // starts fresh instead of failing the same way.
    try {
      await worker.terminate();
    } catch {
      // Ignore termination errors.
    }
    cachedWorker = null;
    throw error;
  }
}

/** Shut the cached OCR worker down (called on app quit). */
export async function terminateOcr(): Promise<void> {
  if (cachedWorker) {
    try {
      await cachedWorker.terminate();
    } catch {
      // Ignore termination errors.
    }
    cachedWorker = null;
  }
}
