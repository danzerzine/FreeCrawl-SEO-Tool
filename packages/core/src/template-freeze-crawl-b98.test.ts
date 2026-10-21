import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { DEFAULT_CRAWL_CONFIG, unpackTemplateSet } from '@freecrawl/shared-types';
import { Crawler } from './crawler.js';
import { extractProseText, parseHtml } from './html-parser.js';
import { computeContentFingerprint } from './simhash.js';

/*
 * B98, the set frozen mid-crawl: 530 articles, so the 500-page sample fills
 * while pages are still being fetched. One page's parse waits until the
 * freeze job has stored the set, so it is parsed without the set and
 * written after it.
 */
let server: Server;
let dir: string;
let base: string;
const N = 530;
const words = (seed: string, n: number) => Array.from({ length: n }, (_, i) => `${seed}w${i}`).join(' ');
const TEASER = Array.from({ length: 300 }, (_, i) => `teaser${i % 97} issue${i}`).join(' ');
const pageHtml = (i: number) =>
  `<html><head><title>Article ${i} with a long enough title</title></head><body>` +
  `<div class="article"><p>${words(`p${i}`, 120)}</p><aside>${TEASER}</aside></div></body></html>`;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'b98-freeze-'));
  server = createServer((req, res) => {
    const url = req.url ?? '';
    if (url === '/') {
      const links = Array.from({ length: N }, (_, i) => `<a href="/a${i}">${i}</a>`).join('');
      res.writeHead(200, { 'content-type': 'text/html' }).end(`<html><head><title>Home page of the test site</title></head><body>${links}</body></html>`);
      return;
    }
    const m = /^\/a(\d+)$/.exec(url);
    if (!m || Number(m[1]) >= N) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' }).end(pageHtml(Number(m[1])));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

it('a page parsed before the freeze and written after it ends on the current set', async () => {
  const file = join(dir, 'p.seoproject');
  const db = new ProjectDb(file);
  const delayed = `${base}/a3`;
  let delayedParsedWithoutSet = false;
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
    {
      parseHtml: async (html, url, opts) => {
        if (url === delayed) {
          delayedParsedWithoutSet = !opts?.templateSet;
          const t0 = Date.now();
          while (db.getMeta('templateSetId') === null && Date.now() - t0 < 30_000) {
            await new Promise((r) => setTimeout(r, 20));
          }
        }
        return parseHtml(html, url, opts);
      },
    },
  );
  c.on('error', () => {});
  await c.start();
  const setId = Number(db.getMeta('templateSetId'));
  const set = { id: setId, hashes: unpackTemplateSet(Buffer.from(db.getMeta('templateShingles')!, 'base64')) };
  const sample = JSON.parse(db.getMeta('templateSample')!) as { pages: number };
  const notCompared = db.getMeta('nearDuplicateNotCompared');
  db.close();

  const raw = new DatabaseSync(file);
  const rows = raw
    .prepare(`SELECT url, simhash, minhash, template_set_id AS "set" FROM urls WHERE simhash IS NOT NULL OR minhash IS NOT NULL`)
    .all() as { url: string; simhash: string; minhash: Uint8Array; set: number | null }[];
  raw.close();

  expect(delayedParsedWithoutSet).toBe(true);
  expect(sample.pages).toBe(500);
  expect(rows.length).toBe(N);
  expect(rows.filter((r) => r.set !== setId).map((r) => r.url)).toEqual([]);
  expect(notCompared).toBe('0');
  const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
  for (const i of [3, 0, N - 1]) {
    const r = rows.find((x) => x.url === `${base}/a${i}`)!;
    const want = computeContentFingerprint(extractProseText(pageHtml(i), '.article'), { set });
    expect({ url: r.url, s: r.simhash, m: hex(new Uint8Array(r.minhash)) }).toEqual({ url: r.url, s: want.simhash, m: hex(want.minhash!) });
  }
}, 120_000);
