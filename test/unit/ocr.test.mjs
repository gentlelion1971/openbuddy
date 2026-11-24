// Unit test for offline OCR (src/main/tools/ocr.ts, tesseract.js).
// Generates a PNG with known text (PIL), downloads the English language
// data once from the same URL the app's setup uses, and checks the text
// comes back. Needs network once for the language data.
// Run: npm run build && npm run test:unit
// All code, comments, log messages and docs in this project are English only.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { __dataDir } from './store-stub.mjs';
import { OCR_DATA_URL } from '../../dist/main/setup.js';
import { ocrDataDir, ocrDataReady, recognizeImage, terminateOcr } from '../../dist/main/tools/ocr.js';

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));

test.after(async () => {
  await terminateOcr();
});

test('ocrDataReady is false before the language data is downloaded', () => {
  assert.equal(ocrDataReady(), false);
});

test('recognizeImage reads printed text from a PNG', async () => {
  // Download the English language data once (same file the setup wizard uses).
  const dir = ocrDataDir();
  fs.mkdirSync(dir, { recursive: true });
  const langFile = path.join(dir, 'eng.traineddata');
  if (!fs.existsSync(langFile)) {
    const res = await fetch(OCR_DATA_URL);
    assert.ok(res.ok, `could not download OCR language data (${res.status})`);
    fs.writeFileSync(langFile, Buffer.from(await res.arrayBuffer()));
  }
  assert.equal(ocrDataReady(), true);

  const pngPath = path.join(__dataDir(), 'ocr-test.png');
  await execFileAsync('python3', [path.join(here, 'make_ocr_image.py'), pngPath]);
  assert.ok(fs.existsSync(pngPath));

  const { text, confidence } = await recognizeImage(pngPath);
  assert.match(text, /Swim Practice/i);
  assert.match(text, /Monday/i);
  assert.match(text, /Pool B/i);
  assert.ok(confidence > 0, `expected a confidence score, got ${confidence}`);
});
