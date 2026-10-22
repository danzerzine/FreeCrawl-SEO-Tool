import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { DEFAULT_CRAWL_CONFIG } from '@freecrawl/shared-types';
import { Crawler } from './crawler.js';

/*
 * Every request with its arrival time. The first requests of a crawl (start
 * URL probe, robots.txt, sitemap discovery) used to go out back to back
 * whatever the rate limit said.
 */
let server: Server;
let dir: string;
let base: string;
const hits: { url: string; at: number }[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'b52-'));
  server = createServer((req, res) => {
    const url = req.url ?? '';
    hits.push({ url: `${req.method} ${url}`, at: Date.now() });
    if (url === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end(`User-agent: *\nAllow: /\nSitemap: ${base}/sm.xml\n`);
      return;
    }
    if (url === '/sm.xml') {
      res
        .writeHead(200, { 'content-type': 'application/xml' })
        .end(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${base}/a</loc></url></urlset>`);
      return;
    }
    if (url.startsWith('/sitemap')) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'text/html' }).end('<html><head><title>t</title></head><body><a href="/a">a</a></body></html>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  hits.length = 0;
});

async function crawl(name: string, respectRobotsTxt: boolean): Promise<void> {
  const db = new ProjectDb(join(dir, `${name}.seoproject`));
  const c = new Crawler(
    {
      ...DEFAULT_CRAWL_CONFIG,
      startUrl: `${base}/`,
      maxUrls: 3,
      maxConcurrency: 4,
      maxRps: 1,
      respectRobotsTxt,
      discoverSitemaps: true,
      checkImages: false,
      checkCss: false,
      checkJs: false,
    },
    db,
  );
  await c.start();
  db.close();
}

function gaps(): number[] {
  const first = hits.slice(0, 5);
  return first.slice(1).map((h, i) => h.at - first[i]!.at);
}

it('with --rps 1 the first five requests are spaced about a second apart (B52)', async () => {
  await crawl('rate', true);
  expect(hits.length).toBeGreaterThanOrEqual(5);
  for (const g of gaps()) expect(g).toBeGreaterThanOrEqual(900);
}, 60000);

it('robots.txt is fetched once when it is respected (B52)', async () => {
  await crawl('once', true);
  expect(hits.filter((h) => h.url.endsWith('/robots.txt'))).toHaveLength(1);
  // Its Sitemap: line was still used.
  expect(hits.some((h) => h.url.endsWith('/sm.xml'))).toBe(true);
}, 60000);

it('ignoring robots.txt, discovery still reads it for Sitemap: lines, through the gate (B52)', async () => {
  await crawl('norobots', false);
  expect(hits.filter((h) => h.url.endsWith('/robots.txt'))).toHaveLength(1);
  for (const g of gaps()) expect(g).toBeGreaterThanOrEqual(900);
}, 60000);
