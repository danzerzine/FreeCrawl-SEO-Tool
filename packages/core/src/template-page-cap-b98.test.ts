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
 * B98, per-page cap: a page with over 20,000 shingles is not held for the
 * template sample, does not count in it and does not freeze it early. It
 * still carries its hashes to its own write and ends on the current set.
 */
let server: Server;
let dir: string;
let base: string;
const N = 60;
const G = 50;
const words = (seed: string, n: number) => Array.from({ length: n }, (_, i) => `${seed}w${i}`).join(' ');
const TEASER = Array.from({ length: 300 }, (_, i) => `teaser${i % 97} issue${i}`).join(' ');
const wrap = (body: string) =>
  `<html><head><title>Article with a long enough title</title></head><body><div class="article"><p>${body}</p><aside>${TEASER}</aside></div></body></html>`;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'b98-cap-'));
  server = createServer((req, res) => {
    const url = req.url ?? '';
    if (url === '/') {
      const links = ['<a href="/giant">giant</a>', ...Array.from({ length: N }, (_, i) => `<a href="/a${i}">${i}</a>`)].join('');
      res.writeHead(200, { 'content-type': 'text/html' }).end(`<html><head><title>Home page of the test site</title></head><body>${links}</body></html>`);
      return;
    }
    if (url === '/giant') {
      res.writeHead(200, { 'content-type': 'text/html' }).end(wrap(words('giant', 21_000)));
      return;
    }
    if (url === '/many') {
      // The 60 template pages come first; /b0 links the giants, so they are
      // queued behind all of them (breadth-first) and parsed after them.
      const links = Array.from({ length: N }, (_, i) => `<a href="/b${i}">${i}</a>`).join('');
      res.writeHead(200, { 'content-type': 'text/html' }).end(`<html><head><title>Home page of the many-giants site</title></head><body>${links}</body></html>`);
      return;
    }
    if (url === '/b0') {
      const links = Array.from({ length: G }, (_, i) => `<a href="/g${i}">g${i}</a>`).join('');
      res.writeHead(200, { 'content-type': 'text/html' }).end(`<html><head><title>Template page zero of the site</title></head><body><div class="article"><p>${words('p0', 120)}</p><aside>${TEASER}</aside></div>${links}</body></html>`);
      return;
    }
    const g = /^\/g(\d+)$/.exec(url);
    if (g) {
      res.writeHead(200, { 'content-type': 'text/html' }).end(wrap(words(`g${g[1]}`, 21_000)));
      return;
    }
    const m = /^\/[ab](\d+)$/.exec(url);
    if (!m || Number(m[1]) >= N) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' }).end(wrap(words(`p${m[1]}`, 120)));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

it('a page over 20,000 shingles stays out of the sample and still ends on the current set', async () => {
  const file = join(dir, 'p.seoproject');
  const db = new ProjectDb(file);
  const c = new Crawler(
    {
      ...DEFAULT_CRAWL_CONFIG,
      startUrl: `${base}/`,
      maxConcurrency: 4,
      discoverSitemaps: false,
      checkExternalLinks: false,
      probeTlsCerts: false,
      probeManifestJson: false,
      probeSocialImages: false,
      probeImageSizes: false,
      contentAreaSelector: '.article',
    },
    db,
  );
  c.on('error', () => {});
  await c.start();
  const setId = Number(db.getMeta('templateSetId'));
  const sample = JSON.parse(db.getMeta('templateSample')!) as { pages: number };
  const notCompared = db.getMeta('nearDuplicateNotCompared');
  db.close();

  const raw = new DatabaseSync(file);
  const rows = raw
    .prepare(`SELECT url, template_set_id AS "set" FROM urls WHERE simhash IS NOT NULL OR minhash IS NOT NULL`)
    .all() as { url: string; set: number | null }[];
  raw.close();

  expect(Number.isFinite(setId) && setId > 0).toBe(true);
  expect(sample.pages).toBe(N);
  expect(rows.length).toBe(N + 1);
  expect(rows.find((r) => r.url === `${base}/giant`)?.set).toBe(setId);
  expect(rows.filter((r) => r.set !== setId).map((r) => r.url)).toEqual([]);
  expect(notCompared).toBe('0');
}, 120_000);

it('a full oversize budget ends template learning instead of dropping the page', async () => {
  // 50 pages x ~21,000 distinct shingles > the 1,000,000 held-entries budget:
  // the last giants cannot be held. They are written before the freeze, so
  // dropping them would leave rows the freeze cannot reconcile.
  const file = join(dir, 'many.seoproject');
  const db = new ProjectDb(file);
  const c = new Crawler(
    {
      ...DEFAULT_CRAWL_CONFIG,
      startUrl: `${base}/many`,
      maxConcurrency: 1,
      discoverSitemaps: false,
      checkExternalLinks: false,
      probeTlsCerts: false,
      probeManifestJson: false,
      probeSocialImages: false,
      probeImageSizes: false,
      contentAreaSelector: '.article',
    },
    db,
  );
  c.on('error', () => {});
  const infos: string[] = [];
  c.on('info', (m: string) => infos.push(m));
  await c.start();
  const setMeta = db.getMeta('templateSetId');
  const sample = JSON.parse(db.getMeta('templateSample') ?? '{"pages":0}') as { pages: number };
  const notCompared = db.getMeta('nearDuplicateNotCompared');
  db.close();

  const raw = new DatabaseSync(file);
  const rows = raw
    .prepare(`SELECT url, template_set_id AS "set" FROM urls WHERE simhash IS NOT NULL OR minhash IS NOT NULL`)
    .all() as { url: string; set: number | null }[];
  raw.close();

  // Learning must have started and frozen: a null set would pass the row
  // check below without proving any reconciliation.
  expect(setMeta).not.toBeNull();
  const setId = Number(setMeta);
  expect(setId).toBeGreaterThan(0);
  // All 60 template pages are parsed (and sampled) before the first giant, so
  // the sample is complete (>= 50) and the freeze was not the 500-page one.
  expect(sample.pages).toBeGreaterThanOrEqual(50);
  expect(sample.pages).toBeLessThan(500);
  expect(rows.length).toBe(N + G);
  // Every fingerprinted row, giants written before the freeze included.
  expect(rows.filter((r) => r.set !== setId).map((r) => r.url)).toEqual([]);
  // The freeze came from the oversize overflow, mid-crawl: the "learned" line
  // precedes the first post-crawl line. A freeze at the end of the crawl
  // (finishTemplateLearning) would log it after "Recomputing inlinks".
  const learned = infos.findIndex((m) => m.startsWith('Duplicates: template set learned'));
  const postCrawl = infos.indexOf('Recomputing inlinks…');
  expect(learned).toBeGreaterThanOrEqual(0);
  expect(postCrawl).toBeGreaterThan(learned);

  expect(notCompared).toBe('0');
}, 300_000);
