import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { DEFAULT_CRAWL_CONFIG, type CrawlConfig } from '@freecrawl/shared-types';
import { Crawler } from './crawler.js';

let server: Server;
let dir: string;
let base: string;
let hits = 0;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'b129-'));
  server = createServer((_req, res) => {
    hits++;
    res.writeHead(200, { 'content-type': 'text/html' }).end('<html><body><a href="/a">a</a></body></html>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

const config = (over: Partial<CrawlConfig>): CrawlConfig => ({
  ...DEFAULT_CRAWL_CONFIG,
  startUrl: `${base}/`,
  maxUrls: 5,
  discoverSitemaps: false,
  checkExternalLinks: false,
  probeTlsCerts: false,
  probeManifestJson: false,
  probeSocialImages: false,
  probeImageSizes: false,
  ...over,
});

it.each([
  ['include', { includePatterns: ['(['] }],
  ['exclude', { excludePatterns: ['/ok', '*bad'] }],
])('an invalid %s pattern stops the crawl before any request and names the pattern (B129)', async (kind, over) => {
  hits = 0;
  const db = new ProjectDb(join(dir, `${kind}.seoproject`));
  let crawler: Crawler | undefined;
  expect(() => {
    crawler = new Crawler(config(over), db);
  }).not.toThrow();
  const errors: string[] = [];
  let done = false;
  crawler!.on('error', (m) => errors.push(String(m)));
  crawler!.on('done', () => (done = true));
  await crawler!.start();
  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain(`Invalid ${kind} pattern`);
  expect(errors[0]).toContain(kind === 'include' ? '"(["' : '"*bad"');
  expect(done).toBe(true);
  expect(hits).toBe(0);
  db.close();
}, 30_000);

it('a valid include pattern crawls as before (B129)', async () => {
  hits = 0;
  const db = new ProjectDb(join(dir, 'valid.seoproject'));
  const c = new Crawler(config({ includePatterns: ['/'] }), db);
  const errors: string[] = [];
  c.on('error', (m) => errors.push(String(m)));
  await c.start();
  expect(errors).toEqual([]);
  expect(hits).toBeGreaterThan(0);
  db.close();
}, 30_000);
