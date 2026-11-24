// Email attachment handling: temporary storage, text extraction, cleanup.
// Attachments the app downloads are COPIES in a temporary folder under the
// app data dir. They are deleted automatically after the retention period
// (default 60 days, configurable in Settings as 30 / 60 / 90 days or never)
// so they never pile up on disk. The original email is never touched, and
// cleanup only ever deletes files inside the attachments folder.
// All code, comments, log messages and docs in this project are English only.

import fs from 'node:fs';
import path from 'node:path';
import * as store from '../store.js';
import { extractDocxText, extractPdfText, extractXlsxRows } from './files.js';
import { recognizeImage } from './ocr.js';

/** Maximum size of one downloaded attachment (25 MB). */
export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
/** Maximum extracted text kept per attachment. */
export const ATTACHMENT_TEXT_CHARS = 6000;
/** Default retention for cached attachments, in days. */
export const DEFAULT_RETENTION_DAYS = 60;
/** Settings key holding the retention choice ('30' | '60' | '90' | 'never'). */
export const RETENTION_SETTING_KEY = 'attachmentRetentionDays';

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.tif', '.tiff']);
export { IMAGE_EXTS };
const TEXT_EXTS = new Set(['.txt', '.csv', '.md', '.html', '.htm']);
const WINDOWS_RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

/** Temporary folder for downloaded attachment copies, under the app data dir. */
export function attachmentsDir(): string {
  return path.join(store.getDataDir(), 'attachments');
}

export type RetentionSetting = 30 | 60 | 90 | 'never';

/** Retention choice from Settings, defaulting to 60 days. */
export function getRetention(): RetentionSetting {
  const raw = store.getSetting(RETENTION_SETTING_KEY, String(DEFAULT_RETENTION_DAYS));
  if (raw === 'never') return 'never';
  const days = Number(raw);
  if (days === 30 || days === 60 || days === 90) return days;
  return DEFAULT_RETENTION_DAYS;
}

export interface CleanupResult {
  deleted: number;
  freedBytes: number;
  /** True when retention is "never", so nothing was deleted. */
  skipped: boolean;
}

/**
 * Delete cached attachment files older than the retention period, and
 * remove message folders left empty afterwards. Only files inside the
 * attachments temp folder are ever deleted.
 */
export function cleanupAttachments(now = new Date()): CleanupResult {
  const retention = getRetention();
  if (retention === 'never') return { deleted: 0, freedBytes: 0, skipped: true };
  const dir = attachmentsDir();
  if (!fs.existsSync(dir)) return { deleted: 0, freedBytes: 0, skipped: false };
  const cutoff = now.getTime() - retention * 24 * 60 * 60 * 1000;
  let deleted = 0;
  let freedBytes = 0;
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        try {
          if (fs.readdirSync(full).length === 0) fs.rmdirSync(full);
        } catch {
          // Ignore: another file may have appeared, or permissions.
        }
      } else if (entry.isFile()) {
        try {
          const stat = fs.statSync(full);
          if (stat.mtimeMs < cutoff) {
            fs.unlinkSync(full);
            deleted += 1;
            freedBytes += stat.size;
          }
        } catch {
          // Ignore unreadable entries.
        }
      }
    }
  };
  walk(dir);
  return { deleted, freedBytes, skipped: false };
}

/**
 * Make an attachment filename safe to write on Windows: strip directories,
 * replace illegal characters, drop trailing dots/spaces, avoid reserved
 * device names, and cap the length. Never returns an empty string.
 */
export function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  let clean = base.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
  clean = clean.replace(/[. ]+$/, '');
  if (!clean) clean = 'attachment';
  const ext = path.extname(clean).slice(0, 20);
  let stem = clean.slice(0, clean.length - path.extname(clean).length);
  if (WINDOWS_RESERVED.has(stem.toUpperCase())) stem = `_${stem}`;
  if (stem.length > 100) stem = stem.slice(0, 100);
  return stem + ext;
}

/** Path for a downloaded attachment, unique within its message folder. */
export function uniqueAttachmentPath(uid: number, filename: string): string {
  const dir = path.join(attachmentsDir(), String(uid));
  fs.mkdirSync(dir, { recursive: true });
  const safe = safeFilename(filename);
  const ext = path.extname(safe);
  const stem = safe.slice(0, safe.length - ext.length);
  let candidate = path.join(dir, safe);
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${stem} (${n})${ext}`);
    n += 1;
  }
  return candidate;
}

export type ExtractMethod = 'pdf' | 'docx' | 'xlsx' | 'text' | 'ocr' | 'unsupported';

export interface ExtractedAttachmentText {
  text: string;
  truncated: boolean;
  method: ExtractMethod;
  /** OCR confidence (0-100) when method is 'ocr'. */
  confidence?: number;
}

function finish(text: string, method: ExtractMethod, confidence?: number): ExtractedAttachmentText {
  const clean = text.replace(/\s+/g, ' ').trim();
  const result: ExtractedAttachmentText = {
    text: clean.length > ATTACHMENT_TEXT_CHARS ? clean.slice(0, ATTACHMENT_TEXT_CHARS) : clean,
    truncated: clean.length > ATTACHMENT_TEXT_CHARS,
    method,
  };
  if (confidence !== undefined) result.confidence = confidence;
  return result;
}

/**
 * Extract readable text from a downloaded attachment file, dispatching on
 * extension/MIME type: PDF, DOCX, XLSX/XLS, plain text, and images (OCR).
 * Legacy .doc and other formats return method 'unsupported' with empty text.
 */
export async function extractAttachmentText(
  filePath: string,
  mimeType: string,
): Promise<ExtractedAttachmentText> {
  const ext = path.extname(filePath).toLowerCase();
  const mime = mimeType.toLowerCase();
  const buffer = await fs.promises.readFile(filePath);
  if (ext === '.pdf' || mime === 'application/pdf') {
    return finish(await extractPdfText(buffer), 'pdf');
  }
  if (
    ext === '.docx' ||
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    return finish(await extractDocxText(buffer), 'docx');
  }
  if (
    ext === '.xlsx' ||
    ext === '.xls' ||
    mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    mime === 'application/vnd.ms-excel'
  ) {
    const rows = extractXlsxRows(buffer);
    const lines = rows.map((row) =>
      row.map((cell) => (cell === null || cell === undefined ? '' : String(cell))).join(' | '),
    );
    const text = lines.join('\n');
    return {
      text: text.length > ATTACHMENT_TEXT_CHARS ? text.slice(0, ATTACHMENT_TEXT_CHARS) : text,
      truncated: text.length > ATTACHMENT_TEXT_CHARS,
      method: 'xlsx',
    };
  }
  if (TEXT_EXTS.has(ext) || mime.startsWith('text/')) {
    return finish(buffer.toString('utf8'), 'text');
  }
  if (IMAGE_EXTS.has(ext) || mime.startsWith('image/')) {
    const { text, confidence } = await recognizeImage(filePath);
    return finish(text, 'ocr', confidence);
  }
  return { text: '', truncated: false, method: 'unsupported' };
}
