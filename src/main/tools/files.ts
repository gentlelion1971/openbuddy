// File tools: read/write/list plain text, PDF, DOCX and XLSX files.
// All paths are checked against the active project's permissions before any
// filesystem access. Writes additionally require canWriteFiles.
// All code, comments, log messages and docs in this project are English only.

import fs from 'node:fs';
import path from 'node:path';
// NOTE: pdf-parse is NOT statically imported here. It pulls in pdfjs-dist,
// whose legacy build runs `new DOMMatrix()` at module top-level and relies
// on @napi-rs/canvas to polyfill DOMMatrix. If that native prebuild is
// missing for the target platform (it was missing for win32 in v0.2.1, which
// crashed the whole main process at startup), a static import would kill
// the app before it opens. pdf-parse is therefore loaded lazily, only when
// a PDF is actually read, so a broken PDF stack can only fail that one
// extraction, never startup. See BUILD_STATUS.md v0.2.2.
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import { Document, Packer, Paragraph, TextRun } from 'docx';
import type { ToolContext, ToolDefinition, ToolResult } from './types.js';
import { recognizeImage } from './ocr.js';

const PDF_TEXT_LIMIT = 12_000;
const XLSX_MAX_ROWS = 200;

/** Extract text from PDF bytes (pdf-parse), truncated to ~12000 chars.
 *  Pure: no filesystem or permission checks, so email-attachment code can
 *  call it on bytes it downloaded itself. */
export async function extractPdfText(buffer: Buffer): Promise<string> {
  // Lazy import (see the note at the top of this file): if the PDF stack
  // cannot load on this machine, this throws here and the caller records a
  // per-file failure instead of the app dying at startup.
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    const text = (result.text ?? '').replace(/\s+/g, ' ').trim();
    return text.length > PDF_TEXT_LIMIT ? text.slice(0, PDF_TEXT_LIMIT) : text;
  } finally {
    await parser.destroy();
  }
}

/** Extract raw text from DOCX bytes (mammoth). Pure, see extractPdfText. */
export async function extractDocxText(buffer: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

/** Read the first sheet of XLSX bytes as arrays, max 200 rows.
 *  Pure, see extractPdfText. */
export function extractXlsxRows(buffer: Buffer): unknown[][] {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) return [];
  const sheet = workbook.Sheets[firstSheetName];
  if (!sheet) return [];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null });
  return rows.slice(0, XLSX_MAX_ROWS);
}

export interface DirEntry {
  name: string;
  isDir: boolean;
  size: number;
}

export interface XlsxSheetInput {
  name: string;
  rows: unknown[][];
}

/**
 * Enforce the path permission rule for a project:
 * - Main chat (projectId null): any path is allowed.
 * - Project: the path must sit inside one of permissions.allowedFolders
 *   (empty allowedFolders means no folder access at all).
 * - Writes additionally require permissions.canWriteFiles.
 * Returns an error message when denied, or null when allowed.
 */
export function checkPathAccess(
  targetPath: string,
  ctx: ToolContext,
  forWrite: boolean,
): string | null {
  if (ctx.projectId === null) return null;
  if (forWrite && !ctx.permissions.canWriteFiles) {
    return 'Writing files is not allowed for this project.';
  }
  const resolved = path.resolve(targetPath);
  const allowed = ctx.permissions.allowedFolders.some((folder) => {
    const base = path.resolve(folder);
    return resolved === base || resolved.startsWith(base + path.sep);
  });
  if (!allowed) {
    return `Path is outside the folders allowed for this project: ${targetPath}`;
  }
  return null;
}

function fail(error: unknown): ToolResult {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

function toStringArg(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function toSheets(value: unknown): XlsxSheetInput[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item) => ({
      name: typeof item.name === 'string' && item.name.length > 0 ? item.name : 'Sheet1',
      rows: Array.isArray(item.rows)
        ? (item.rows as unknown[]).filter((row): row is unknown[] => Array.isArray(row))
        : [],
    }));
}

async function ensureParentDir(filePath: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
}

export const fileService = {
  /** Read a file as UTF-8 text. */
  async readTextFile(p: string, ctx: ToolContext): Promise<string> {
    const denied = checkPathAccess(p, ctx, false);
    if (denied) throw new Error(denied);
    return fs.promises.readFile(p, 'utf8');
  },

  /** Write UTF-8 text to a file, creating parent folders as needed. */
  async writeTextFile(p: string, content: string, ctx: ToolContext): Promise<void> {
    const denied = checkPathAccess(p, ctx, true);
    if (denied) throw new Error(denied);
    await ensureParentDir(p);
    await fs.promises.writeFile(p, content, 'utf8');
  },

  /** List a directory's entries with type and size. */
  async listDir(p: string, ctx: ToolContext): Promise<DirEntry[]> {
    const denied = checkPathAccess(p, ctx, false);
    if (denied) throw new Error(denied);
    const entries = await fs.promises.readdir(p, { withFileTypes: true });
    const result: DirEntry[] = [];
    for (const entry of entries) {
      let size = 0;
      if (entry.isFile()) {
        try {
          size = (await fs.promises.stat(path.join(p, entry.name))).size;
        } catch {
          size = 0;
        }
      }
      result.push({ name: entry.name, isDir: entry.isDirectory(), size });
    }
    return result;
  },

  /** Extract text from a PDF file (pdf-parse), truncated to ~12000 chars. */
  async readPdf(p: string, ctx: ToolContext): Promise<string> {
    const denied = checkPathAccess(p, ctx, false);
    if (denied) throw new Error(denied);
    const buffer = await fs.promises.readFile(p);
    return extractPdfText(buffer);
  },

  /** Extract raw text from a DOCX file (mammoth). */
  async readDocx(p: string, ctx: ToolContext): Promise<string> {
    const denied = checkPathAccess(p, ctx, false);
    if (denied) throw new Error(denied);
    const buffer = await fs.promises.readFile(p);
    return extractDocxText(buffer);
  },

  /** Read the first sheet of an XLSX file as arrays, max 200 rows. */
  async readXlsx(p: string, ctx: ToolContext): Promise<unknown[][]> {
    const denied = checkPathAccess(p, ctx, false);
    if (denied) throw new Error(denied);
    const buffer = await fs.promises.readFile(p);
    return extractXlsxRows(buffer);
  },

  /** Create a DOCX file with one paragraph per string. */
  async createDocx(p: string, paragraphs: string[], ctx: ToolContext): Promise<void> {
    const denied = checkPathAccess(p, ctx, true);
    if (denied) throw new Error(denied);
    const doc = new Document({
      sections: [
        {
          children: paragraphs.map(
            (text) => new Paragraph({ children: [new TextRun(text)] }),
          ),
        },
      ],
    });
    const buffer = await Packer.toBuffer(doc);
    await ensureParentDir(p);
    await fs.promises.writeFile(p, buffer);
  },

  /** Create an XLSX file with the given sheets (each a list of row arrays). */
  async createXlsx(p: string, sheets: XlsxSheetInput[], ctx: ToolContext): Promise<void> {
    const denied = checkPathAccess(p, ctx, true);
    if (denied) throw new Error(denied);
    const workbook = XLSX.utils.book_new();
    const usedSheets = sheets.length > 0 ? sheets : [{ name: 'Sheet1', rows: [] }];
    for (const sheet of usedSheets) {
      const worksheet = XLSX.utils.aoa_to_sheet(sheet.rows);
      XLSX.utils.book_append_sheet(workbook, worksheet, sheet.name);
    }
    await ensureParentDir(p);
    XLSX.writeFile(workbook, p);
  },
};

export const filesTools: ToolDefinition[] = [
  {
    name: 'file_read',
    description: 'Read a text file and return its contents as UTF-8 text.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the file to read.' },
      },
      required: ['path'],
    },
    requiresConfirmation: false,
    handler: async (args, ctx) => {
      const p = toStringArg(args.path);
      if (!p) return { ok: false, error: 'A file path is required.' };
      try {
        const data = await fileService.readTextFile(p, ctx);
        return { ok: true, data };
      } catch (error) {
        return fail(error);
      }
    },
  },
  {
    name: 'file_write',
    description:
      'Write text to a file, creating parent folders as needed. For projects, the path must be inside an allowed folder.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the file to write.' },
        content: { type: 'string', description: 'Text content to write.' },
      },
      required: ['path', 'content'],
    },
    requiresConfirmation: false,
    handler: async (args, ctx) => {
      const p = toStringArg(args.path);
      if (!p) return { ok: false, error: 'A file path is required.' };
      try {
        await fileService.writeTextFile(p, toStringArg(args.content), ctx);
        return { ok: true, data: { path: p, written: true } };
      } catch (error) {
        return fail(error);
      }
    },
  },
  {
    name: 'file_list',
    description: 'List the entries of a directory with name, type and size.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the directory to list.' },
      },
      required: ['path'],
    },
    requiresConfirmation: false,
    handler: async (args, ctx) => {
      const p = toStringArg(args.path);
      if (!p) return { ok: false, error: 'A directory path is required.' };
      try {
        const data = await fileService.listDir(p, ctx);
        return { ok: true, data };
      } catch (error) {
        return fail(error);
      }
    },
  },
  {
    name: 'file_read_pdf',
    description: 'Extract the text of a PDF file (up to ~12000 characters).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the PDF file to read.' },
      },
      required: ['path'],
    },
    requiresConfirmation: false,
    handler: async (args, ctx) => {
      const p = toStringArg(args.path);
      if (!p) return { ok: false, error: 'A file path is required.' };
      try {
        const data = await fileService.readPdf(p, ctx);
        return { ok: true, data };
      } catch (error) {
        return fail(error);
      }
    },
  },
  {
    name: 'file_read_docx',
    description: 'Extract the raw text of a DOCX (Word) file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the DOCX file to read.' },
      },
      required: ['path'],
    },
    requiresConfirmation: false,
    handler: async (args, ctx) => {
      const p = toStringArg(args.path);
      if (!p) return { ok: false, error: 'A file path is required.' };
      try {
        const data = await fileService.readDocx(p, ctx);
        return { ok: true, data };
      } catch (error) {
        return fail(error);
      }
    },
  },
  {
    name: 'file_read_xlsx',
    description:
      'Read the first sheet of an XLSX (Excel) file as rows of cell values (max 200 rows).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the XLSX file to read.' },
      },
      required: ['path'],
    },
    requiresConfirmation: false,
    handler: async (args, ctx) => {
      const p = toStringArg(args.path);
      if (!p) return { ok: false, error: 'A file path is required.' };
      try {
        const data = await fileService.readXlsx(p, ctx);
        return { ok: true, data };
      } catch (error) {
        return fail(error);
      }
    },
  },
  {
    name: 'file_read_image',
    description:
      'Extract the printed text of an image file (PNG/JPG) with local OCR. Returns the text plus a confidence score (0-100). Needs the OCR language data, downloaded once in Settings (Email attachments) or during first-run setup.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the image file to read.' },
      },
      required: ['path'],
    },
    requiresConfirmation: false,
    handler: async (args, ctx) => {
      const p = toStringArg(args.path);
      if (!p) return { ok: false, error: 'A file path is required.' };
      const denied = checkPathAccess(p, ctx, false);
      if (denied) return { ok: false, error: denied };
      try {
        const data = await recognizeImage(p);
        return { ok: true, data };
      } catch (error) {
        return fail(error);
      }
    },
  },
  {
    name: 'file_create_docx',
    description: 'Create a DOCX (Word) file with one paragraph per given string.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the DOCX file to create.' },
        paragraphs: {
          type: 'array',
          description: 'Paragraph texts, one per array item.',
          items: { type: 'string' },
        },
      },
      required: ['path', 'paragraphs'],
    },
    requiresConfirmation: false,
    handler: async (args, ctx) => {
      const p = toStringArg(args.path);
      if (!p) return { ok: false, error: 'A file path is required.' };
      try {
        await fileService.createDocx(p, toStringArray(args.paragraphs), ctx);
        return { ok: true, data: { path: p, created: true } };
      } catch (error) {
        return fail(error);
      }
    },
  },
  {
    name: 'file_create_xlsx',
    description: 'Create an XLSX (Excel) file with the given sheets, each a list of row arrays.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the XLSX file to create.' },
        sheets: {
          type: 'array',
          description: 'Sheets to create, each with a name and rows.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Sheet name.' },
              rows: {
                type: 'array',
                description: 'Rows, each an array of cell values.',
                items: { type: 'array', items: {} },
              },
            },
            required: ['name', 'rows'],
          },
        },
      },
      required: ['path', 'sheets'],
    },
    requiresConfirmation: false,
    handler: async (args, ctx) => {
      const p = toStringArg(args.path);
      if (!p) return { ok: false, error: 'A file path is required.' };
      try {
        await fileService.createXlsx(p, toSheets(args.sheets), ctx);
        return { ok: true, data: { path: p, created: true } };
      } catch (error) {
        return fail(error);
      }
    },
  },
];
