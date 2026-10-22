import { createServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectDb } from '@freecrawl/db';
import { DEFAULT_CRAWL_CONFIG, type CrawlConfig } from '@freecrawl/shared-types';
import { Crawler } from './crawler.js';
import { BrowserPool, PlaywrightBrowserMissingError } from './browser-pool.js';
import { browserPoolOptionsFromConfig, createRenderHook } from './render-config.js';

// B35 with a real Chromium: counts of console errors and failed resources, and no leak into the next page.
let server: Server;
let base: string;
let closedPort: number;
const pending: Array<() => void> = [];

beforeAll(async () => {
  // A port nothing listens on: the refused image.
  const probe = createNetServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  closedPort = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));
  server = createServer((req, res) => {
    if (req.url === '/p1') {
      res.writeHead(200, { 'content-type': 'text/html' }).end(`<html><body><h1>One</h1>
<script>console.error('x')</script>
<script>setTimeout(function(){ throw new Error('boom'); }, 0)</script>
<script src="/missing.js"></script>
<img src="http://127.0.0.1:${closedPort}/i.png">
<script>fetch('/slow').catch(function(){})</script></body></html>`);
    } else if (req.url === '/p2') {
      res.writeHead(200, { 'content-type': 'text/html' }).end('<html><body><h1>Two</h1></body></html>');
    } else if (req.url === '/slow') {
      pending.push(() => res.end('late')); // never answered during the test
    } else res.writeHead(404).end('nope');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => {
  for (const f of pending) f();
  server.closeAllConnections();
  server.close();
});

const cfg = (blockImages: boolean): CrawlConfig => ({
  ...DEFAULT_CRAWL_CONFIG,
  maxConcurrency: 1,
  renderingMode: 'js',
  jsRender: {
    ...DEFAULT_CRAWL_CONFIG.jsRender,
    consoleErrors: true,
    ajaxTimeoutMs: 400,
    maxPages: 1,
    blockResources: { ...DEFAULT_CRAWL_CONFIG.jsRender.blockResources, media: false, image: blockImages },
  },
});

async function withPool<T>(config: CrawlConfig, fn: (pool: BrowserPool) => Promise<T>): Promise<T | 'skipped'> {
  const pool = new BrowserPool(browserPoolOptionsFromConfig(config));
  try {
    await pool.start();
  } catch (err) {
    if (err instanceof PlaywrightBrowserMissingError) {
      console.warn('SKIPPED: Chromium is not installed (', (err as Error).message, ')');
      return 'skipped';
    }
    throw err;
  }
  try {
    return await fn(pool);
  } finally {
    await pool.close();
  }
}

it('real Chromium: console error + page error = 2, the 404 script and the refused image = 2, page 2 is clean', async () => {
  const config = cfg(false);
  await withPool(config, async (pool) => {
    const hook = createRenderHook(pool, config);
    const sig = new AbortController().signal;
    const r1 = await hook(`${base}/p1`, null, sig);
    expect(r1.consoleLog?.errors).toBe(2);
    expect(r1.consoleLog?.failed).toBe(2);
    const kinds = r1.consoleLog!.entries.map((e) => e.kind).sort();
    expect(kinds).toEqual(['console', 'failed', 'http', 'pageerror']);
    // Page 2 on the same one-slot pool, while page 1's fetch is still pending.
    const r2 = await hook(`${base}/p2`, null, sig);
    expect(r2.ok).toBe(true);
    expect(r2.consoleLog).toEqual({ errors: 0, failed: 0, entries: [] });
  });
}, 60_000);

it('real Chromium: with images blocked the refused image is not a failed resource', async () => {
  const config = cfg(true);
  await withPool(config, async (pool) => {
    const r1 = await createRenderHook(pool, config)(`${base}/p1`, null, new AbortController().signal);
    expect(r1.consoleLog?.errors).toBe(2);
    expect(r1.consoleLog?.failed).toBe(1);
  });
}, 60_000);

it('real Chromium: a crawl stores console_errors = 2, failed_resources = 2 and the entries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fc-m11-b35-ch-'));
  const config: CrawlConfig = {
    ...cfg(false),
    startUrl: `${base}/p1`,
    discoverSitemaps: false,
    checkExternalLinks: false,
    probeTlsCerts: false,
    probeManifestJson: false,
    probeSocialImages: false,
    probeImageSizes: false,
  };
  const db = new ProjectDb(join(dir, 'p.seoproject'));
  try {
    await withPool(config, async (pool) => {
      const c = new Crawler(config, db, { renderUrl: createRenderHook(pool, config) });
      c.on('error', () => {});
      await c.start();
      const row = db.getUrlById(db.getUrlIdByUrl(`${base}/p1`)!)!;
      expect([row.consoleErrors, row.failedResources]).toEqual([2, 2]);
      expect(JSON.parse(row.consoleLog!)).toHaveLength(4);
    });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
