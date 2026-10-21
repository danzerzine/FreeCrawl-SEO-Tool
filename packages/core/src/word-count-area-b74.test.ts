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
 * A menu and footer of 180 words on every page. /area adds 141 words in the
 * content area (321 on the page); /short adds 10 there; /miss has no area.
 */
let server: Server;
let dir: string;
let base: string;
const MENU = `<nav>${'Section '.repeat(60)}</nav><footer>${'Footer link '.repeat(60)}</footer>`;
const words = (seed: string, n: number) => Array.from({ length: n }, (_, i) => `${seed}${i}`).join(' ');

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'b74-'));
  server = createServer((req, res) => {
    const pages: Record<string, string> = {
      '/': `<a href="/area">a</a><a href="/short">s</a><a href="/miss">m</a>${words('home', 400)}`,
      '/area': `${MENU}<div class="body">${words('alpha', 141)}</div>`,
      '/short': `${MENU}<div class="body">${words('beta', 10)}</div>`,
      '/miss': `${MENU}<p>${words('gamma', 141)}</p>`,
    };
    const body = pages[req.url ?? ''];
    if (body === undefined) return void res.writeHead(404).end();
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

async function crawl(name: string, contentAreaSelector: string): Promise<string> {
  const file = join(dir, `${name}.seoproject`);
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
      contentAreaSelector,
    },
    db,
  );
  c.on('error', () => {});
  await c.start();
  db.close();
  return file;
}

/** Thin and empty pages as the counts and the tab lists see them. */
function judged(file: string): { thin: string[]; empty: string[]; counts: [number, number] } {
  const db = new ProjectDb(file);
  try {
    const list = (category: 'issues:content-thin' | 'issues:page-empty') =>
      db
        .queryUrls({ limit: 50, offset: 0, category })
        .rows.map((r) => r.url.slice(base.length))
        .sort();
    const { contentThin, pageEmpty } = db.getOverviewCounts().issues;
    return { thin: list('issues:content-thin'), empty: list('issues:page-empty'), counts: [contentThin, pageEmpty] };
  } finally {
    db.close();
  }
}

it('with a content area, thin and empty content are judged on the area’s words; a page the area misses counts all its words (B74)', async () => {
  const file = await crawl('sel', '.body');
  const raw = new DatabaseSync(file);
  const row = (p: string) =>
    raw.prepare('SELECT word_count AS w, main_word_count AS m FROM urls WHERE url = ?').get(base + p);
  expect(row('area')).toEqual({ w: 321, m: 141 });
  expect(row('short')).toEqual({ w: 190, m: 10 });
  raw.close();
  expect(judged(file)).toEqual({ thin: ['area', 'short'], empty: ['short'], counts: [2, 1] });
}, 30_000);

it('without a content area the whole page counts as before (B74)', async () => {
  // 190 words on /short: thin, not empty.
  expect(judged(await crawl('none', ''))).toEqual({ thin: ['short'], empty: [], counts: [1, 0] });
}, 30_000);

it('an older project crawled with a content area but no area word count keeps its counts (B74)', async () => {
  const file = await crawl('old', '.body');
  const raw = new DatabaseSync(file);
  raw.exec('UPDATE urls SET main_word_count = NULL');
  raw.close();
  expect(judged(file)).toEqual({ thin: ['short'], empty: [], counts: [1, 0] });
}, 30_000);
