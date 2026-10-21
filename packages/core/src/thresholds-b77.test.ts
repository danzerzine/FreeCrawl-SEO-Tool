import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import {
  DEFAULT_CRAWL_CONFIG,
  DEFAULT_SEO_THRESHOLDS,
  type CrawlConfig,
  type UrlCategory,
} from '@freecrawl/shared-types';
import { compareCrawls } from './compare.js';
import { Crawler } from './crawler.js';
import { estimatePixelWidth } from './html-parser.js';

/*
 * One page per boundary: /t60 and /t61 titles, /t29 and /t30, /d155 and
 * /d156 descriptions, /d69 and /d70, /w199 and /w200 words, and /px with a
 * two-letter title and a one-word description (both narrow in pixels).
 */
const title = (n: number) => 'Title of the page '.padEnd(n, 'x');
const desc = (n: number) => 'Description of the page '.padEnd(n, 'd');
const words = (n: number) => Array.from({ length: n }, () => 'word').join(' ');
const NORMAL = { title: title(45), desc: desc(110), words: 250 };
const PAGES: Record<string, { title: string; desc: string; words: number }> = {
  '/': NORMAL,
  '/t60': { ...NORMAL, title: title(60) },
  '/t61': { ...NORMAL, title: title(61) },
  '/t29': { ...NORMAL, title: title(29) },
  '/t30': { ...NORMAL, title: title(30) },
  '/d155': { ...NORMAL, desc: desc(155) },
  '/d156': { ...NORMAL, desc: desc(156) },
  '/d69': { ...NORMAL, desc: desc(69) },
  '/d70': { ...NORMAL, desc: desc(70) },
  '/w199': { ...NORMAL, words: 199 },
  '/w200': { ...NORMAL, words: 200 },
  '/px': { ...NORMAL, title: 'Hi', desc: 'Short' },
};

let server: Server;
let dir: string;
let base: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'b77-'));
  server = createServer((req, res) => {
    const p = PAGES[req.url ?? ''];
    if (!p) return void res.writeHead(404).end();
    const links = req.url === '/' ? Object.keys(PAGES).map((h) => `<a href="${h}">${h}</a>`).join('') : '';
    res
      .writeHead(200, { 'content-type': 'text/html' })
      .end(
        `<html><head><title>${p.title}</title><meta name="description" content="${p.desc}"></head><body><main><h1>Heading</h1><p>${words(p.words)}</p></main>${links}</body></html>`,
      );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

async function crawl(name: string, config: Partial<CrawlConfig> = {}): Promise<ProjectDb> {
  const db = new ProjectDb(join(dir, name));
  const c = new Crawler(
    {
      ...DEFAULT_CRAWL_CONFIG,
      startUrl: `${base}/`,
      maxConcurrency: 4,
      discoverSitemaps: false,
      checkExternalLinks: false,
      probeTlsCerts: false,
      probeManifestJson: false,
      probeSocialImages: false,
      probeImageSizes: false,
      ...config,
    },
    db,
  );
  c.on('error', () => {});
  await c.start();
  return db;
}

const list = (db: ProjectDb, category: UrlCategory) =>
  db
    .queryUrls({ limit: 100, offset: 0, category })
    .rows.map((r) => r.url.slice(base.length))
    .sort();

describe('B77 thresholds', () => {
  let db: ProjectDb;
  beforeAll(async () => {
    db = await crawl('default.seoproject');
  }, 60_000);
  afterAll(() => db.close());

  it('defaults: title 30–60 chars, description 70–155, thin under 200 words', () => {
    expect(DEFAULT_SEO_THRESHOLDS).toMatchObject({
      titleMinChars: 30,
      titleMaxChars: 60,
      descriptionMinChars: 70,
      descriptionMaxChars: 155,
      thinContentWords: 200,
      titleMinPx: 200,
      titleMaxPx: 600,
      descriptionMinPx: 400,
      descriptionMaxPx: 990,
    });
    expect(list(db, 'issues:title-too-long')).toEqual(['/t61']);
    expect(list(db, 'issues:title-too-short')).toEqual(['/px', '/t29']);
    expect(list(db, 'issues:meta-too-long')).toEqual(['/d156']);
    expect(list(db, 'issues:meta-too-short')).toEqual(['/d69', '/px']);
    expect(list(db, 'issues:content-thin')).toEqual(['/w199']);
    const o = db.getOverviewCounts();
    expect([o.issues.titleTooLong, o.issues.metaTooLong, o.issues.contentThin]).toEqual([1, 1, 1]);
    expect(o.thresholds).toEqual(DEFAULT_SEO_THRESHOLDS);
  });

  it('lower pixel limits: a title under 200 px and a description under 400 px', () => {
    expect(list(db, 'issues:title-pixel-width-too-short')).toEqual(['/px']);
    expect(list(db, 'issues:meta-pixel-width-too-short')).toEqual(['/px']);
    const o = db.getOverviewCounts();
    expect([o.issues.titlePixelWidthTooShort, o.issues.metaPixelWidthTooShort]).toEqual([1, 1]);
  });

  it('a changed setting changes the list, the count and the thresholds the labels read', async () => {
    const other = await crawl('changed.seoproject');
    other.applyCrawlConfigFlags({ seoThresholds: { titleMaxChars: 61, thinContentWords: 201 } });
    expect(list(other, 'issues:title-too-long')).toEqual([]);
    expect(list(other, 'issues:content-thin')).toEqual(['/w199', '/w200']);
    const o = other.getOverviewCounts();
    expect([o.issues.titleTooLong, o.issues.contentThin]).toEqual([0, 2]);
    expect(o.thresholds?.titleMaxChars).toBe(61);
    expect(o.thresholds?.descriptionMaxChars).toBe(155);
    other.close();
  }, 60_000);

  it('the crawl config sets them, and compare names the checks whose thresholds differ as not comparable', async () => {
    const wide = await crawl('wide.seoproject', { seoThresholds: { descriptionMaxChars: 160 } });
    expect(list(wide, 'issues:meta-too-long')).toEqual([]);
    const s = compareCrawls(db, wide);
    expect(Object.keys(s.notComparable)).toContain('issues:meta-too-long');
    expect(Object.keys(s.notComparable)).not.toContain('issues:title-too-long');
    expect(s.notComparable['issues:meta-too-long']?.reason).toMatch(/threshold/);
    wide.close();
  }, 60_000);
});

it('Cyrillic titles measured within ±5% of a browser canvas (Arial 18 px) (B77)', () => {
  // Widths measured in Chromium: canvas 2d, font '18px Arial', measureText.
  const CANVAS: [string, number][] = [
    ['Как выбрать зимние шины: советы экспертов и рейтинг 2026', 508.9],
    ['ДОСТАВКА ЦВЕТОВ В МОСКВЕ — КРУГЛОСУТОЧНО', 455.22],
    ['Купить смартфон недорого в интернет-магазине «Связной»', 500.41],
    ['Щедрые скидки на мебель № 1 в Казахстане', 375.1],
    ['Новости дня: главное о политике, экономике и обществе', 476.75],
  ];
  for (const [text, px] of CANVAS) {
    const ours = estimatePixelWidth(text);
    expect(Math.abs(ours - px) / px, text).toBeLessThanOrEqual(0.05);
  }
});
