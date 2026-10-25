import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COVERAGE_CHECKS, ProjectDb } from '@freecrawl/db';
import { DEFAULT_CRAWL_CONFIG, DEFAULT_SEO_THRESHOLDS, type CrawlConfig, type SeoThresholds } from '@freecrawl/shared-types';
import { coverageFiles, type CoverageSummary } from './coverage.js';
import { Crawler } from './crawler.js';
import { datasetRows } from './dataset-export.js';
import { fakeRender } from './fake-render.test-support.js';

// B44b: coverage per stylesheet and script file, the table of files, and the
// css-unused / js-unused checks with their threshold. Fake render hook, no browser.

describe('coverageFiles', () => {
  it('one entry per external file with its size and unused part, most unused first; inline code is left out', () => {
    const files = coverageFiles(
      [
        { url: 'https://s.test/a.css', text: 'x'.repeat(1000), ranges: [{ start: 0, end: 300 }] },
        { url: 'https://s.test/page', text: 'y'.repeat(50), ranges: [] },
        { url: '', text: 'z'.repeat(10), ranges: [] },
      ],
      [
        {
          url: 'https://s.test/app.js',
          source: 'j'.repeat(100),
          functions: [{ ranges: [{ startOffset: 0, endOffset: 100, count: 1 }, { startOffset: 20, endOffset: 40, count: 0 }] }],
        },
        { url: 'https://s.test/page', source: 'k'.repeat(500), functions: [] },
      ],
      ['https://s.test/page'],
    );
    expect(files).toEqual([
      { url: 'https://s.test/a.css', kind: 'css', bytes: 1000, unusedBytes: 700 },
      { url: 'https://s.test/app.js', kind: 'js', bytes: 100, unusedBytes: 20 },
    ]);
  });

  it('a file reported twice is one entry; at most 100 entries, the most unused kept', () => {
    const css = Array.from({ length: 120 }, (_, i) => ({
      url: `https://s.test/${i}.css`,
      text: 'x'.repeat(100 + i),
      ranges: [] as { start: number; end: number }[],
    }));
    css.push({ url: 'https://s.test/0.css', text: 'x'.repeat(100), ranges: [] });
    const files = coverageFiles(css, [], []);
    expect(files).toHaveLength(100);
    expect(files[0]).toEqual({ url: 'https://s.test/119.css', kind: 'css', bytes: 219, unusedBytes: 219 });
    // 1.css (101) is among the 20 least unused and dropped; 0.css, reported twice, adds up to 200 and stays.
    expect(files.some((f) => f.url === 'https://s.test/1.css')).toBe(false);
    expect(files.find((f) => f.url === 'https://s.test/0.css')?.bytes).toBe(200);
    expect(coverageFiles([...css.slice(0, 1), css.at(-1)!], [], [])).toEqual([
      { url: 'https://s.test/0.css', kind: 'css', bytes: 200, unusedBytes: 200 },
    ]);
  });
});

const page = (links: string): string => `<html><head><title>T</title></head><body><h1>H</h1>${links}</body></html>`;
let server: Server;
let dir: string;
let base: string;
const realFetch = globalThis.fetch;
beforeAll(async () => {
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const host = new URL(typeof input === 'string' || input instanceof URL ? input : input.url).hostname;
    if (host !== '127.0.0.1') return Promise.reject(new Error(`blocked fetch to ${host}`));
    return realFetch(input, init);
  }) as typeof fetch;
  dir = mkdtempSync(join(tmpdir(), 'fc-b44b-'));
  server = createServer((req, res) => {
    void res.writeHead(200, { 'content-type': 'text/html' }).end(page(req.url === '/' ? '<a href="/b">b</a>' : ''));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

const SITE_CSS = 'https://cdn.test/site.css';
const APP_JS = 'https://cdn.test/app.js';
/** Home: 66 % of 30 000 CSS unused, 30 % of 100 000 JS unused. */
const COV_HOME: CoverageSummary = {
  cssBytes: 30_000,
  cssUnusedBytes: 20_000,
  jsBytes: 100_000,
  jsUnusedBytes: 30_000,
  files: [
    { url: APP_JS, kind: 'js', bytes: 100_000, unusedBytes: 30_000 },
    { url: SITE_CSS, kind: 'css', bytes: 30_000, unusedBytes: 20_000 },
  ],
};
/** /b: 75 % of a small stylesheet unused, under the 10 KB floor. */
const COV_B: CoverageSummary = {
  cssBytes: 12_000,
  cssUnusedBytes: 9_000,
  jsBytes: 0,
  jsUnusedBytes: 0,
  files: [{ url: SITE_CSS, kind: 'css', bytes: 12_000, unusedBytes: 9_000 }],
};

let n = 0;
async function crawl(o: { coverage?: boolean; db?: ProjectDb; thresholds?: Partial<SeoThresholds> } = {}) {
  const db = o.db ?? new ProjectDb(join(dir, `p${n++}.seoproject`));
  const config: CrawlConfig = {
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
    jsRender: { ...DEFAULT_CRAWL_CONFIG.jsRender, coverage: o.coverage ?? true },
    ...(o.thresholds ? { seoThresholds: { ...DEFAULT_SEO_THRESHOLDS, ...o.thresholds } } : {}),
  };
  const hook = fakeRender(
    { [base]: page('<a href="/b">b</a>'), [`${base}b`]: page('') },
    (url) => ({ coverage: url === base ? COV_HOME : COV_B }),
  );
  const c = new Crawler(config, db, { renderUrl: hook });
  c.on('error', () => {});
  await c.start();
  return db;
}
const listed = (db: ProjectDb, k: string): string[] =>
  db.queryUrls({ limit: 20, offset: 0, category: `issues:${k}` as never }).rows.map((r) => r.url.replace(base, '/')).sort();

describe('crawl: the files table (B44b)', () => {
  it('lists each file once with the pages that loaded it, its size and its unused part', async () => {
    const db = await crawl();
    expect([...datasetRows(db, 'coverage-files')]).toEqual([
      // site.css: 20 000 + 9 000 unused of 30 000 + 12 000 loaded.
      { url: APP_JS, kind: 'js', pages: 1, bytes: 100_000, unusedMin: 30_000, unusedPct: 30, unusedTotal: 30_000 },
      { url: SITE_CSS, kind: 'css', pages: 2, bytes: 30_000, unusedMin: 9_000, unusedPct: 69, unusedTotal: 29_000 },
    ]);
    db.close();
  }, 30_000);

  it('a refresh with coverage off leaves no files', async () => {
    const db = await crawl();
    await crawl({ coverage: false, db });
    expect([...datasetRows(db, 'coverage-files')]).toEqual([]);
    db.close();
  }, 30_000);
});

describe('crawl: css-unused and js-unused (B44b)', () => {
  it('default thresholds: over 50 % unused and at least 10 KB of CSS / 20 KB of JS', async () => {
    expect(DEFAULT_SEO_THRESHOLDS.cssUnusedPct).toBe(50);
    expect(DEFAULT_SEO_THRESHOLDS.jsUnusedPct).toBe(50);
    const db = await crawl();
    expect(listed(db, 'css-unused')).toEqual(['/']);
    expect(listed(db, 'js-unused')).toEqual([]);
    for (const k of COVERAGE_CHECKS) expect(db.checksFilled().has(k)).toBe(true);
    db.close();
  }, 30_000);

  it('the threshold comes from the crawl settings', async () => {
    const db = await crawl({ thresholds: { jsUnusedPct: 25, cssUnusedPct: 70 } });
    expect(listed(db, 'js-unused')).toEqual(['/']);
    expect(listed(db, 'css-unused')).toEqual([]);
    db.close();
  }, 30_000);

  it('coverage off: nothing listed and the checks are not filled', async () => {
    const db = await crawl({ coverage: false });
    expect(listed(db, 'css-unused')).toEqual([]);
    for (const k of COVERAGE_CHECKS) expect(db.checksFilled().has(k)).toBe(false);
    db.close();
  }, 30_000);
});
