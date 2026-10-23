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

// B44: coverage numbers through a Crawler run with the fake render hook (no browser).
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
  dir = mkdtempSync(join(tmpdir(), 'fc-b44-'));
  server = createServer((_req, res) => void res.writeHead(200, { 'content-type': 'text/html' }).end(HTML));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

const COV = { cssBytes: 1000, cssUnusedBytes: 700, jsBytes: 5000, jsUnusedBytes: 1200 };
const hookWith = (coverage?: typeof COV) => fakeRender({ [base]: HTML }, { coverage });

let n = 0;
async function crawl(
  hook: RenderHook | undefined,
  o: { mode?: CrawlConfig['renderingMode']; coverage?: boolean; db?: ProjectDb } = {},
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
      jsRender: { ...DEFAULT_CRAWL_CONFIG.jsRender, coverage: o.coverage ?? true },
    },
    db,
    { renderUrl: hook },
  );
  c.on('error', () => {});
  await c.start();
  const row = db.getUrlById(db.getUrlIdByUrl(base)!)!;
  return { db, cols: [row.cssBytes, row.cssUnusedBytes, row.jsBytes, row.jsUnusedBytes] };
}

describe('crawl with the fake render hook: coverage columns', () => {
  it('option on: the four numbers are stored', async () => {
    expect((await crawl(hookWith(COV))).cols).toEqual([1000, 700, 5000, 1200]);
  });
  it('zeros are stored as zeros (a page with no CSS or JS), not NULL', async () => {
    const z = { cssBytes: 0, cssUnusedBytes: 0, jsBytes: 0, jsUnusedBytes: 0 };
    expect((await crawl(hookWith(z))).cols).toEqual([0, 0, 0, 0]);
  });
  it('a hook without coverage, a failed render and text mode store NULL', async () => {
    const nul = [null, null, null, null];
    expect((await crawl(hookWith())).cols).toEqual(nul);
    expect((await crawl(fakeRender({}, { coverage: COV }))).cols).toEqual(nul);
    expect((await crawl(undefined, { mode: 'text' })).cols).toEqual(nul);
  });
  it('option off: nothing stored even if the hook returns numbers', async () => {
    expect((await crawl(hookWith(COV), { coverage: false })).cols).toEqual([null, null, null, null]);
  });
  it('refresh with the option off overwrites the four columns with NULL', async () => {
    const first = await crawl(hookWith(COV));
    expect(first.cols[0]).toBe(1000);
    const again = await crawl(hookWith(COV), { coverage: false, db: first.db });
    expect(again.cols).toEqual([null, null, null, null]);
  });
});
