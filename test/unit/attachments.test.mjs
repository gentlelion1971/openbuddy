// Unit tests for attachment helpers (src/main/tools/attachments.ts):
// safe filenames, unique paths, text extraction, and retention cleanup.
// Run: npm run build && npm run test:unit
// All code, comments, log messages and docs in this project are English only.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Document, Packer, Paragraph, TextRun } from 'docx';
import * as XLSX from 'xlsx';
import {
  __dataDir,
  __resetStore,
  setSetting,
} from './store-stub.mjs';
import {
  attachmentsDir,
  cleanupAttachments,
  extractAttachmentText,
  safeFilename,
  uniqueAttachmentPath,
} from '../../dist/main/tools/attachments.js';

test.beforeEach(() => {
  __resetStore();
});

/** Build a minimal valid one-page PDF holding `text` in Helvetica. */
function makePdf(text) {
  const esc = text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const content = `BT /F1 24 Tf 100 700 Td (${esc}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefPos = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

test('safeFilename: strips directories, illegal chars, reserved names', () => {
  assert.equal(safeFilename('..\\..\\etc\\passwd'), 'passwd');
  assert.equal(safeFilename('../../etc/passwd'), 'passwd');
  assert.equal(safeFilename(''), 'attachment');
  assert.equal(safeFilename('   '), 'attachment');
  assert.equal(safeFilename('CON.txt'), '_CON.txt');
  assert.equal(safeFilename('report: final?.docx'), 'report_ final_.docx');
  assert.equal(safeFilename('notes...'), 'notes');
  const long = safeFilename(`${'a'.repeat(150)}.pdf`);
  assert.ok(long.length <= 104 && long.endsWith('.pdf'));
  assert.equal(safeFilename('schedule (1).pdf'), 'schedule (1).pdf');
});

test('uniqueAttachmentPath: second file with the same name gets a suffix', () => {
  const first = uniqueAttachmentPath(123, 'schedule.pdf');
  assert.equal(path.basename(first), 'schedule.pdf');
  fs.writeFileSync(first, 'x');
  const second = uniqueAttachmentPath(123, 'schedule.pdf');
  assert.equal(path.basename(second), 'schedule (2).pdf');
  const third = uniqueAttachmentPath(123, 'schedule.pdf');
  // Third call still sees only the first file on disk.
  assert.equal(path.basename(third), 'schedule (2).pdf');
});

test('extractAttachmentText: PDF, DOCX, XLSX, and plain text', async () => {
  const dir = fs.mkdtempSync(path.join(__dataDir(), 'extract-'));

  const pdfPath = path.join(dir, 'letter.pdf');
  fs.writeFileSync(pdfPath, makePdf('Hello PDF World'));
  const pdf = await extractAttachmentText(pdfPath, 'application/pdf');
  assert.equal(pdf.method, 'pdf');
  assert.match(pdf.text, /Hello PDF World/);

  const doc = new Document({
    sections: [{ children: [new Paragraph({ children: [new TextRun('Swim schedule Monday 6pm')] })] }],
  });
  const docxPath = path.join(dir, 'schedule.docx');
  fs.writeFileSync(docxPath, await Packer.toBuffer(doc));
  const docx = await extractAttachmentText(docxPath, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(docx.method, 'docx');
  assert.match(docx.text, /Swim schedule Monday 6pm/);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Event', 'Time'], ['Practice', '18:00']]), 'Sheet1');
  const xlsxPath = path.join(dir, 'times.xlsx');
  fs.writeFileSync(xlsxPath, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  const xlsx = await extractAttachmentText(xlsxPath, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(xlsx.method, 'xlsx');
  assert.match(xlsx.text, /Practice \| 18:00/);

  const txtPath = path.join(dir, 'note.txt');
  fs.writeFileSync(txtPath, '  Plain   note\nwith lines.  ');
  const txt = await extractAttachmentText(txtPath, 'text/plain');
  assert.equal(txt.method, 'text');
  assert.equal(txt.text, 'Plain note with lines.');

  const zipPath = path.join(dir, 'archive.zip');
  fs.writeFileSync(zipPath, Buffer.from('PK\x03\x04fake'));
  const zip = await extractAttachmentText(zipPath, 'application/zip');
  assert.equal(zip.method, 'unsupported');
  assert.equal(zip.text, '');
});

test('cleanupAttachments: deletes only old files inside the temp folder', () => {
  setSetting('attachmentRetentionDays', '30');
  const dir = attachmentsDir();
  const uidDir = path.join(dir, '999');
  fs.mkdirSync(uidDir, { recursive: true });
  const oldFile = path.join(uidDir, 'old.pdf');
  const freshFile = path.join(uidDir, 'fresh.pdf');
  fs.writeFileSync(oldFile, 'old');
  fs.writeFileSync(freshFile, 'fresh');
  const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  fs.utimesSync(oldFile, fortyDaysAgo, fortyDaysAgo);

  // A file outside the attachments folder must never be touched.
  const outside = path.join(__dataDir(), 'keep-me.txt');
  fs.writeFileSync(outside, 'keep');
  fs.utimesSync(outside, fortyDaysAgo, fortyDaysAgo);

  const result = cleanupAttachments();
  assert.equal(result.deleted, 1);
  assert.equal(result.freedBytes, 3);
  assert.equal(result.skipped, false);
  assert.equal(fs.existsSync(oldFile), false);
  assert.equal(fs.existsSync(freshFile), true);
  assert.equal(fs.existsSync(outside), true);
});

test('cleanupAttachments: retention "never" skips everything', () => {
  setSetting('attachmentRetentionDays', 'never');
  const dir = attachmentsDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'old.pdf');
  fs.writeFileSync(file, 'old');
  const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  fs.utimesSync(file, fortyDaysAgo, fortyDaysAgo);

  const result = cleanupAttachments();
  assert.deepEqual(result, { deleted: 0, freedBytes: 0, skipped: true });
  assert.equal(fs.existsSync(file), true);
});
