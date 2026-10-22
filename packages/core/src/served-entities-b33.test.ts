import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import { ProjectDb } from '@freecrawl/db';
import { DEFAULT_CRAWL_CONFIG } from '@freecrawl/shared-types';
import { Crawler } from './crawler.js';
import { fakeRender } from './fake-render.test-support.js';
import { readServedPageSignals } from './html-parser.js';

// B33 false positive found live (apache.org): the served H1 `Good&para;` was read as the literal
// text `&para;` while the browser's DOM says `¶`. The served side must decode like a browser.
const PAGE = 'https://ex.com/p';
const h1Of = (inner: string) => readServedPageSignals(`<html><body><h1>${inner}</h1></body></html>`, PAGE).h1;
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

const CASES: [string, string, string][] = [
  ['named ¶', 'Good&para;', 'Good¶'],
  ['nbsp', 'a&nbsp;b', 'a b'],
  ['amp', 'Tom &amp; Jerry', 'Tom & Jerry'],
  ['hellip', 'Wait&hellip;', 'Wait…'],
  ['decimal', 'x&#182;', 'x¶'],
  ['hex', 'x&#xB6;', 'x¶'],
  ['unknown entity stays', 'a&foo;b', 'a&foo;b'],
  ['legacy entity without semicolon', '&copy 2026', '© 2026'],
  ['entity outside the old table', '&euro;5 &rarr; &Omega; &hearts;', '€5 → Ω ♥'],
  ['out-of-range number does not throw', 'x&#99999999;y', 'x�y'],
];

describe('readServedPageSignals decodes entities like a browser', () => {
  for (const [name, inner, expected] of CASES) {
    it(name, () => {
      expect(norm(h1Of(inner) ?? '')).toBe(expected);
    });
  }

  it('against a real Chromium DOM', async () => {
    let browser;
    try {
      browser = await chromium.launch();
    } catch (err) {
      console.warn('SKIPPED: Chromium is not installed (', (err as Error).message, ')');
      return;
    }
    try {
      const page = await browser.newPage();
      for (const [name, inner] of CASES) {
        await page.setContent(`<html><body><h1>${inner}</h1></body></html>`);
        const dom = String(await page.evaluate("document.querySelector('h1').textContent"));
        expect(norm(h1Of(inner) ?? ''), name).toBe(norm(dom));
      }
    } finally {
      await browser.close();
    }
  }, 60_000);
});

describe('crawl: H1 that differs only by entity encoding is not a change', () => {
  let server: Server;
  let dir: string;
  let base: string;
  const served = '<html><head><title>T</title></head><body><h1>Software for the Good&para; &amp; &copy 2026</h1></body></html>';
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fc-m11-ent-'));
    server = createServer((_req, res) => void res.writeHead(200, { 'content-type': 'text/html' }).end(served));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  });
  afterAll(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('verdict 0 and no detail', async () => {
    const rendered = '<html><head><title>T</title></head><body><h1>Software for the Good¶ &amp; © 2026</h1></body></html>';
    const db = new ProjectDb(join(dir, 'p.seoproject'));
    const c = new Crawler(
      {
        ...DEFAULT_CRAWL_CONFIG,
        startUrl: base,
        renderingMode: 'js',
        maxConcurrency: 1,
        discoverSitemaps: false,
        checkExternalLinks: false,
        probeTlsCerts: false,
        probeManifestJson: false,
        probeSocialImages: false,
        probeImageSizes: false,
        jsRender: { ...DEFAULT_CRAWL_CONFIG.jsRender },
      },
      db,
      { renderUrl: fakeRender({ [base]: rendered }) },
    );
    c.on('error', () => {});
    await c.start();
    const row = db.getUrlById(db.getUrlIdByUrl(base)!)!;
    expect(row.jsH1Changed).toBe(0);
    expect(row.renderDiff).toBeNull();
    db.close();
  });
});
