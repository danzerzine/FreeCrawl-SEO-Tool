import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { DEFAULT_CRAWL_CONFIG, type CrawlConfig, type UrlCategory } from '@freecrawl/shared-types';
import { Crawler } from './crawler.js';

/*
 * Each page declares an AMP version: /a → /a/amp (200), /b → /b/amp (404),
 * /c → /c/amp (301), /d → /blocked/amp (disallowed by robots.txt), /e → an
 * external host's /amp (404), /f → /a/amp again. No page links to an AMP
 * URL, so only the probe requests them.
 */
let server: Server;
let external: Server;
let dir: string;
let base: string;
let extBase: string;
const hits: string[] = [];
const AMP: Record<string, () => string> = {
  '/a': () => `${base}/a/amp`,
  '/b': () => `${base}/b/amp`,
  '/c': () => `${base}/c/amp`,
  '/d': () => `${base}/blocked/amp`,
  '/e': () => `${extBase}/amp`,
  '/f': () => `${base}/a/amp`,
};
const page = (head: string, body: string) =>
  `<html><head><title>A page title long enough</title>${head}</head><body>${body}</body></html>`;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'b24-'));
  server = createServer((req, res) => {
    const url = req.url ?? '';
    hits.push(url);
    if (url === '/robots.txt') return void res.writeHead(200).end('User-agent: *\nDisallow: /blocked/\n');
    if (url === '/') {
      const links = Object.keys(AMP).map((p) => `<a href="${p}">${p}</a>`).join('');
      return void res.writeHead(200, { 'content-type': 'text/html' }).end(page('', links));
    }
    const amp = AMP[url];
    if (amp) {
      return void res
        .writeHead(200, { 'content-type': 'text/html' })
        .end(page(`<link rel="amphtml" href="${amp()}">`, 'x'));
    }
    if (url === '/a/amp') return void res.writeHead(200, { 'content-type': 'text/html' }).end(page('', 'amp'));
    if (url === '/c/amp') return void res.writeHead(301, { location: '/c' }).end();
    res.writeHead(404).end();
  });
  external = createServer((req, res) => {
    hits.push(`ext${req.url}`);
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  await new Promise<void>((r) => external.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  // Another host name for the same loopback address: an external host.
  extBase = `http://localhost:${(external.address() as { port: number }).port}`;
});
afterAll(() => {
  server.close();
  external.close();
  rmSync(dir, { recursive: true, force: true });
});

async function crawl(db: ProjectDb, config: Partial<CrawlConfig>, resumeOnly = false): Promise<void> {
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
    { resumeOnly },
  );
  c.on('error', () => {});
  await c.start();
}

const list = (db: ProjectDb, category: UrlCategory) =>
  db
    .queryUrls({ limit: 50, offset: 0, category })
    .rows.map((r) => r.url.slice(base.length))
    .sort();

it('each AMP target is requested once and its answer flags the page; robots.txt and resume respected (B24)', async () => {
  hits.length = 0;
  const db = new ProjectDb(join(dir, 'p.seoproject'));
  // Stop after the home page and /a, /b: /a/amp is probed in the first part.
  await crawl(db, { maxUrls: 3 });
  expect(hits.filter((h) => h === '/a/amp')).toHaveLength(1);
  await crawl(db, { maxUrls: 50 }, true);

  expect(hits.filter((h) => h === '/a/amp')).toHaveLength(1);
  expect(hits).not.toContain('/blocked/amp');
  expect(hits.filter((h) => h.startsWith('ext/amp')).length).toBeGreaterThan(0);
  // Probed, not crawled.
  expect(db.getUrlIdByUrl(`${base}/a/amp`)).toBeNull();

  expect(list(db, 'issues:amp-target-broken')).toEqual(['/b', '/e']);
  expect(list(db, 'issues:amp-target-redirect')).toEqual(['/c']);
  const targets = new Map(db.listAmpTargets().map((t) => [t.url, t]));
  expect(targets.get(`${base}/blocked/amp`)).toMatchObject({ status: null, blocked: true });
  expect(targets.get(`${base}/c/amp`)).toMatchObject({ status: 301, redirectTarget: `${base}/c` });
  const i = db.getOverviewCounts().issues;
  expect([i.ampTargetBroken, i.ampTargetRedirect]).toEqual([2, 1]);
  db.close();
}, 60_000);

it('with AMP crawling on, the targets are crawled pages and the checks read them', async () => {
  hits.length = 0;
  const db = new ProjectDb(join(dir, 'crawl-amp.seoproject'));
  await crawl(db, { maxUrls: 50, crawlAmp: true });
  expect(hits.filter((h) => h === '/a/amp')).toHaveLength(1);
  expect(db.listAmpTargets()).toEqual([]);
  expect(list(db, 'issues:amp-target-broken')).toContain('/b');
  expect(list(db, 'issues:amp-target-redirect')).toEqual(['/c']);
  db.close();
}, 60_000);

it('with AMP storing off, nothing is probed', async () => {
  hits.length = 0;
  const db = new ProjectDb(join(dir, 'no-amp.seoproject'));
  await crawl(db, { maxUrls: 50, storeAmp: false });
  expect(hits.filter((h) => h.endsWith('/amp'))).toEqual([]);
  db.close();
}, 60_000);
