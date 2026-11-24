// Browser tools: web lookup, web search, form filling/submission, price comparison.
// Uses Playwright Chromium for page loads and form automation, and the
// DuckDuckGo Lite page (no API key) for web search.
// All code, comments, log messages and docs in this project are English only.

import type { Browser, Locator, Page } from 'playwright';
import playwright from 'playwright';

// Playwright is a CommonJS module that re-exports through
// `module.exports = require('playwright-core')`, so Node's ESM loader
// cannot resolve named imports from it on some platforms (same startup
// crash as tesseract.js in ocr.ts). Use the default import instead.
const { chromium } = playwright;
import type { ToolContext, ToolDefinition, ToolResult } from './types.js';

const PAGE_TIMEOUT_MS = 20_000;
const FETCH_TEXT_LIMIT = 8000;
const SEARCH_RESULT_LIMIT = 8;
const COMPARE_PAGE_LIMIT = 5;
const PRICE_CONTEXT_CHARS = 50;

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface PageText {
  title: string;
  url: string;
  text: string;
}

export interface FillOutcome {
  filled: string[];
  missing: string[];
  url: string;
  summary: string;
}

export interface PriceHit {
  url: string;
  title: string;
  prices: string[];
}

interface FormField {
  label: string;
  value: string;
}

/** Launch a headless Chromium instance from the Playwright default install. */
async function launchBrowser(): Promise<Browser> {
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;
  return chromium.launch({ headless: true, executablePath });
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? text.slice(0, limit) : text;
}

function cleanWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, code: string) =>
      String.fromCharCode(parseInt(code, 16)),
    );
}

function stripTags(html: string): string {
  return cleanWhitespace(decodeHtmlEntities(html.replace(/<[^>]*>/g, ' ')));
}

/** Unwrap a DuckDuckGo redirect link (/l/?uddg=<encoded url>) if present. */
function unwrapDuckDuckGoUrl(href: string): string {
  try {
    const absolute = href.startsWith('//') ? `https:${href}` : href;
    const parsed = new URL(absolute, 'https://duckduckgo.com');
    const target = parsed.searchParams.get('uddg');
    if (target) return decodeURIComponent(target);
    return absolute;
  } catch {
    return href;
  }
}

/** Parse DuckDuckGo Lite HTML into search results. */
function parseDuckDuckGoLite(html: string): SearchResult[] {
  const linkPattern =
    /<a[^>]*class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetPattern =
    /<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/g;
  const links: Array<{ url: string; title: string }> = [];
  const snippets: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = linkPattern.exec(html)) !== null) {
    links.push({ url: unwrapDuckDuckGoUrl(match[1]), title: stripTags(match[2]) });
  }
  while ((match = snippetPattern.exec(html)) !== null) {
    snippets.push(stripTags(match[1]));
  }

  return links
    .filter((link) => link.url.startsWith('http') && link.title.length > 0)
    .slice(0, SEARCH_RESULT_LIMIT)
    .map((link, index) => ({
      title: link.title,
      url: link.url,
      snippet: snippets[index] ?? '',
    }));
}

async function fetchDuckDuckGoLite(query: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(
      `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
      {
        signal: controller.signal,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      },
    );
    if (!response.ok) {
      throw new Error(`DuckDuckGo Lite returned HTTP ${response.status}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

/** Find an input/textarea/select by label text, placeholder, or input name. */
async function findField(page: Page, label: string): Promise<Locator | null> {
  const candidates: Locator[] = [
    page.getByLabel(label, { exact: false }),
    page.getByPlaceholder(label, { exact: false }),
    page.locator(
      `input[name="${label.replace(/"/g, '\\"')}"], ` +
        `textarea[name="${label.replace(/"/g, '\\"')}"], ` +
        `select[name="${label.replace(/"/g, '\\"')}"]`,
    ),
  ];
  for (const candidate of candidates) {
    try {
      const count = await candidate.count();
      if (count === 0) continue;
      const first = candidate.first();
      if (await first.isVisible()) return first;
    } catch {
      // Try the next matching strategy.
    }
  }
  return null;
}

async function fillOneField(locator: Locator, value: string): Promise<void> {
  const tag = (await locator.evaluate((el) => el.tagName.toLowerCase())) as string;
  const type = (await locator.getAttribute('type')) ?? '';
  if (tag === 'select') {
    try {
      await locator.selectOption({ label: value });
    } catch {
      await locator.selectOption(value);
    }
    return;
  }
  if (type === 'checkbox' || type === 'radio') {
    const wanted = ['true', 'yes', '1', 'checked', 'on'].includes(value.toLowerCase());
    if (wanted) await locator.check();
    else await locator.uncheck();
    return;
  }
  await locator.fill(value);
}

async function fillFieldsOnPage(
  page: Page,
  fields: FormField[],
): Promise<{ filled: string[]; missing: string[] }> {
  const filled: string[] = [];
  const missing: string[] = [];
  for (const field of fields) {
    try {
      const locator = await findField(page, field.label);
      if (!locator) {
        missing.push(field.label);
        continue;
      }
      await fillOneField(locator, field.value);
      filled.push(field.label);
    } catch {
      missing.push(field.label);
    }
  }
  return { filled, missing };
}

function toFormFields(raw: unknown): FormField[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (item): item is Record<string, unknown> =>
        typeof item === 'object' && item !== null,
    )
    .map((item) => ({
      label: String(item.label ?? ''),
      value: String(item.value ?? ''),
    }))
    .filter((field) => field.label.length > 0);
}

function toStringArg(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function requireHttpUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return 'Only http(s) URLs are supported.';
    }
    return null;
  } catch {
    return 'Invalid URL.';
  }
}

function gateBrowse(ctx: ToolContext): string | null {
  return ctx.permissions.canBrowseWeb ? null : 'Web browsing is not allowed for this project.';
}

function gateBrowser(ctx: ToolContext): string | null {
  return ctx.permissions.canRunBrowser
    ? null
    : 'Browser automation is not allowed for this project.';
}

function fail(error: unknown): ToolResult {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

export const browserService = {
  /** Load a page in headless Chromium and return its title, URL and body text. */
  async fetchPageText(url: string): Promise<PageText> {
    const urlError = requireHttpUrl(url);
    if (urlError) throw new Error(urlError);
    let browser: Browser | null = null;
    try {
      browser = await launchBrowser();
      const page = await browser.newPage();
      await page.goto(url, { timeout: PAGE_TIMEOUT_MS, waitUntil: 'domcontentloaded' });
      const title = await page.title();
      const bodyText = await page.locator('body').innerText().catch(() => '');
      return { title, url: page.url(), text: truncate(cleanWhitespace(bodyText), FETCH_TEXT_LIMIT) };
    } finally {
      await browser?.close().catch(() => undefined);
    }
  },

  /** Search the web via DuckDuckGo Lite (no API key). Returns up to 8 results. */
  async searchWeb(query: string): Promise<SearchResult[]> {
    const trimmed = query.trim();
    if (!trimmed) throw new Error('Search query must not be empty.');
    let html: string;
    try {
      html = await fetchDuckDuckGoLite(trimmed);
    } catch {
      // Plain fetch failed (blocked or network error); fall through with an
      // empty page so the Chromium fallback below is attempted.
      html = '';
    }
    let results = parseDuckDuckGoLite(html);
    if (results.length === 0) {
      // The plain fetch may have been blocked or returned a challenge page;
      // retry through Chromium and parse the rendered DOM instead.
      let browser: Browser | null = null;
      try {
        browser = await launchBrowser();
        const page = await browser.newPage();
        await page.goto(
          `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(trimmed)}`,
          { timeout: PAGE_TIMEOUT_MS, waitUntil: 'domcontentloaded' },
        );
        const renderedHtml = await page.content();
        results = parseDuckDuckGoLite(renderedHtml);
      } finally {
        await browser?.close().catch(() => undefined);
      }
    }
    return results;
  },

  /** Open a page and fill the given fields. Does NOT submit the form. */
  async fillForm(url: string, fields: FormField[]): Promise<FillOutcome> {
    const urlError = requireHttpUrl(url);
    if (urlError) throw new Error(urlError);
    let browser: Browser | null = null;
    try {
      browser = await launchBrowser();
      const page = await browser.newPage();
      await page.goto(url, { timeout: PAGE_TIMEOUT_MS, waitUntil: 'domcontentloaded' });
      const { filled, missing } = await fillFieldsOnPage(page, fields);
      const summary =
        filled.length === 0
          ? 'No fields could be filled on this page.'
          : missing.length === 0
            ? `Filled ${filled.length} field(s): ${filled.join(', ')}. Form was NOT submitted.`
            : `Filled ${filled.length} field(s): ${filled.join(', ')}. ` +
              `Could not find: ${missing.join(', ')}. Form was NOT submitted.`;
      return { filled, missing, url: page.url(), summary };
    } finally {
      await browser?.close().catch(() => undefined);
    }
  },

  /** Fill the given fields and then click the submit button. */
  async submitForm(url: string, fields: FormField[]): Promise<FillOutcome> {
    const urlError = requireHttpUrl(url);
    if (urlError) throw new Error(urlError);
    let browser: Browser | null = null;
    try {
      browser = await launchBrowser();
      const page = await browser.newPage();
      await page.goto(url, { timeout: PAGE_TIMEOUT_MS, waitUntil: 'domcontentloaded' });
      const { filled, missing } = await fillFieldsOnPage(page, fields);

      let submitted = false;
      const submitButton = page.locator('button[type="submit"], input[type="submit"]').first();
      try {
        if ((await submitButton.count()) > 0 && (await submitButton.isVisible())) {
          await submitButton.click();
          submitted = true;
        }
      } catch {
        submitted = false;
      }
      if (!submitted) {
        try {
          const roleButton = page
            .getByRole('button', { name: /submit|send|search|continue|sign in|log in/i })
            .first();
          if ((await roleButton.count()) > 0) {
            await roleButton.click();
            submitted = true;
          }
        } catch {
          submitted = false;
        }
      }
      if (!submitted) {
        // Last resort: submit the first form on the page directly.
        await page
          .locator('form')
          .first()
          .evaluate((form) => {
            (form as HTMLFormElement).requestSubmit();
          })
          .catch(() => undefined);
        submitted = true;
      }
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);

      const summary =
        `Form submitted from ${page.url()}. ` +
        (missing.length > 0
          ? `Filled ${filled.length} field(s); could not find: ${missing.join(', ')}.`
          : `Filled ${filled.length} field(s).`);
      return { filled, missing, url: page.url(), summary };
    } finally {
      await browser?.close().catch(() => undefined);
    }
  },

  /** Search the web, fetch the top pages, and extract price-like values. */
  async comparePrices(query: string): Promise<PriceHit[]> {
    const results = await this.searchWeb(query);
    const hits: PriceHit[] = [];
    const pricePattern = /\$\s?\d{1,3}(?:,\d{3})*(?:\.\d{2})?/g;
    for (const result of results.slice(0, COMPARE_PAGE_LIMIT)) {
      try {
        const pageText = await this.fetchPageText(result.url);
        const seen = new Set<string>();
        const prices: string[] = [];
        for (const match of pageText.text.matchAll(pricePattern)) {
          const price = match[0].replace(/\s+/g, '');
          if (seen.has(price)) continue;
          seen.add(price);
          const start = Math.max(0, (match.index ?? 0) - PRICE_CONTEXT_CHARS);
          const end = Math.min(
            pageText.text.length,
            (match.index ?? 0) + match[0].length + PRICE_CONTEXT_CHARS,
          );
          prices.push(`${price} - ...${cleanWhitespace(pageText.text.slice(start, end))}...`);
        }
        hits.push({ url: result.url, title: result.title, prices });
      } catch {
        hits.push({ url: result.url, title: result.title, prices: [] });
      }
    }
    return hits;
  },
};

export const browserTools: ToolDefinition[] = [
  {
    name: 'web_lookup',
    description:
      'Fetch a public web page and return its title, URL and readable text (up to ~8000 characters).',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The http(s) URL of the page to fetch.' },
      },
      required: ['url'],
    },
    requiresConfirmation: false,
    handler: async (args, ctx) => {
      const denied = gateBrowse(ctx);
      if (denied) return { ok: false, error: denied };
      const url = toStringArg(args.url);
      const urlError = requireHttpUrl(url);
      if (urlError) return { ok: false, error: urlError };
      try {
        const data = await browserService.fetchPageText(url);
        return { ok: true, data };
      } catch (error) {
        return fail(error);
      }
    },
  },
  {
    name: 'web_search',
    description: 'Search the web and return up to 8 results with title, URL and snippet.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query.' },
      },
      required: ['query'],
    },
    requiresConfirmation: false,
    handler: async (args, ctx) => {
      const denied = gateBrowse(ctx);
      if (denied) return { ok: false, error: denied };
      const query = toStringArg(args.query);
      if (!query.trim()) return { ok: false, error: 'Search query must not be empty.' };
      try {
        const data = await browserService.searchWeb(query);
        return { ok: true, data };
      } catch (error) {
        return fail(error);
      }
    },
  },
  {
    name: 'web_fill_form',
    description:
      'Open a web page in a browser and fill form fields matched by label text, placeholder, or input name. Does NOT submit the form.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The http(s) URL of the page with the form.' },
        fields: {
          type: 'array',
          description: 'Fields to fill, each with a label and a value.',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'Label text, placeholder, or input name.' },
              value: { type: 'string', description: 'Value to enter.' },
            },
            required: ['label', 'value'],
          },
        },
      },
      required: ['url', 'fields'],
    },
    requiresConfirmation: false,
    handler: async (args, ctx) => {
      const denied = gateBrowser(ctx);
      if (denied) return { ok: false, error: denied };
      const url = toStringArg(args.url);
      const urlError = requireHttpUrl(url);
      if (urlError) return { ok: false, error: urlError };
      try {
        const data = await browserService.fillForm(url, toFormFields(args.fields));
        return { ok: true, data };
      } catch (error) {
        return fail(error);
      }
    },
  },
  {
    name: 'web_submit_form',
    description:
      'Open a web page, fill form fields matched by label text, placeholder, or input name, and then submit the form by clicking its submit button.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The http(s) URL of the page with the form.' },
        fields: {
          type: 'array',
          description: 'Fields to fill, each with a label and a value.',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'Label text, placeholder, or input name.' },
              value: { type: 'string', description: 'Value to enter.' },
            },
            required: ['label', 'value'],
          },
        },
      },
      required: ['url', 'fields'],
    },
    requiresConfirmation: true,
    handler: async (args, ctx) => {
      const denied = gateBrowser(ctx);
      if (denied) return { ok: false, error: denied };
      const url = toStringArg(args.url);
      const urlError = requireHttpUrl(url);
      if (urlError) return { ok: false, error: urlError };
      try {
        const data = await browserService.submitForm(url, toFormFields(args.fields));
        return { ok: true, data };
      } catch (error) {
        return fail(error);
      }
    },
  },
  {
    name: 'web_compare_prices',
    description:
      'Search the web for a product, fetch the top result pages, and extract price-like values ($xx.xx) with surrounding context from each page.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The product or item to compare prices for.' },
      },
      required: ['query'],
    },
    requiresConfirmation: false,
    handler: async (args, ctx) => {
      const denied = gateBrowse(ctx);
      if (denied) return { ok: false, error: denied };
      const query = toStringArg(args.query);
      if (!query.trim()) return { ok: false, error: 'Search query must not be empty.' };
      try {
        const data = await browserService.comparePrices(query);
        return { ok: true, data };
      } catch (error) {
        return fail(error);
      }
    },
  },
];
