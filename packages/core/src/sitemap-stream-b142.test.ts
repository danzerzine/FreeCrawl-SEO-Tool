import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { DEFAULT_CRAWL_CONFIG } from '@freecrawl/shared-types';
import { Crawler } from './crawler.js';

/*
 * A crawl seeded only by a sitemap index of 30 files × 10 URLs used to
 * fetch no page until the whole index was read.
 */
let server: Server;
let dir: string;
let base: string;
const hits: { url: string; at: number }[] = [];

const xml = (body: string) => `<?xml version="1.0"?>${body}`;
const NS = 'xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"';

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'b142-'));
  server = createServer((req, res) => {
    const url = req.url ?? '/';
    hits.push({ url, at: Date.now() });
    if (url === '/robots.txt') return void res.writeHead(404).end();
    if (url === '/index.xml') {
      const files = Array.from({ length: 30 }, (_, i) => `<sitemap><loc>${base}/part-${i}.xml</loc></sitemap>`);
      return void res
        .writeHead(200, { 'content-type': 'application/xml' })
        .end(xml(`<sitemapindex ${NS}>${files.join('')}</sitemapindex>`));
    }
    const part = /^\/part-(\d+)\.xml$/.exec(url);
    if (part) {
      const locs = Array.from({ length: 10 }, (_, k) => `<url><loc>${base}/s/${part[1]}-${k}</loc></url>`);
      return void res
        .writeHead(200, { 'content-type': 'application/xml' })
        .end(xml(`<urlset ${NS}>${locs.join('')}</urlset>`));
    }
    // The start page and every seed: no links.
    res.writeHead(200, { 'content-type': 'text/html' }).end('<html><head><title>t</title></head><body></body></html>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

it('queues sitemap seeds as each file is read, within the rate limit', async () => {
  const file = join(dir, 'seeds.seoproject');
  const db = new ProjectDb(file);
  try {
    await new Crawler(
      {
        ...DEFAULT_CRAWL_CONFIG,
        startUrl: `${base}/`,
        maxRps: 5,
        maxConcurrency: 4,
        discoverSitemaps: false,
        seedSitemapUrls: [`${base}/index.xml`],
      },
      db,
    ).start();
  } finally {
    db.close();
  }
  const firstSeed = hits.findIndex((h) => h.url.startsWith('/s/'));
  const lastPart = hits.map((h) => h.url.startsWith('/part-')).lastIndexOf(true);
  expect(firstSeed).toBeGreaterThan(-1);
  expect(firstSeed).toBeLessThan(lastPart);
  // At most 5 requests in any 1 s window, sitemap files included: any six
  // in a row span a second, less 10 % for arrival jitter (as in B52).
  for (let i = 0; i + 5 < hits.length; i++) {
    expect(hits[i + 5]!.at - hits[i]!.at).toBeGreaterThanOrEqual(900);
  }
  const raw = new DatabaseSync(file, { readOnly: true });
  // Wait for a writer's lock instead of failing with `database is locked`.
  raw.exec('PRAGMA busy_timeout = 10000');
  try {
    const one = (sql: string) => (raw.prepare(sql).get() as { n: number }).n;
    expect(one("SELECT COUNT(*) AS n FROM urls WHERE url LIKE '%/s/%' AND status_code = 200")).toBe(300);
    // The sitemap findings are what reading the whole index first gave.
    expect(one('SELECT COUNT(*) AS n FROM sitemap_urls')).toBe(300);
    expect(
      raw.prepare('SELECT status_code AS status, url_count AS urls, child_count AS children, COUNT(*) AS n FROM sitemap_files GROUP BY 1, 2, 3 ORDER BY 4').all(),
    ).toEqual([
      { status: 200, urls: 0, children: 30, n: 1 },
      { status: 200, urls: 10, children: 0, n: 30 },
    ]);
  } finally {
    raw.close();
  }
}, 300000);
