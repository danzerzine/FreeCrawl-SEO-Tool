import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { DEFAULT_CRAWL_CONFIG, type UrlCategory } from '@freecrawl/shared-types';
import { Crawler } from './crawler.js';

/*
 * Pagination: /list/1 → 2 → 3, and /list/3's next goes back to 2 (a loop);
 * /cat/2 is page 2 of /cat/1 but canonicalised to it.
 * Hreflang: /en ↔ /de, /de is noindex; /fr is canonicalised to /en yet
 * declares hreflang.
 */
const PAGES: Record<string, string> = {
  '/': '<a href="/list/1">l</a><a href="/cat/1">c</a><a href="/en">en</a><a href="/fr">fr</a>',
  '/list/1': '<link rel="next" href="/list/2">',
  '/list/2': '<link rel="prev" href="/list/1"><link rel="next" href="/list/3">',
  '/list/3': '<link rel="prev" href="/list/2"><link rel="next" href="/list/2">',
  '/cat/1': '<link rel="next" href="/cat/2">',
  '/cat/2': '<link rel="prev" href="/cat/1"><link rel="canonical" href="/cat/1">',
  '/en': '<link rel="alternate" hreflang="en" href="/en"><link rel="alternate" hreflang="de" href="/de">',
  '/de': '<meta name="robots" content="noindex"><link rel="alternate" hreflang="en" href="/en"><link rel="alternate" hreflang="de" href="/de">',
  '/fr': '<link rel="canonical" href="/en"><link rel="alternate" hreflang="fr" href="/fr"><link rel="alternate" hreflang="en" href="/en">',
};

let server: Server;
let dir: string;
let base: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'b82-'));
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

it('pagination non-indexable and loop, hreflang not canonical and noindex target (B82)', async () => {
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
  expect(list('issues:pagination-non-indexable')).toEqual(['/cat/2']);
  expect(list('issues:pagination-loop')).toEqual(['/list/2', '/list/3']);
  expect(list('issues:hreflang-not-canonical')).toEqual(['/fr']);
  expect(list('issues:hreflang-noindex-target')).toEqual(['/en']);
  const i = db.getOverviewCounts().issues;
  expect([i.paginationNonIndexable, i.paginationLoop, i.hreflangNotCanonical, i.hreflangNoindexTarget]).toEqual([1, 2, 1, 1]);
  db.close();
}, 30_000);
