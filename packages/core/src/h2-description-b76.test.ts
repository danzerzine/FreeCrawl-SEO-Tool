import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { DEFAULT_CRAWL_CONFIG, type CrawlConfig, type UrlCategory } from '@freecrawl/shared-types';
import { Crawler } from './crawler.js';

/*
 * /a and /b share an H2 (whitespace differs), /c has none, /d's H2 is its
 * own. Descriptions: /a escaped `&lt;b&gt;`, /d a raw tag, /c a bare `<`
 * in plain text (not HTML). The sitemap also lists two pages nothing links.
 */
let server: Server;
let dir: string;
let base: string;
const PAGES: Record<string, { h2: string; desc: string }> = {
  '/': { h2: '<h2>Home</h2>', desc: 'Home page description' },
  '/a': { h2: '<h2>Same heading</h2>', desc: 'Read &lt;b&gt;bold&lt;/b&gt; text' },
  '/b': { h2: '<h2> Same \n  heading </h2>', desc: 'Plain text' },
  '/c': { h2: '', desc: 'Price &lt; 5 and 3 &gt; 1' },
  '/d': { h2: '<h2>Other</h2>', desc: 'Has <a href=x> tag' },
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'b76-'));
  server = createServer((req, res) => {
    const url = req.url ?? '';
    if (url === '/robots.txt') return void res.writeHead(200).end(`Sitemap: ${base}/sitemap.xml\n`);
    if (url === '/sitemap.xml') {
      const locs = ['/', '/a', '/b', '/c', '/d', '/only-in-sitemap-1', '/only-in-sitemap-2'];
      return void res
        .writeHead(200, { 'content-type': 'application/xml' })
        .end(
          `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs.map((p) => `<url><loc>${base}${p}</loc></url>`).join('')}</urlset>`,
        );
    }
    const p = PAGES[url];
    if (!p) return void res.writeHead(404).end();
    const links = url === '/' ? ['/a', '/b', '/c', '/d'].map((h) => `<a href="${h}">${h}</a>`).join('') : '';
    res
      .writeHead(200, { 'content-type': 'text/html' })
      .end(
        `<html><head><title>A page title long enough ${url}</title><meta name="description" content="${p.desc}"></head><body><h1>Page ${url}</h1>${p.h2}${links}</body></html>`,
      );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

async function crawl(db: ProjectDb, config: Partial<CrawlConfig>): Promise<void> {
  const c = new Crawler(
    {
      ...DEFAULT_CRAWL_CONFIG,
      startUrl: `${base}/`,
      maxConcurrency: 1,
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
}

const list = (db: ProjectDb, category: UrlCategory) =>
  db
    .queryUrls({ limit: 50, offset: 0, category })
    .rows.map((r) => r.url.slice(base.length))
    .sort();

it('H2 missing and duplicate, HTML in the description (B76)', async () => {
  const db = new ProjectDb(join(dir, 'p.seoproject'));
  await crawl(db, { maxUrls: 50 });
  expect(list(db, 'issues:h2-missing')).toEqual(['/c']);
  expect(list(db, 'issues:h2-duplicate')).toEqual(['/a', '/b']);
  expect(list(db, 'issues:description-has-html')).toEqual(['/a', '/d']);
  const o = db.getOverviewCounts();
  expect([o.issues.h2Missing, o.issues.h2Duplicate, o.issues.descriptionHasHtml]).toEqual([1, 2, 2]);
  expect(o.site?.crawlStoppedAtLimit ?? null).toBeNull();
  db.close();
}, 60_000);

it('sitemap URLs not crawled: counted, listed, and a crawl stopped at its page limit says so (B76)', async () => {
  const db = new ProjectDb(join(dir, 'capped.seoproject'));
  await crawl(db, { maxUrls: 3, discoverSitemaps: true });
  const o = db.getOverviewCounts();
  expect(o.site?.crawlStoppedAtLimit).toBe(3);
  expect(o.issues.sitemapNotCrawled).toBeGreaterThanOrEqual(2);
  expect(db.sitemapOrphans().map((r) => r.url)).toEqual(
    expect.arrayContaining([`${base}/only-in-sitemap-1`, `${base}/only-in-sitemap-2`]),
  );
  db.close();
}, 60_000);
