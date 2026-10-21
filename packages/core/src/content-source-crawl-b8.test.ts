import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { DEFAULT_CRAWL_CONFIG } from '@freecrawl/shared-types';
import { Crawler } from './crawler.js';

/*
 * Content area `.body`. /a and /b carry it; /old1 and /old2 do not (old
 * template): the same menu and footer and a few words of their own.
 */
let server: Server;
let dir: string;
let base: string;
const MENU = `<nav>${'Section '.repeat(60)}</nav><footer>${'Footer link '.repeat(60)}</footer>`;
const text = (seed: string) =>
  Array.from({ length: 80 }, (_, i) => `${seed}${i}`).join(' ');

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'b8-crawl-'));
  server = createServer((req, res) => {
    const pages: Record<string, string> = {
      '/': `<a href="/a">a</a><a href="/b">b</a><a href="/old1">o1</a><a href="/old2">o2</a>`,
      '/a': `${MENU}<div class="body">${text('alpha')}</div>`,
      '/b': `${MENU}<div class="body">${text('beta')}</div>`,
      '/old1': `${MENU}<p>${text('one').slice(0, 120)}</p>`,
      '/old2': `${MENU}<p>${text('two').slice(0, 120)}</p>`,
    };
    const body = pages[req.url ?? ''];
    if (body === undefined) {
      res.writeHead(404).end();
      return;
    }
    res
      .writeHead(200, { 'content-type': 'text/html' })
      .end(`<html><head><title>Page ${req.url} title long enough</title></head><body>${body}</body></html>`);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
});
afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

it('a page the content area misses is stored with its source and no near-duplicate fingerprint', async () => {
  const file = join(dir, 'p.seoproject');
  const db = new ProjectDb(file);
  const c = new Crawler(
    {
      ...DEFAULT_CRAWL_CONFIG,
      startUrl: base,
      maxConcurrency: 2,
      discoverSitemaps: false,
      checkExternalLinks: false,
      probeTlsCerts: false,
      probeManifestJson: false,
      probeSocialImages: false,
      probeImageSizes: false,
      contentAreaSelector: '.body',
    },
    db,
  );
  c.on('error', () => {});
  await c.start();
  db.close();
  const raw = new DatabaseSync(file);
  const rows = raw
    .prepare(
      `SELECT url, content_source AS src, simhash, minhash, content_hash AS ch, cluster_id AS cl
         FROM urls WHERE url LIKE ? ORDER BY url`,
    )
    .all(`${base}%`) as Array<{ url: string; src: string | null; simhash: string | null; minhash: Uint8Array | null; ch: string | null; cl: number }>;
  raw.close();
  const by = (p: string) => rows.find((r) => r.url === base + p)!;
  expect(by('a').src).toBe('selector');
  expect(by('a').simhash).not.toBeNull();
  expect(by('a').minhash).not.toBeNull();
  for (const p of ['old1', 'old2']) {
    expect(by(p).src).toBe('selector-missed');
    expect(by(p).simhash).toBeNull();
    expect(by(p).minhash).toBeNull();
    expect(by(p).ch).not.toBeNull(); // exact-duplicate hash stays
    expect(by(p).cl).toBe(0); // not clustered on the shared menu
  }

  const again = new ProjectDb(file);
  const missed = [...again.iterateUrlsByCategory('issues:content-area-not-found')].length;
  const count = again.getOverviewCounts().issues.contentAreaNotFound;
  again.close();
  expect(missed).toBe(3); // the home page has no `.body` either
  expect(count).toBe(3);
}, 30_000);
