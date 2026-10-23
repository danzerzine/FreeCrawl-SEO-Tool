import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LATER_CHECKS, MARKUP_CHECKS, ProjectDb } from '@freecrawl/db';
import { DEFAULT_CRAWL_CONFIG } from '@freecrawl/shared-types';
import { compareCrawls } from './compare.js';
import { Crawler } from './crawler.js';

// B45: a crawl of a local 4-page site: a clean home, a page with a repeated id, a page without doctype, a 404.
const PAGES: Record<string, string> = {
  '/': '<!DOCTYPE html><html><head><title>Home</title></head><body><h1>H</h1><a href="/dup">d</a><a href="/nodoc">n</a><a href="/gone">g</a></body></html>',
  '/dup': '<!DOCTYPE html><html><head><title>Dup</title></head><body><p id="x">a</p><p id="x">b</p></body></html>',
  '/nodoc': '<html><head><title>No doctype</title></head><body><p>x</p></body></html>',
};
const NOT_FOUND = '<html><body><p id="y">a</p><p id="y">b</p></body></html>';
let server: Server;
let dir: string;
let base: string;
const realFetch = globalThis.fetch;
beforeAll(async () => {
  // Network guard: nothing but the local fixture host is reachable from this file.
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const host = new URL(typeof input === 'string' || input instanceof URL ? input : input.url).hostname;
    if (host !== '127.0.0.1') return Promise.reject(new Error(`blocked fetch to ${host}`));
    return realFetch(input, init);
  }) as typeof fetch;
  dir = mkdtempSync(join(tmpdir(), 'fc-b45-'));
  server = createServer((req, res) => {
    const body = PAGES[req.url ?? '/'];
    res.writeHead(body === undefined ? 404 : 200, { 'content-type': 'text/html' }).end(body ?? NOT_FOUND);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

let n = 0;
async function crawl(markupValidation: boolean, db = new ProjectDb(join(dir, `p${n++}.seoproject`))) {
  const c = new Crawler(
    {
      ...DEFAULT_CRAWL_CONFIG,
      startUrl: base,
      maxConcurrency: 1,
      markupValidation,
      discoverSitemaps: false,
      checkExternalLinks: false,
      probeTlsCerts: false,
      probeManifestJson: false,
      probeSocialImages: false,
      probeImageSizes: false,
    },
    db,
  );
  c.on('error', () => {});
  await c.start();
  return db;
}
const cols = (db: ProjectDb, p: string) => {
  const r = db.getUrlById(db.getUrlIdByUrl(base + p)!)!;
  return [r.markupErrors, r.markupCodes];
};
const listed = (db: ProjectDb, k: string): string[] =>
  db.queryUrls({ limit: 20, offset: 0, category: `issues:${k}` as never }).rows.map((r) => r.url.replace(base, '/')).sort();

describe('crawl with the markup check (B45)', () => {
  it('option on: columns of each page and both issues list the right pages (404 skipped)', async () => {
    const db = await crawl(true);
    expect(cols(db, '')).toEqual([0, null]);
    expect(cols(db, 'dup')).toEqual([1, '{"duplicate-id":1}']);
    expect(cols(db, 'nodoc')).toEqual([1, '{"missing-doctype":1}']);
    expect(cols(db, 'gone')).toEqual([null, null]);
    expect(listed(db, 'markup-errors')).toEqual(['/dup', '/nodoc']);
    expect(listed(db, 'duplicate-ids')).toEqual(['/dup']);
    for (const k of MARKUP_CHECKS) expect(db.checksFilled().has(k)).toBe(true);
    db.close();
  }, 30_000);

  it('option off: NULL everywhere, issues empty, the checks are not filled, compare says not checked', async () => {
    const off = await crawl(false);
    for (const p of ['', 'dup', 'nodoc']) expect(cols(off, p)).toEqual([null, null]);
    expect(listed(off, 'markup-errors')).toEqual([]);
    for (const k of MARKUP_CHECKS) expect(off.checksFilled().has(k)).toBe(false);
    const on = await crawl(true);
    const s = compareCrawls(off, on);
    for (const k of MARKUP_CHECKS) {
      expect(s.issueChanges[k]).toBeUndefined();
      expect(s.notComparable[k]?.reason).toMatch(/not checked/);
    }
    // Two crawls that both checked are compared.
    const on2 = await crawl(true);
    expect(compareCrawls(on, on2).notComparable['issues:markup-errors']).toBeUndefined();
    off.close();
    on.close();
    on2.close();
  }, 60_000);

  it('crawl with it on, refresh with it off: NULL again', async () => {
    const db = await crawl(true);
    expect(listed(db, 'markup-errors')).toHaveLength(2);
    await crawl(false, db);
    expect(cols(db, 'dup')).toEqual([null, null]);
    expect(listed(db, 'markup-errors')).toEqual([]);
    for (const k of MARKUP_CHECKS) expect(db.checksFilled().has(k)).toBe(false);
    expect(LATER_CHECKS).toEqual(expect.arrayContaining([...MARKUP_CHECKS]));
    db.close();
  }, 30_000);
});
