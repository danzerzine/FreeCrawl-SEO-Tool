import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { DEFAULT_CRAWL_CONFIG, EXTERNAL_NO_ANSWER_CONFIRMED } from '@freecrawl/shared-types';
import { Crawler } from './crawler.js';

/*
 * The start page links two external hosts (`localhost` is another host than
 * 127.0.0.1, and a private start host lets the probe through):
 * - a port nobody listens on: refused twice, stored with the marker;
 * - a port that opens shortly after the home page is served: refused on the
 *   first try, answered on the retry, stored as 200.
 */
let server: Server;
let late: Server | undefined;
let dir: string;
let base: string;
let deadPort: number;
let latePort: number;

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'b7-probe-'));
  deadPort = await freePort();
  latePort = await freePort();
  server = createServer((req, res) => {
    if (req.url !== '/') {
      res.writeHead(404).end();
      return;
    }
    res
      .writeHead(200, { 'content-type': 'text/html' })
      .end(
        `<html><head><title>Home page title long enough</title></head><body>` +
          `<a href="http://localhost:${deadPort}/x">dead</a>` +
          `<a href="http://localhost:${latePort}/y">late</a></body></html>`,
      );
    setTimeout(() => {
      if (late) return;
      late = createServer((_q, r) => r.writeHead(200, { 'content-type': 'text/html' }).end('ok'));
      late.listen(latePort, 'localhost');
    }, 200);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
});
afterAll(() => {
  server.close();
  late?.close();
  rmSync(dir, { recursive: true, force: true });
});

it('a refused external URL is retried once; a confirmed failure carries the marker, an answer on the retry wins', async () => {
  const file = join(dir, 'p.seoproject');
  const db = new ProjectDb(file);
  const c = new Crawler(
    {
      ...DEFAULT_CRAWL_CONFIG,
      startUrl: base,
      maxConcurrency: 2,
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
  const raw = new DatabaseSync(file);
  const row = (port: number) =>
    raw
      .prepare('SELECT status_code AS s, status_text AS t FROM urls WHERE url LIKE ?')
      .get(`http://localhost:${port}/%`) as { s: number | null; t: string | null };
  const dead = row(deadPort);
  const lateRow = row(latePort);
  raw.close();
  expect(dead.s).toBeNull();
  expect(dead.t).toContain('ECONNREFUSED');
  expect(dead.t?.endsWith(EXTERNAL_NO_ANSWER_CONFIRMED)).toBe(true);
  expect(lateRow.s).toBe(200);
}, 30_000);
