import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { DEFAULT_CRAWL_CONFIG } from '@freecrawl/shared-types';
import { Crawler } from './crawler.js';

/*
 * B191: Stop cuts short a worker that sleeps in the own site's rate gate.
 * At 0.5 rps (`--rps 0.5`) each page waits 2 s for its slot; Stop must not wait it out.
 */
let dir: string;
let server: Server;
let base = '';
const hits: number[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'b191-'));
  server = createServer((req, res) => {
    if (req.url !== '/robots.txt') hits.push(Date.now());
    const links = req.url === '/' ? [1, 2, 3, 4].map((i) => `<a href="/p${i}">p</a>`).join('') : '';
    res
      .writeHead(200, { 'content-type': 'text/html' })
      .end(`<html><head><title>A page title long enough</title></head><body>${links}</body></html>`);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
});
afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

it('Stop during the wait for the next own-site slot ends the crawl at once', async () => {
  const db = new ProjectDb(join(dir, 'p.seoproject'));
  const c = new Crawler(
    {
      ...DEFAULT_CRAWL_CONFIG,
      startUrl: base,
      maxConcurrency: 4,
      maxRps: 0.5,
      discoverSitemaps: false,
      checkExternalLinks: false,
      checkImages: false,
      checkCss: false,
      checkJs: false,
      probeTlsCerts: false,
      probeManifestJson: false,
      probeSocialImages: false,
      probeImageSizes: false,
    },
    db,
  );
  c.on('error', () => {});
  let stoppedAt = 0;
  const done = c.start();
  while (hits.length < 1) await new Promise((r) => setTimeout(r, 20));
  // The links are queued and the next workers sleep in the gate.
  await new Promise((r) => setTimeout(r, 300));
  stoppedAt = Date.now();
  c.stop();
  await done;
  db.close();
  expect(Date.now() - stoppedAt).toBeLessThan(1_000);
  expect(hits.filter((t) => t >= stoppedAt)).toHaveLength(0);
}, 30_000);
