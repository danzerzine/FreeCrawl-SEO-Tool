import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { DEFAULT_CRAWL_CONFIG, type UrlCategory } from '@freecrawl/shared-types';
import { Crawler } from './crawler.js';

/* B121: /two-next declares two rel=next, /two-prev two rel=prev; /one declares one of each. */
const PAGES: Record<string, string> = {
  '/': '<a href="/one">1</a><a href="/two-next">2</a><a href="/two-prev">3</a>',
  '/one': '<link rel="prev" href="/two-next"><link rel="next" href="/two-prev">',
  '/two-next': '<link rel="next" href="/one"><link rel="next" href="/two-prev">',
  '/two-prev': '<link rel="prev" href="/one"><link rel="prev" href="/two-next">',
};

let server: Server;
let dir: string;
let base: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'b121-'));
  server = createServer((req, res) => {
    const head = PAGES[req.url ?? ''];
    if (head === undefined) return void res.writeHead(404).end();
    res
      .writeHead(200, { 'content-type': 'text/html' })
      .end(`<html><head><title>A page title long enough</title>${head}</head><body>${req.url === '/' ? head : ''}</body></html>`);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

it('a page with more than one rel=next or rel=prev is a Multiple Pagination URLs page (B121)', async () => {
  const db = new ProjectDb(join(dir, 'p.seoproject'));
  const c = new Crawler(
    {
      ...DEFAULT_CRAWL_CONFIG,
      startUrl: `${base}/`,
      maxConcurrency: 2,
      discoverSitemaps: false,
      checkExternalLinks: false,
      probeTlsCerts: false,
      probeManifestJson: false,
      probeSocialImages: false,
      probeImageSizes: false,
    },
    db,
  );
  c.on('error', () => {});
  await c.start();
  const list = (category: UrlCategory) =>
    db
      .queryUrls({ limit: 50, offset: 0, category })
      .rows.map((r) => r.url.slice(base.length))
      .sort();
  expect(list('issues:pagination-multiple')).toEqual(['/two-next', '/two-prev']);
  expect(db.getOverviewCounts().issues.paginationMultiple).toBe(2);
  db.close();
}, 30_000);
