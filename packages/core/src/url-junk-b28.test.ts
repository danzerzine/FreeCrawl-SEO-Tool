import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { DEFAULT_CRAWL_CONFIG, type UrlCategory } from '@freecrawl/shared-types';
import { Crawler } from './crawler.js';

const HREFS = [
  '/[object Object]',
  '/p/undefined',
  '/p/null/x',
  '/tpl/${id}',
  '/tpl/{{slug}}',
  '/undefined-behaviour/',
  '/search/?q=shoes',
  '/?s=hat',
  '/poisk?text=chair',
  '/search-engine-optimization/',
  '/search-tips/?q=a',
  '/catalog?q=red',
  '/landing?utm_source=mail&utm_medium=x',
];

let server: Server;
let dir: string;
let base: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'b28-'));
  server = createServer((req, res) => {
    const links = req.url === '/' ? HREFS.map((h) => `<a href="${h}">link</a>`).join('') : '';
    res
      .writeHead(200, { 'content-type': 'text/html' })
      .end(`<html><head><title>A page title long enough</title></head><body>${links}</body></html>`);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

it('template junk, internal search URLs and internal links with utm tags are listed (B28)', async () => {
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
      .rows.map((r) => decodeURI(r.url.slice(base.length)))
      .sort();
  expect(list('issues:url-template-junk')).toEqual(['/[object Object]', '/p/null/x', '/p/undefined', '/tpl/${id}', '/tpl/{{slug}}']);
  expect(list('issues:url-internal-search')).toEqual(['/?s=hat', '/poisk?text=chair', '/search/?q=shoes']);
  expect(list('issues:link-utm-internal')).toEqual(['/']);
  const { urlTemplateJunk, urlInternalSearch, linkUtmInternal } = db.getOverviewCounts().issues;
  expect([urlTemplateJunk, urlInternalSearch, linkUtmInternal]).toEqual([5, 3, 1]);
  db.close();
}, 30_000);
