import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { DEFAULT_CRAWL_CONFIG } from '@freecrawl/shared-types';
import { Crawler } from './crawler.js';

/*
 * `maxQueueSize` bounds the internal pending queue. External probes run
 * from their own queue and must not be dropped by that cap: with a cap of
 * 1 and eight external links on the start page, all eight are still probed.
 */
let home: Server;
let ext: Server;
let dir: string;
let base: string;
const hits = new Set<string>();
const N = 8;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'b192-'));
  ext = createServer((req, res) => {
    hits.add(req.url ?? '');
    res.writeHead(200, { 'content-type': 'text/html' }).end('ok');
  });
  await new Promise<void>((r) => ext.listen(0, '127.0.0.1', r));
  const extPort = (ext.address() as { port: number }).port;
  home = createServer((_req, res) => {
    const links = Array.from(
      { length: N },
      (_, i) => `<a href="http://localhost:${extPort}/e${i}">e${i}</a>`,
    ).join('');
    res
      .writeHead(200, { 'content-type': 'text/html' })
      .end(
        `<html><head><title>Home page title long enough</title></head><body>${links}</body></html>`,
      );
  });
  await new Promise<void>((r) => home.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(home.address() as { port: number }).port}/`;
});
afterAll(() => {
  home.close();
  ext.close();
  rmSync(dir, { recursive: true, force: true });
});

it('external links beyond maxQueueSize are still probed', async () => {
  const db = new ProjectDb(join(dir, 'p.seoproject'));
  const c = new Crawler(
    {
      ...DEFAULT_CRAWL_CONFIG,
      startUrl: base,
      maxQueueSize: 1,
      discoverSitemaps: false,
      checkExternalLinks: true,
      probeTlsCerts: false,
      probeManifestJson: false,
      probeSocialImages: false,
      probeImageSizes: false,
      requestTimeoutMs: 5_000,
    },
    db,
  );
  c.on('error', () => {});
  await c.start();
  db.close();
  expect(hits.size).toBe(N);
}, 30_000);
