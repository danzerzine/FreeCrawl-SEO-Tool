import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { DEFAULT_CRAWL_CONFIG, type CrawlConfig } from '@freecrawl/shared-types';
import { Crawler } from './crawler.js';

// B147: `bodySnapshotMaxBytes: 0` means "no cap"; a page over 1 MB must not be stored as truncated.
let server: Server;
let dir: string;
let base: string;
const BIG = `<html><head><title>A page title long enough</title></head><body><p>${'word '.repeat(220_000)}</p></body></html>`;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'b147-'));
  server = createServer((req, res) => {
    if (req.url === '/robots.txt') return void res.writeHead(200).end('User-agent: *\nAllow: /\n');
    if (req.url === '/big') return void res.writeHead(200, { 'content-type': 'text/html' }).end(BIG);
    if (req.url === '/') {
      return void res.writeHead(200, { 'content-type': 'text/html' }).end('<html><head><title>Home page title here</title></head><body><a href="/big">big</a></body></html>');
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

async function stored(name: string, config: Partial<CrawlConfig>) {
  const db = new ProjectDb(join(dir, name));
  const c = new Crawler(
    {
      ...DEFAULT_CRAWL_CONFIG,
      startUrl: `${base}/`,
      maxConcurrency: 1,
      maxUrls: 5,
      discoverSitemaps: false,
      checkExternalLinks: false,
      probeTlsCerts: false,
      probeManifestJson: false,
      probeSocialImages: false,
      probeImageSizes: false,
      storeBodySnapshots: true,
      ...config,
    },
    db,
  );
  c.on('error', () => {});
  await c.start();
  const src = db.getUrlSource(db.getUrlIdByUrl(`${base}/big`)!);
  db.close();
  return src;
}

it('0 stores the whole page and flags nothing', async () => {
  const src = await stored('zero.seoproject', { bodySnapshotMaxBytes: 0 });
  expect(src?.truncated).toBe(false);
  expect(src?.body.length).toBe(BIG.length);
}, 60_000);

it('the default cap still truncates and flags a page over 1 MB', async () => {
  const src = await stored('default.seoproject', { bodySnapshotMaxBytes: 1_048_576 });
  expect(src?.truncated).toBe(true);
}, 60_000);
