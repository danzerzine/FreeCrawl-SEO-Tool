import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { DEFAULT_CRAWL_CONFIG } from '@freecrawl/shared-types';
import { Crawler } from './crawler.js';
import { parseHtml } from './html-parser.js';

/*
 * / has the word only in an attribute, a literal «price: 10» and gtag.
 * /a has no gtag and an H2 «Special offer». /b has no visible text and no
 * gtag. /c has gtag and nothing else the terms look for.
 */
let server: Server;
let dir: string;
let base: string;
const GTAG = `<script>gtag('config', 'G-1')</script>`;
const BODIES: Record<string, string> = {
  '/': `<div data-track="secretword">Price: 10 in store</div><a href="/a">a</a><a href="/b">b</a><a href="/c">c</a>${GTAG}`,
  '/a': `<h2>Special offer</h2><p>Plain words here</p>`,
  '/b': `<img src="/x.png">`,
  '/c': `<p>Other words</p>${GTAG}`,
};
const TERMS = [
  '[html] secretword',
  '[text] secretword',
  'price: 10',
  '[!html] gtag',
  '[element:h2] offer',
  '[element:###] x',
  '[foo] bar',
];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'b10-'));
  server = createServer((req, res) => {
    const body = BODIES[req.url ?? ''];
    if (body === undefined) return void res.writeHead(404).end();
    res
      .writeHead(200, { 'content-type': 'text/html' })
      .end(`<html><head><title>Page ${req.url} title</title></head><body>${body}</body></html>`);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

it('terms without a prefix keep today’s hits, «[foo] bar» is a literal too (B10)', () => {
  const hits = parseHtml(`<html><body><p>Price: 10, PRICE: 10. [foo] bar</p></body></html>`, 'https://x.test/', {
    customSearchTerms: ['price: 10', '/price:\\s\\d+/i', '[foo] bar'],
  }).customSearchHits;
  expect(hits).toEqual({ 'price: 10': 2, '/price:\\s\\d+/i': 2, '[foo] bar': 1 });
});

it('[html], [text], [element:css] and [!…] modes; the tab lists only pages with a hit (B10)', async () => {
  const db = new ProjectDb(join(dir, 'p.seoproject'));
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
      customSearchTerms: TERMS,
    },
    db,
  );
  c.on('error', () => {});
  await c.start();
  const rows = db.queryUrls({ limit: 50, offset: 0, category: 'tab:custom-search' }).rows;
  const byPath = new Map(rows.map((r) => [r.url.slice(base.length), JSON.parse(r.customSearchHits ?? '{}')]));
  expect([...byPath.keys()].sort()).toEqual(['/', '/a', '/b']);
  expect(byPath.get('/')).toMatchObject({
    '[html] secretword': 1,
    '[text] secretword': 0,
    'price: 10': 1,
    '[!html] gtag': 0,
    '[element:###] x': -1,
  });
  expect(byPath.get('/a')).toMatchObject({ '[!html] gtag': 1, '[element:h2] offer': 1 });
  expect(byPath.get('/b')).toMatchObject({ '[!html] gtag': 1 });
  db.close();
}, 60_000);
