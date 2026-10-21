import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { DEFAULT_CRAWL_CONFIG, unpackTemplateSet } from '@freecrawl/shared-types';
import { Crawler } from './crawler.js';
import { extractProseText } from './html-parser.js';
import { computeContentFingerprint } from './simhash.js';

/*
 * B98. 62 articles under `.article`, each with its own body and one shared
 * 300-word teaser: a0..a57 with 250 words, s1/s2 with 80 words (short),
 * dupA/dupB with the same 250-word body. Without subtraction the two short
 * articles match on the teaser alone.
 */
let server: Server;
let dir: string;
let base: string;
const words = (seed: string, n: number) => Array.from({ length: n }, (_, i) => `${seed}w${i}`).join(' ');
const TEASER = Array.from({ length: 300 }, (_, i) => `teaser${i % 97} issue${i}`).join(' ').split(' ').slice(0, 300).join(' ');
const ARTICLES: Record<string, string> = {};
for (let i = 0; i < 58; i++) ARTICLES[`/a${i}`] = words(`p${i}`, 250);
ARTICLES['/s1'] = words('shortone', 80);
ARTICLES['/s2'] = words('shorttwo', 80);
ARTICLES['/dupA'] = words('twin', 250);
ARTICLES['/dupB'] = words('twin', 250);
ARTICLES['/teaser-only'] = '';
const pageHtml = (path: string) =>
  `<html><head><title>Article ${path} with a long enough title</title></head><body>` +
  `<nav>${'Menu '.repeat(30)}</nav><div class="article"><p>${ARTICLES[path]}</p><aside>${TEASER}</aside></div></body></html>`;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'b98-crawl-'));
  server = createServer((req, res) => {
    const url = req.url ?? '';
    if (url === '/') {
      const links = Object.keys(ARTICLES).map((p) => `<a href="${p}">${p}</a>`).join('');
      res.writeHead(200, { 'content-type': 'text/html' }).end(`<html><head><title>Home page of the test site</title></head><body>${links}</body></html>`);
      return;
    }
    if (!(url in ARTICLES)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' }).end(pageHtml(url));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

const config = () => ({
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
});

type Row = { url: string; simhash: string | null; minhash: Uint8Array | null; set: number | null; cl: number };
function readRows(file: string): Row[] {
  const raw = new DatabaseSync(file);
  const r = raw
    .prepare(`SELECT url, simhash, minhash, template_set_id AS "set", cluster_id AS cl FROM urls ORDER BY url`)
    .all() as Row[];
  raw.close();
  return r;
}
const hex = (b: Uint8Array | null) => (b ? Buffer.from(b).toString('hex') : null);

it('a teaser shared by the articles is subtracted: short articles no longer cluster, true twins still do', async () => {
  const file = join(dir, 'p.seoproject');
  const db = new ProjectDb(file);
  const c = new Crawler(config(), db);
  c.on('error', () => {});
  await c.start();
  const setId = db.getMeta('templateSetId');
  const packed = db.getMeta('templateShingles');
  const notCompared = db.getMeta('nearDuplicateNotCompared');
  const exact = [...db.iterateUrlsByCategory('issues:duplicate-content-exact')].map((r) => r.url).sort();
  db.close();

  const rows = readRows(file);
  const by = (p: string) => rows.find((r) => r.url === base + p)!;
  expect(by('/s1').cl).toBe(0);
  expect(by('/s2').cl).toBe(0);
  expect(by('/dupA').cl).toBeGreaterThan(0);
  expect(by('/dupB').cl).toBe(by('/dupA').cl);

  expect(setId).not.toBeNull();
  const fingerprinted = rows.filter((r) => r.simhash !== null || r.minhash !== null);
  expect(fingerprinted.length).toBe(62);
  expect(fingerprinted.every((r) => r.set === Number(setId))).toBe(true);
  expect(notCompared).toBe('0');

  // All-template page: no near-duplicate fingerprint, content hash kept.
  const raw = new DatabaseSync(file);
  const only = raw
    .prepare('SELECT simhash, minhash, content_hash AS ch FROM urls WHERE url = ?')
    .get(`${base}/teaser-only`) as { simhash: string | null; minhash: Uint8Array | null; ch: string | null };
  raw.close();
  expect(only).toMatchObject({ simhash: null, minhash: null });
  expect(only.ch).not.toBeNull();
  // Exact duplicates are judged on the full text, as before.
  expect(exact).toEqual([`${base}/dupA`, `${base}/dupB`]);

  // Stored signature = the fingerprint of the page's main text with the stored set.
  const set = { id: Number(setId), hashes: unpackTemplateSet(Buffer.from(packed!, 'base64')) };
  for (const p of ['/a3', '/s1']) {
    const want = computeContentFingerprint(extractProseText(pageHtml(p), '.article'), { set });
    expect({ s: by(p).simhash, m: hex(by(p).minhash ? new Uint8Array(by(p).minhash!) : null) }).toEqual({
      s: want.simhash,
      m: hex(want.minhash),
    });
  }
}, 60_000);
