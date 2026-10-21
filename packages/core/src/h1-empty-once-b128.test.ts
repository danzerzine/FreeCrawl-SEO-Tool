import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { DEFAULT_CRAWL_CONFIG, type UrlCategory } from '@freecrawl/shared-types';
import { Crawler } from './crawler.js';

/* /no-h1 has no heading, /empty-h1 an empty one, /ok-h1 a real one, /gone answers 404 with an empty one. */
let server: Server;
let dir: string;
let base: string;
const PAGES: Record<string, [number, string]> = {
  '/': [200, '<h1>Home</h1><a href="/no-h1">a</a><a href="/empty-h1">b</a><a href="/ok-h1">c</a><a href="/gone">d</a>'],
  '/no-h1': [200, '<p>No heading here</p>'],
  '/empty-h1': [200, '<h1></h1><p>Empty heading</p>'],
  '/ok-h1': [200, '<h1>Real heading</h1>'],
  '/gone': [404, '<h1></h1><p>Not found</p>'],
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'b128-'));
  server = createServer((req, res) => {
    const p = PAGES[req.url ?? ''];
    if (!p) return void res.writeHead(404).end();
    res
      .writeHead(p[0], { 'content-type': 'text/html' })
      .end(`<html><head><title>Page title long enough ${req.url}</title></head><body>${p[1]}</body></html>`);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

it('an empty H1 is counted as empty only, not also as missing (B128)', async () => {
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
  expect(list('issues:h1-missing')).toEqual(['/no-h1']);
  expect(list('issues:h1-empty')).toEqual(['/empty-h1']);
  const o = db.getOverviewCounts();
  expect([o.issues.h1Missing, o.issues.h1Empty]).toEqual([1, 1]);
  db.close();
}, 60_000);
