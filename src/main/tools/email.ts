// Email tools and service (IMAP read via imapflow, SMTP send via nodemailer).
// Connections are short-lived: every call opens its own IMAP connection and
// closes it before returning. Passwords are never logged.
// All code, comments, log messages and docs in this project are English only.

import imapflow from 'imapflow';
import type { ImapFlow } from 'imapflow';

// imapflow is a CommonJS module: use the default import instead of a
// named import, which Node's ESM loader cannot always resolve from CJS
// (same startup crash as tesseract.js in ocr.ts).
const { ImapFlow: ImapFlowClass } = imapflow;
import nodemailer from 'nodemailer';
import fs from 'node:fs';
import path from 'node:path';
import { getSecret } from '../credentials.js';
import { listAccounts as storeListAccounts, type AccountRow } from '../store.js';
import {
  ATTACHMENT_MAX_BYTES,
  IMAGE_EXTS,
  cleanupAttachments,
  extractAttachmentText,
  uniqueAttachmentPath,
  type ExtractMethod,
} from './attachments.js';
import type { ToolContext, ToolDefinition, ToolResult } from './types.js';

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export interface PublicAccount {
  id: string;
  label: string;
  kind: 'imap' | 'smtp' | 'graph';
  host: string;
  port: number;
  secure: number;
  username: string;
}

export interface AttachmentInfo {
  /** IMAP body part id, e.g. "2". Passed to email_download_attachment. */
  part: string;
  filename: string;
  mimeType: string;
  /** Decoded size in bytes, when the server reports it (0 when unknown). */
  size: number;
}

/** One attachment that was downloaded and read with its message. */
export interface AttachmentReadResult extends AttachmentInfo {
  /** Local temp copy, under the app data dir attachments folder. */
  savedPath: string;
  /** Extracted text (truncated). Empty when unsupported or extraction failed. */
  text: string;
  truncated: boolean;
  method: ExtractMethod;
  /** OCR confidence (0-100) when method is 'ocr'. */
  confidence?: number;
  /** Why the attachment could not be read, when text is empty. */
  error?: string;
}

export interface InboxMessage {
  uid: number;
  from: string;
  subject: string;
  date: string;
  snippet: string;
  seen: boolean;
  attachments: AttachmentInfo[];
}

export interface FullMessage {
  uid: number;
  subject: string;
  from: string;
  to: string;
  date: string;
  body: string;
  html?: string;
  attachments: AttachmentInfo[];
  attachmentTexts: AttachmentReadResult[];
}

export interface EmailDraft {
  to: string;
  subject: string;
  body: string;
  cc?: string;
}

export interface EmailDigest {
  unreadCount: number;
  digest: string;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const DEFAULT_IMAP_PORT = 993;
const MAX_DIGEST_CHARS = 4000;
const SNIPPET_CHARS = 160;
/** Max attachments auto-read with one message (email_read and digest). */
const MAX_AUTO_READ_ATTACHMENTS = 5;
/** Max image attachments OCRed per digest (OCR is slow on CPU). */
const DIGEST_MAX_OCR_IMAGES = 2;
/** Excerpt length for attachment text inside the digest. */
const DIGEST_ATTACHMENT_EXCERPT_CHARS = 600;

function findAccount(accountId: string): AccountRow {
  const account = storeListAccounts().find((a) => a.id === accountId);
  if (!account) throw new Error(`Email account not found: ${accountId}`);
  return account;
}

function formatAddress(entry: { name?: string; address?: string } | undefined): string {
  if (!entry) return '';
  if (entry.name && entry.address) return `${entry.name} <${entry.address}>`;
  return entry.address ?? entry.name ?? '';
}

function formatAddressList(list: Array<{ name?: string; address?: string }> | undefined): string {
  if (!list || list.length === 0) return '';
  return list.map(formatAddress).filter(Boolean).join(', ');
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function makeSnippet(text: string): string {
  const clean = collapseWhitespace(text);
  return clean.length > SNIPPET_CHARS ? `${clean.slice(0, SNIPPET_CHARS)}...` : clean;
}

function stripHtml(html: string): string {
  return collapseWhitespace(
    html
      .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'"),
  );
}

/** Decode a quoted-printable body to raw bytes. */
function decodeQuotedPrintable(buf: Buffer): Buffer {
  const out: number[] = [];
  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i];
    if (byte === 0x3d) {
      // '=' - soft line break or =XX hex escape.
      const next = buf[i + 1];
      if (next === 0x0d && buf[i + 2] === 0x0a) {
        i += 2;
        continue;
      }
      if (next === 0x0a) {
        i += 1;
        continue;
      }
      const hex = buf.subarray(i + 1, i + 3).toString('ascii');
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        out.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
      out.push(byte);
    } else {
      out.push(byte);
    }
  }
  return Buffer.from(out);
}

/** Decode one MIME body part to text using its transfer encoding and charset. */
function decodePartBody(buf: Buffer, encoding: string | undefined, charset: string | undefined): string {
  let bytes = buf;
  const enc = (encoding ?? '7bit').toLowerCase();
  if (enc === 'base64') {
    bytes = Buffer.from(buf.toString('ascii').replace(/\s+/g, ''), 'base64');
  } else if (enc === 'quoted-printable') {
    bytes = decodeQuotedPrintable(buf);
  }
  const cs = (charset ?? 'utf-8').trim().toLowerCase() || 'utf-8';
  try {
    return new TextDecoder(cs).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

// Minimal structural view of an imapflow body structure node, enough to walk
// a MIME tree looking for a text/plain or text/html part, or attachments.
interface PartNode {
  type?: string;
  subtype?: string;
  part?: string;
  encoding?: string;
  parameters?: Record<string, string>;
  disposition?: string;
  dispositionParameters?: Record<string, string>;
  size?: number;
  childNodes?: PartNode[];
}

function findPart(node: PartNode | undefined, mimeType: string): PartNode | null {
  if (!node) return null;
  const type = `${node.type ?? ''}/${node.subtype ?? ''}`.toLowerCase();
  if (type === mimeType) return node;
  for (const child of node.childNodes ?? []) {
    const found = findPart(child, mimeType);
    if (found) return found;
  }
  return null;
}

/** Find one body-structure node by its IMAP part id (e.g. "2"). */
function findPartById(node: PartNode | undefined, partId: string): PartNode | null {
  if (!node) return null;
  if (node.part === partId) return node;
  for (const child of node.childNodes ?? []) {
    const found = findPartById(child, partId);
    if (found) return found;
  }
  return null;
}

/** Walk a MIME tree and collect every attachment part: content-disposition
 *  "attachment", or a named non-text part (which covers inline images that
 *  may carry information, e.g. a photo of a schedule). */
export function listAttachments(node: PartNode | undefined): AttachmentInfo[] {
  const found: AttachmentInfo[] = [];
  const walk = (n: PartNode | undefined): void => {
    if (!n) return;
    const mimeType = `${n.type ?? ''}/${n.subtype ?? ''}`.toLowerCase();
    const isMultipart = (n.type ?? '').toLowerCase() === 'multipart';
    const filename =
      n.dispositionParameters?.filename ??
      n.parameters?.filename ??
      n.parameters?.name ??
      '';
    const isAttachment =
      (n.disposition ?? '').toLowerCase() === 'attachment' ||
      (filename !== '' && !isMultipart && !mimeType.startsWith('text/'));
    if (isAttachment && n.part) {
      const fallbackExt =
        mimeType === 'application/pdf'
          ? '.pdf'
          : mimeType ===
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
            ? '.docx'
            : mimeType ===
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
              ? '.xlsx'
              : mimeType.startsWith('image/')
                ? `.${n.subtype ?? 'img'}`
                : '';
      found.push({
        part: n.part,
        filename: filename || `attachment-${n.part}${fallbackExt}`,
        mimeType,
        size: typeof n.size === 'number' ? n.size : 0,
      });
    }
    for (const child of n.childNodes ?? []) walk(child);
  };
  walk(node);
  return found;
}

// ---------------------------------------------------------------------------
// IMAP connection handling
// ---------------------------------------------------------------------------

async function connectImap(account: AccountRow): Promise<ImapFlow> {
  if (account.kind === 'graph') {
    throw new Error(`Account "${account.label}" is a Microsoft Graph account and cannot be used over IMAP.`);
  }
  const password = getSecret(account.credentialKey);
  if (!password) {
    throw new Error(`No stored password for account "${account.label}". Reconnect the account in Settings.`);
  }
  const port = account.port > 0 ? account.port : DEFAULT_IMAP_PORT;
  const client = new ImapFlowClass({
    host: account.host,
    port,
    secure: account.secure !== 0,
    auth: { user: account.username, pass: password },
    logger: false,
  });
  await client.connect();
  return client;
}

async function closeClient(client: ImapFlow): Promise<void> {
  try {
    await client.logout();
  } catch {
    // Already disconnected or never connected; nothing to clean up.
  }
}

/** Fetch one body part for one message and decode it to text. */
async function fetchPartText(
  client: ImapFlow,
  uid: number,
  part: PartNode,
): Promise<string | null> {
  const partId = part.part;
  if (!partId) return null;
  for await (const msg of client.fetch(uid, { bodyParts: [partId] })) {
    const buf = msg.bodyParts?.get(partId);
    if (!buf) return null;
    return decodePartBody(buf, part.encoding, part.parameters?.charset);
  }
  return null;
}

/** Fetch one body part for one message and decode it to raw bytes
 *  (for attachments). Returns null when the part cannot be fetched. */
async function fetchPartBytes(
  client: ImapFlow,
  uid: number,
  part: PartNode,
): Promise<Buffer | null> {
  const partId = part.part;
  if (!partId) return null;
  for await (const msg of client.fetch(uid, { bodyParts: [partId] })) {
    const buf = msg.bodyParts?.get(partId);
    if (!buf) return null;
    const enc = (part.encoding ?? '7bit').toLowerCase();
    if (enc === 'base64') {
      return Buffer.from(buf.toString('ascii').replace(/\s+/g, ''), 'base64');
    }
    if (enc === 'quoted-printable') {
      return decodeQuotedPrintable(buf);
    }
    return buf;
  }
  return null;
}

export interface ReadAttachmentsOptions {
  /** Max attachments to read in this call (default 5). */
  maxAttachments?: number;
  /** Whether image attachments may be OCRed (default true). */
  includeOcr?: boolean;
  /** Max image attachments to OCR in this call (default 5). */
  maxOcrImages?: number;
}

/**
 * Download one attachment part and save it to the app's temporary
 * attachments folder. Enforces the per-file size cap. Returns the saved
 * path plus the downloaded size.
 */
async function downloadAndSaveAttachment(
  client: ImapFlow,
  uid: number,
  att: AttachmentInfo,
  partNode: PartNode,
): Promise<{ savedPath: string; size: number }> {
  if (att.size > 0 && att.size > ATTACHMENT_MAX_BYTES) {
    throw new Error(
      `Attachment is larger than the ${ATTACHMENT_MAX_BYTES / 1024 / 1024} MB download cap.`,
    );
  }
  const bytes = await fetchPartBytes(client, uid, partNode);
  if (!bytes) throw new Error('Could not download the attachment.');
  if (bytes.length > ATTACHMENT_MAX_BYTES) {
    throw new Error(
      `Attachment is larger than the ${ATTACHMENT_MAX_BYTES / 1024 / 1024} MB download cap.`,
    );
  }
  const savedPath = uniqueAttachmentPath(uid, att.filename);
  await fs.promises.writeFile(savedPath, bytes);
  return { savedPath, size: bytes.length };
}

/**
 * Download and read the attachments of one message (with an already open
 * IMAP client): each file is saved to the temp attachments folder and its
 * text is extracted (PDF/DOCX/XLSX/plain text, images via OCR). Failures
 * are reported per attachment instead of failing the whole message.
 */
async function readAttachments(
  client: ImapFlow,
  uid: number,
  attachments: AttachmentInfo[],
  structure: PartNode | undefined,
  options: ReadAttachmentsOptions = {},
): Promise<AttachmentReadResult[]> {
  const maxAttachments = options.maxAttachments ?? MAX_AUTO_READ_ATTACHMENTS;
  const includeOcr = options.includeOcr ?? true;
  const maxOcrImages = options.maxOcrImages ?? MAX_AUTO_READ_ATTACHMENTS;
  const results: AttachmentReadResult[] = [];
  let ocrUsed = 0;
  for (const att of attachments.slice(0, maxAttachments)) {
    const base: AttachmentInfo = {
      part: att.part,
      filename: att.filename,
      mimeType: att.mimeType,
      size: att.size,
    };
    const partNode = findPartById(structure, att.part);
    if (!partNode) {
      results.push({ ...base, savedPath: '', text: '', truncated: false, method: 'unsupported', error: 'Attachment part not found in the message structure.' });
      continue;
    }
    const isImage =
      att.mimeType.toLowerCase().startsWith('image/') ||
      IMAGE_EXTS.has(path.extname(att.filename).toLowerCase());
    if (isImage && (!includeOcr || ocrUsed >= maxOcrImages)) {
      results.push({
        ...base,
        savedPath: '',
        text: '',
        truncated: false,
        method: 'unsupported',
        error: 'Image text extraction was skipped (OCR disabled or OCR budget spent for this read). Download the attachment to read it.',
      });
      continue;
    }
    try {
      const { savedPath, size } = await downloadAndSaveAttachment(client, uid, att, partNode);
      if (isImage) ocrUsed += 1;
      const extracted = await extractAttachmentText(savedPath, att.mimeType);
      const result: AttachmentReadResult = {
        ...base,
        size,
        savedPath,
        text: extracted.text,
        truncated: extracted.truncated,
        method: extracted.method,
      };
      if (extracted.confidence !== undefined) result.confidence = extracted.confidence;
      if (extracted.method === 'unsupported') {
        result.error = 'This file format cannot be read as text. Open the saved file to view it.';
      }
      results.push(result);
    } catch (err) {
      results.push({
        ...base,
        savedPath: '',
        text: '',
        truncated: false,
        method: 'unsupported',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

interface MessageMeta {
  from: string;
  subject: string;
  date: string;
  seen: boolean;
  structure: PartNode | undefined;
  textPart: PartNode | null;
}

/** Fetch envelopes, flags and body structure for the given uids, plus a plain
 *  text snippet for each message that has a text/plain part. */
async function fetchSummaries(client: ImapFlow, uids: number[], limit: number): Promise<InboxMessage[]> {
  const page = [...uids].sort((a, b) => b - a).slice(0, Math.max(1, Math.min(limit, 100)));
  if (page.length === 0) return [];

  const metas = new Map<number, MessageMeta>();
  for await (const msg of client.fetch(page, { uid: true, envelope: true, flags: true, bodyStructure: true })) {
    const structure = msg.bodyStructure as unknown as PartNode | undefined;
    metas.set(msg.uid, {
      from: formatAddress(msg.envelope?.from?.[0]),
      subject: msg.envelope?.subject ?? '',
      date: msg.envelope?.date ? msg.envelope.date.toISOString() : '',
      seen: msg.flags?.has('\\Seen') ?? false,
      structure,
      textPart: findPart(structure, 'text/plain'),
    });
  }

  // Fetch text parts grouped by part id (usually one group) so snippets do
  // not require downloading whole messages or attachments.
  const snippets = new Map<number, string>();
  const byPart = new Map<string, { uids: number[]; node: PartNode }>();
  for (const [uid, meta] of metas) {
    const part = meta.textPart;
    if (part?.part) {
      const group = byPart.get(part.part) ?? { uids: [], node: part };
      group.uids.push(uid);
      byPart.set(part.part, group);
    }
  }
  for (const [partId, group] of byPart) {
    for await (const msg of client.fetch(group.uids, { uid: true, bodyParts: [partId] })) {
      const buf = msg.bodyParts?.get(partId);
      if (buf) {
        snippets.set(msg.uid, makeSnippet(decodePartBody(buf, group.node.encoding, group.node.parameters?.charset)));
      }
    }
  }

  return page
    .map((uid) => {
      const meta = metas.get(uid);
      if (!meta) return null;
      return {
        uid,
        from: meta.from,
        subject: meta.subject,
        date: meta.date,
        snippet: snippets.get(uid) ?? '',
        seen: meta.seen,
        attachments: listAttachments(meta.structure),
      } satisfies InboxMessage;
    })
    .filter((m): m is InboxMessage => m !== null);
}

// ---------------------------------------------------------------------------
// SMTP host resolution
// ---------------------------------------------------------------------------

function resolveSmtpHost(account: AccountRow): string {
  const host = account.host.toLowerCase();
  if (host === 'outlook.office365.com' || host.endsWith('.outlook.com') || host === 'smtp.office365.com') {
    return 'smtp.office365.com';
  }
  if (host === 'imap.gmail.com' || host === 'smtp.gmail.com') {
    return 'smtp.gmail.com';
  }
  if (host === 'imap.mail.yahoo.com' || host === 'smtp.mail.yahoo.com') {
    return 'smtp.mail.yahoo.com';
  }
  return account.host;
}

// ---------------------------------------------------------------------------
// Email service
// ---------------------------------------------------------------------------

export const emailService = {
  listAccounts(): PublicAccount[] {
    return storeListAccounts().map((a) => ({
      id: a.id,
      label: a.label,
      kind: a.kind,
      host: a.host,
      port: a.port,
      secure: a.secure,
      username: a.username,
    }));
  },

  async listInbox(accountId: string, limit = 30): Promise<InboxMessage[]> {
    const account = findAccount(accountId);
    const client = await connectImap(account);
    try {
      const lock = await client.getMailboxLock('INBOX');
      try {
        const uids = (await client.search({ all: true })) || [];
        return await fetchSummaries(client, uids, limit);
      } finally {
        lock.release();
      }
    } finally {
      await closeClient(client);
    }
  },

  async searchInbox(accountId: string, query: string): Promise<InboxMessage[]> {
    const trimmed = query.trim();
    if (!trimmed) throw new Error('Search query must not be empty.');
    const account = findAccount(accountId);
    const client = await connectImap(account);
    try {
      const lock = await client.getMailboxLock('INBOX');
      try {
        const uids =
          (await client.search({
            or: [{ subject: trimmed }, { from: trimmed }, { body: trimmed }],
          })) || [];
        return await fetchSummaries(client, uids, 30);
      } finally {
        lock.release();
      }
    } finally {
      await closeClient(client);
    }
  },

  async getMessage(accountId: string, uid: number): Promise<FullMessage> {
    if (!Number.isInteger(uid) || uid <= 0) throw new Error(`Invalid message uid: ${uid}`);
    const account = findAccount(accountId);
    const client = await connectImap(account);
    try {
      const lock = await client.getMailboxLock('INBOX');
      try {
        let envelope: { subject?: string; from?: Array<{ name?: string; address?: string }>; to?: Array<{ name?: string; address?: string }>; date?: Date } | undefined;
        let structure: PartNode | undefined;
        for await (const msg of client.fetch(uid, { uid: true, envelope: true, bodyStructure: true })) {
          envelope = msg.envelope;
          structure = msg.bodyStructure as unknown as PartNode | undefined;
        }
        if (!envelope) throw new Error(`Message not found: uid ${uid}`);

        const textPart = findPart(structure, 'text/plain');
        const htmlPart = findPart(structure, 'text/html');
        let body = textPart ? await fetchPartText(client, uid, textPart) : null;
        let html: string | undefined;
        if (htmlPart) {
          html = (await fetchPartText(client, uid, htmlPart)) ?? undefined;
        }
        if (!body && html) body = stripHtml(html);
        const attachments = listAttachments(structure);
        const attachmentTexts = await readAttachments(client, uid, attachments, structure);
        return {
          uid,
          subject: envelope.subject ?? '',
          from: formatAddress(envelope.from?.[0]),
          to: formatAddressList(envelope.to),
          date: envelope.date ? envelope.date.toISOString() : '',
          body: body ?? '',
          ...(html ? { html } : {}),
          attachments,
          attachmentTexts,
        };
      } finally {
        lock.release();
      }
    } finally {
      await closeClient(client);
    }
  },

  /** Download one attachment to the app's temporary attachments folder. */
  async downloadAttachment(
    accountId: string,
    uid: number,
    part: string,
  ): Promise<{ path: string; filename: string; mimeType: string; size: number }> {
    if (!Number.isInteger(uid) || uid <= 0) throw new Error(`Invalid message uid: ${uid}`);
    if (!part.trim()) throw new Error('Attachment part id is required.');
    const account = findAccount(accountId);
    const client = await connectImap(account);
    try {
      const lock = await client.getMailboxLock('INBOX');
      try {
        let structure: PartNode | undefined;
        for await (const msg of client.fetch(uid, { bodyStructure: true })) {
          structure = msg.bodyStructure as unknown as PartNode | undefined;
        }
        if (!structure) throw new Error(`Message not found: uid ${uid}`);
        const attachments = listAttachments(structure);
        const att = attachments.find((a) => a.part === part);
        if (!att) throw new Error(`No attachment with part id "${part}" in message ${uid}.`);
        const partNode = findPartById(structure, part);
        if (!partNode) throw new Error(`Attachment part "${part}" not found.`);
        const { savedPath, size } = await downloadAndSaveAttachment(client, uid, att, partNode);
        return { path: savedPath, filename: att.filename, mimeType: att.mimeType, size };
      } finally {
        lock.release();
      }
    } finally {
      await closeClient(client);
    }
  },

  async sendMessage(accountId: string, draft: EmailDraft): Promise<{ messageId: string }> {
    const to = draft.to.trim();
    if (!to) throw new Error('Recipient address (to) is required.');
    if (!draft.subject.trim() && !draft.body.trim()) {
      throw new Error('An email needs a subject or a body.');
    }
    const account = findAccount(accountId);
    const password = getSecret(account.credentialKey);
    if (!password) {
      throw new Error(`No stored password for account "${account.label}". Reconnect the account in Settings.`);
    }
    const useSecurePort = account.port === 465;
    const transporter = nodemailer.createTransport({
      host: resolveSmtpHost(account),
      port: useSecurePort ? 465 : 587,
      secure: useSecurePort,
      auth: { user: account.username, pass: password },
    });
    const info = await transporter.sendMail({
      from: account.username,
      to,
      cc: draft.cc?.trim() ? draft.cc.trim() : undefined,
      subject: draft.subject,
      text: draft.body,
    });
    return { messageId: info.messageId ?? '' };
  },

  async getDigest(accountId: string): Promise<EmailDigest> {
    const account = findAccount(accountId);
    const client = await connectImap(account);
    try {
      const lock = await client.getMailboxLock('INBOX');
      try {
        const unreadUids = (await client.search({ seen: false })) || [];
        if (unreadUids.length === 0) {
          return { unreadCount: 0, digest: 'No unread messages.' };
        }
        const messages = await fetchSummaries(client, unreadUids, 20);
        const lines = messages.map(
          (m) => `- ${m.from || '(unknown sender)'}: ${m.subject || '(no subject)'} (${m.date ? new Date(m.date).toLocaleString() : 'unknown date'})`,
        );
        // Attachment-derived info: key details often live only in attachments
        // (a swim schedule PDF, a school letter). Read the attachments of
        // the newest unread messages that have them, bounded so the digest
        // stays fast (at most 5 messages, 3 attachments each, 2 OCR images).
        const attachmentLines: string[] = [];
        let ocrBudget = DIGEST_MAX_OCR_IMAGES;
        const withAttachments = messages.filter((m) => m.attachments.length > 0).slice(0, 5);
        for (const m of withAttachments) {
          let structure: PartNode | undefined;
          for await (const msg of client.fetch(m.uid, { bodyStructure: true })) {
            structure = msg.bodyStructure as unknown as PartNode | undefined;
          }
          if (!structure) continue;
          const reads = await readAttachments(client, m.uid, m.attachments, structure, {
            maxAttachments: 3,
            includeOcr: true,
            maxOcrImages: ocrBudget,
          });
          ocrBudget -= reads.filter((r) => r.method === 'ocr').length;
          for (const r of reads) {
            if (r.text) {
              const excerpt =
                r.text.length > DIGEST_ATTACHMENT_EXCERPT_CHARS
                  ? `${r.text.slice(0, DIGEST_ATTACHMENT_EXCERPT_CHARS)}...`
                  : r.text;
              attachmentLines.push(`Attachment in "${m.subject || '(no subject)'}": ${r.filename} — ${excerpt}`);
            } else if (r.error) {
              attachmentLines.push(`Attachment in "${m.subject || '(no subject)'}": ${r.filename} — could not read (${r.error})`);
            }
          }
        }
        let digest = `You have ${unreadUids.length} unread message${unreadUids.length === 1 ? '' : 's'}:\n${lines.join('\n')}`;
        if (attachmentLines.length > 0) {
          digest += `\nDetails found in attachments:\n${attachmentLines.join('\n')}`;
        }
        if (unreadUids.length > messages.length) {
          digest += `\n... and ${unreadUids.length - messages.length} more.`;
        }
        if (digest.length > MAX_DIGEST_CHARS) {
          digest = `${digest.slice(0, MAX_DIGEST_CHARS - 3)}...`;
        }
        return { unreadCount: unreadUids.length, digest };
      } finally {
        lock.release();
      }
    } finally {
      await closeClient(client);
    }
  },
};

// ---------------------------------------------------------------------------
// Permission enforcement + tool definitions
// ---------------------------------------------------------------------------

function isAccountAllowed(ctx: ToolContext, accountId: string): boolean {
  const allowed = ctx.permissions.allowedEmailAccounts;
  return allowed.includes('*') || allowed.includes(accountId);
}

function assertAccountAllowed(ctx: ToolContext, accountId: string): void {
  if (!isAccountAllowed(ctx, accountId)) {
    throw new Error(`Email account is not allowed in this project: ${accountId}`);
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function reqString(args: Record<string, unknown>, name: string): string {
  const value = asString(args[name]);
  if (value === undefined) throw new Error(`Missing required argument: ${name}`);
  return value;
}

function optNumber(args: Record<string, unknown>, name: string, fallback: number): number {
  const value = args[name];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

async function run<T>(fn: () => Promise<T>): Promise<ToolResult> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const accountIdParam = {
  type: 'string',
  description: 'Id of the connected email account to use.',
};

export const emailTools: ToolDefinition[] = [
  {
    name: 'email_list_inbox',
    description: 'List the newest messages in an email account inbox, newest first.',
    parameters: {
      type: 'object',
      properties: {
        accountId: accountIdParam,
        limit: { type: 'number', description: 'Maximum number of messages to return (default 30).' },
      },
      required: ['accountId'],
    },
    requiresConfirmation: false,
    handler: async (args, ctx) =>
      run(async () => {
        const accountId = reqString(args, 'accountId');
        assertAccountAllowed(ctx, accountId);
        return emailService.listInbox(accountId, optNumber(args, 'limit', 30));
      }),
  },
  {
    name: 'email_search',
    description: 'Search an email account inbox by subject, sender or body text.',
    parameters: {
      type: 'object',
      properties: {
        accountId: accountIdParam,
        query: { type: 'string', description: 'Text to search for in subject, sender or body.' },
      },
      required: ['accountId', 'query'],
    },
    requiresConfirmation: false,
    handler: async (args, ctx) =>
      run(async () => {
        const accountId = reqString(args, 'accountId');
        assertAccountAllowed(ctx, accountId);
        return emailService.searchInbox(accountId, reqString(args, 'query'));
      }),
  },
  {
    name: 'email_read',
    description:
      'Read the full body of one email message by its uid. Attachments (PDF, Word, Excel, plain text, images) are downloaded to a temporary folder and their extracted text is included in the result.',
    parameters: {
      type: 'object',
      properties: {
        accountId: accountIdParam,
        uid: { type: 'number', description: 'IMAP uid of the message.' },
      },
      required: ['accountId', 'uid'],
    },
    requiresConfirmation: false,
    handler: async (args, ctx) =>
      run(async () => {
        const accountId = reqString(args, 'accountId');
        assertAccountAllowed(ctx, accountId);
        const uid = args.uid;
        if (typeof uid !== 'number' || !Number.isInteger(uid)) {
          throw new Error('Argument "uid" must be an integer.');
        }
        return emailService.getMessage(accountId, uid);
      }),
  },
  {
    name: 'email_download_attachment',
    description:
      'Download one email attachment by message uid and part id, saving it to the app\'s temporary attachments folder. Returns the saved file path so it can be opened or read with the file tools. Files over 25 MB are refused.',
    parameters: {
      type: 'object',
      properties: {
        accountId: accountIdParam,
        uid: { type: 'number', description: 'IMAP uid of the message.' },
        part: { type: 'string', description: 'Attachment part id from email_read, e.g. "2".' },
      },
      required: ['accountId', 'uid', 'part'],
    },
    requiresConfirmation: false,
    handler: async (args, ctx) =>
      run(async () => {
        const accountId = reqString(args, 'accountId');
        assertAccountAllowed(ctx, accountId);
        const uid = args.uid;
        if (typeof uid !== 'number' || !Number.isInteger(uid)) {
          throw new Error('Argument "uid" must be an integer.');
        }
        return emailService.downloadAttachment(accountId, uid, reqString(args, 'part'));
      }),
  },
  {
    name: 'email_digest',
    description: 'Get a short plain-text digest of unread email: count plus one line per unread message.',
    parameters: {
      type: 'object',
      properties: { accountId: accountIdParam },
      required: ['accountId'],
    },
    requiresConfirmation: false,
    handler: async (args, ctx) =>
      run(async () => {
        const accountId = reqString(args, 'accountId');
        assertAccountAllowed(ctx, accountId);
        return emailService.getDigest(accountId);
      }),
  },
  {
    name: 'email_send',
    description: 'Send an email from a connected account.',
    parameters: {
      type: 'object',
      properties: {
        accountId: accountIdParam,
        to: { type: 'string', description: 'Recipient email address.' },
        cc: { type: 'string', description: 'Optional CC address(es).' },
        subject: { type: 'string', description: 'Email subject.' },
        body: { type: 'string', description: 'Plain-text email body.' },
      },
      required: ['accountId', 'to', 'subject', 'body'],
    },
    requiresConfirmation: true,
    handler: async (args, ctx) =>
      run(async () => {
        const accountId = reqString(args, 'accountId');
        if (!ctx.permissions.canSendEmail) {
          throw new Error('Sending email is not allowed in this project.');
        }
        assertAccountAllowed(ctx, accountId);
        return emailService.sendMessage(accountId, {
          to: reqString(args, 'to'),
          subject: reqString(args, 'subject'),
          body: reqString(args, 'body'),
          cc: asString(args.cc),
        });
      }),
  },
];
