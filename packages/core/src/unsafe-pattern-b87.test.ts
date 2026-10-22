import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { DEFAULT_CRAWL_CONFIG, type CrawlConfig } from '@freecrawl/shared-types';
import { Crawler, invalidUrlPatterns } from './crawler.js';

let server: Server;
let dir: string;
let base: string;
let hits = 0;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'b87-'));
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
  ['include', { includePatterns: ['(a+)+'] }],
  ['exclude', { excludePatterns: ['/ok', 'x'.repeat(1001)] }],
])('an unsafe %s pattern stops the crawl before any request (B87)', async (kind, over) => {
  hits = 0;
  const db = new ProjectDb(join(dir, `${kind}.seoproject`));
  const crawler = new Crawler(config(over), db);
  const errors: string[] = [];
  crawler.on('error', (m) => errors.push(String(m)));
  await crawler.start();
  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain(`Invalid ${kind} pattern`);
  expect(hits).toBe(0);
  db.close();
}, 30_000);

it('a long pattern is cut to 80 characters in the message (B87)', () => {
  const [msg] = invalidUrlPatterns({ includePatterns: [], excludePatterns: ['x'.repeat(1001)] });
  expect(msg).toContain(`"${'x'.repeat(80)}…"`);
  expect(msg).not.toContain('x'.repeat(81));
});

it('safe repeated groups and a 999-character list still crawl (B87)', () => {
  const list = Array.from({ length: 200 }, (_, i) => `/${(i + 1296).toString(36)}`).join('|');
  expect(list).toHaveLength(999);
  expect(
    invalidUrlPatterns({
      includePatterns: ['(/page/\\d+)+', '(?:/[a-z]+)*/x', list],
      excludePatterns: ['/search/', 'go-to-comment', '/login'],
    }),
  ).toEqual([]);
});
