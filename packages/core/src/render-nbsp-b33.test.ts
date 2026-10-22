import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { DEFAULT_CRAWL_CONFIG } from '@freecrawl/shared-types';
import { BrowserPool, PlaywrightBrowserMissingError } from './browser-pool.js';
import { Crawler } from './crawler.js';
import { estimatePixelWidth, parseHtml, readServedPageSignals } from './html-parser.js';
import { browserPoolOptionsFromConfig, createRenderHook } from './render-config.js';

// B33 acceptance r1: a literal U+00A0 in served UTF-8 HTML. Chromium's page.content() writes it back as
// `&nbsp;`; the served and rendered sides must still agree on the H1 and on the word count.
const NB = ' ';
const PARA =
  'В' + NB + 'этом' + NB + 'году' + NB + 'мы' + NB + 'не' + NB + 'раз' + NB + 'писали' + NB + 'о' + NB + 'том, что' + NB + 'на' + NB + 'улице' + NB + 'и' + NB + 'в' + NB + 'доме ' +
  'слово '.repeat(110);
const PAGE = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Новости</title></head><body><h1>Новости${NB}дня</h1><p>${PARA}</p></body></html>`;

describe('real Chromium: literal U+00A0 is not a rendering change', () => {
  let server: Server;
  let dir: string;
  let base: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fc-m11-nbsp-'));
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(Buffer.from(PAGE, 'utf8'));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  });
  afterAll(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('crawl: js_h1_changed and js_text_changed are 0', async () => {
    const config = {
      ...DEFAULT_CRAWL_CONFIG,
      startUrl: base,
      renderingMode: 'js' as const,
      maxConcurrency: 1,
      discoverSitemaps: false,
      checkExternalLinks: false,
      probeTlsCerts: false,
      probeManifestJson: false,
      probeSocialImages: false,
      probeImageSizes: false,
      jsRender: { ...DEFAULT_CRAWL_CONFIG.jsRender },
    };
    const pool = new BrowserPool(browserPoolOptionsFromConfig(config));
    const db = new ProjectDb(join(dir, 'p.seoproject'));
    try {
      try {
        await pool.start();
      } catch (err) {
        if (err instanceof PlaywrightBrowserMissingError) {
          console.warn('SKIPPED: Chromium is not installed (', (err as Error).message, ')');
          return;
        }
        throw err;
      }
      const c = new Crawler(config, db, { renderUrl: createRenderHook(pool, config) });
      c.on('error', () => {});
      await c.start();
      const row = db.getUrlById(db.getUrlIdByUrl(base)!)!;
      expect([row.jsH1Changed, row.jsTextChanged], String(row.renderDiff)).toEqual([0, 0]);
    } finally {
      await pool.close();
      db.close();
    }
  }, 60_000);
});

describe('served and rendered side agree without a browser', () => {
  const rendered = PAGE.replaceAll(NB, '&nbsp;');
  it('H1 and word count are equal', () => {
    const served = readServedPageSignals(PAGE, 'https://ex.com/');
    const r = parseHtml(rendered, 'https://ex.com/');
    expect(r.h1).toBe(served.h1);
    expect(r.wordCount).toBe(served.words);
    expect(parseHtml(PAGE, 'https://ex.com/').wordCount).toBe(served.words);
  });
});

describe('&nbsp; keeps the old plain-space behaviour', () => {
  const t = (inner: string) => parseHtml(`<html><head><title>${inner}</title></head><body><h1>${inner}</h1></body></html>`, 'https://ex.com/');
  it('title, H1 and its pixel width equal the plain-space version', () => {
    const a = t('Tips&nbsp;and&nbsp;notes');
    const b = t('Tips and notes');
    expect(a.title).toBe('Tips and notes');
    expect(a.h1).toBe('Tips and notes');
    expect(estimatePixelWidth(a.title ?? '')).toBe(estimatePixelWidth(b.title ?? ''));
    expect(readServedPageSignals('<h1>a&nbsp;b</h1>', 'https://ex.com/').h1).toBe('a b');
  });
});

describe('attribute values decode with attribute rules', () => {
  const m = (content: string) =>
    parseHtml(`<html><head><meta name="description" content="${content}"><meta property="og:title" content="${content}"></head><body></body></html>`, 'https://ex.com/');
  it('a legacy entity without semicolon stays literal inside an attribute', () => {
    expect(m('Tips&notes').metaDescription).toBe('Tips&notes');
  });
  it('&amp; and &#38; still decode', () => {
    expect(m('a &amp; b &#38; c').metaDescription).toBe('a & b & c');
  });
});
