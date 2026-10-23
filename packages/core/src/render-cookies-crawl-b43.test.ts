import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { DEFAULT_CRAWL_CONFIG, type CrawlConfig } from '@freecrawl/shared-types';
import { Crawler } from './crawler.js';
import { fakeRender } from './fake-render.test-support.js';
import type { RenderHook } from './render-config.js';

// B43: the cookie list through a Crawler run with the fake render hook (no browser).
const HTML = '<html><head><title>T</title></head><body><h1>H</h1></body></html>';
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
  dir = mkdtempSync(join(tmpdir(), 'fc-b43-'));
  server = createServer((_req, res) => void res.writeHead(200, { 'content-type': 'text/html' }).end(HTML));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

const LIST = [
  { n: 'sid', d: '127.0.0.1', p: '/', s: 1 as const, h: 1 as const, ss: 'Lax' as const, e: -1, by: 'header' as const },
  { n: 'ga', d: '127.0.0.1', p: '/', s: 0 as const, h: 0 as const, ss: '' as const, e: 1900000000, by: 'script' as const },
  { n: 'fr', d: 'ads.test', p: '/', s: null, h: 0 as const, ss: null, e: null, by: 'script' as const },
];
const hookWith = (cookies?: { total: number; truncated: boolean; list: typeof LIST }) =>
  fakeRender({ [base]: HTML }, { cookies });

let n = 0;
async function crawl(
  hook: RenderHook | undefined,
  o: { mode?: CrawlConfig['renderingMode']; cookieList?: boolean; db?: ProjectDb } = {},
) {
  const db = o.db ?? new ProjectDb(join(dir, `p${n++}.seoproject`));
  const c = new Crawler(
    {
      ...DEFAULT_CRAWL_CONFIG,
      startUrl: base,
      renderingMode: o.mode ?? 'js',
      maxConcurrency: 1,
      discoverSitemaps: false,
      checkExternalLinks: false,
      probeTlsCerts: false,
      probeManifestJson: false,
      probeSocialImages: false,
      probeImageSizes: false,
      jsRender: { ...DEFAULT_CRAWL_CONFIG.jsRender, cookieList: o.cookieList ?? true },
    },
    db,
    { renderUrl: hook },
  );
  c.on('error', () => {});
  await c.start();
  const row = db.getUrlById(db.getUrlIdByUrl(base)!)!;
  return { db, row, cols: [row.cookiesTotal, row.cookiesTruncated, row.cookiesJson] };
}

describe('crawl with the fake render hook: cookie columns', () => {
  it('option on: total, truncated flag and the JSON list are stored', async () => {
    const r = await crawl(hookWith({ total: 3, truncated: false, list: LIST }));
    expect(r.cols).toEqual([3, 0, JSON.stringify(LIST)]);
  });

  it('a cut list keeps the true total and truncated = 1', async () => {
    const r = await crawl(hookWith({ total: 143, truncated: true, list: LIST }));
    expect(r.cols).toEqual([143, 1, JSON.stringify(LIST)]);
  });

  it('a page that set no cookies stores 0 and [] (recorded and none), not NULL', async () => {
    const r = await crawl(hookWith({ total: 0, truncated: false, list: [] }));
    expect(r.cols).toEqual([0, 0, '[]']);
  });

  it('a hook without cookies, a failed render and text mode store NULL', async () => {
    expect((await crawl(hookWith())).cols).toEqual([null, null, null]);
    expect((await crawl(fakeRender({}, { cookies: { total: 1, truncated: false, list: LIST } }))).cols).toEqual([null, null, null]);
    expect((await crawl(undefined, { mode: 'text' })).cols).toEqual([null, null, null]);
  });

  it('option off: nothing stored even if the hook returns a list', async () => {
    const r = await crawl(hookWith({ total: 3, truncated: false, list: LIST }), { cookieList: false });
    expect(r.cols).toEqual([null, null, null]);
  });

  it('refresh with the option off overwrites the three columns with NULL', async () => {
    const first = await crawl(hookWith({ total: 3, truncated: false, list: LIST }));
    expect(first.cols[0]).toBe(3);
    const again = await crawl(hookWith({ total: 3, truncated: false, list: LIST }), { cookieList: false, db: first.db });
    expect(again.cols).toEqual([null, null, null]);
  });
});
