import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_CRAWL_CONFIG, type CrawlConfig } from '@freecrawl/shared-types';
import { BrowserPool, PlaywrightBrowserMissingError } from './browser-pool.js';
import { browserPoolOptionsFromConfig, renderOptionsFromConfig } from './render-config.js';
import { renderUrl } from './render-fetcher.js';

// B44 with a real Chromium: 127.0.0.1 fixtures only.

// Ten rules of exactly 1000 characters each and no text between them: 10,000 characters, and a page that
// uses three of them leaves exactly 7,000 unused.
const RULE_LEN = 1000;
const rule = (i: number): string => {
  const head = `.r${i}{`;
  const tail = '}';
  return head + `background:url(data:,${'x'.repeat(RULE_LEN - head.length - tail.length - 'background:url(data:,)'.length)})` + tail;
};
const CSS = Array.from({ length: 10 }, (_, i) => rule(i)).join('');
// A script with one function that runs and one that never does (about 70 % of the text).
const USED_FN = `function used(){var a=0;${'a+=1;'.repeat(100)}return a;}`;
const UNUSED_FN = `function neverCalled(){var b=0;${'b+=2;'.repeat(240)}return b;}`;
const JS = `${USED_FN}\n${UNUSED_FN}\nused();\n`;

// axe-core is not installed in every checkout; a stand-in with the same entry point proves the stage still runs
// after coverage. The real library is covered by the B40 tests.
const FAKE_AXE =
  'window.axe = { run: () => Promise.resolve({ violations: [{ id: "button-name", impact: "critical", nodes: [{ target: ["button"] }], help: "x", helpUrl: "u", tags: [] }], incomplete: [] }) };';

let server: Server;
let port: number;
const here = (p: string): string => `http://127.0.0.1:${port}${p}`;

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/';
    const page = (body: string): void => void res.writeHead(200, { 'content-type': 'text/html' }).end(body);
    if (url === '/page') {
      page(`<html><head><link rel="stylesheet" href="/big.css"><script src="/app.js"></script></head>
<body><div class="r0 r1 r2">three of ten rules</div><button>b</button></body></html>`);
    } else if (url === '/big.css') {
      res.writeHead(200, { 'content-type': 'text/css' }).end(CSS);
    } else if (url === '/app.js') {
      res.writeHead(200, { 'content-type': 'application/javascript' }).end(JS);
    } else if (url === '/plain') {
      page('<html><head><title>x</title></head><body><p>nothing to measure</p></body></html>');
    } else {
      res.writeHead(404).end('nope');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

const cfg = (over: Partial<CrawlConfig['jsRender']> = {}): CrawlConfig => ({
  ...DEFAULT_CRAWL_CONFIG,
  renderingMode: 'js',
  jsRender: { ...DEFAULT_CRAWL_CONFIG.jsRender, coverage: true, ajaxTimeoutMs: 300, maxPages: 1, ...over },
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

describe('B44 real Chromium', () => {
  it('9: a 10 KB stylesheet using 3 of 10 rules and a script with one never-called function', async () => {
    const config = cfg();
    await withPool(config, async (pool) => {
      const sig = new AbortController().signal;
      const r = await renderUrl(here('/page'), pool, renderOptionsFromConfig(config), sig);
      expect(r.ok).toBe(true);
      const c = r.coverage!;
      expect(c.cssBytes).toBe(CSS.length);
      expect(c.cssBytes).toBe(10_000);
      // Hand-computed: 7 of 10 rules unused = 7000, within 5 % of the stylesheet.
      expect(Math.abs(c.cssUnusedBytes - 7000)).toBeLessThanOrEqual(500);
      // The inline-free page has exactly one script of JS.length characters.
      expect(c.jsBytes).toBe(JS.length);
      expect(Math.abs(c.jsUnusedBytes - UNUSED_FN.length)).toBeLessThanOrEqual(Math.ceil(JS.length * 0.05));
      console.log('B44 test 9 numbers', JSON.stringify({ expectedCssUnused: 7000, expectedJsUnused: UNUSED_FN.length, ...c }));
    });
  }, 60_000);

  it('9: a page without any CSS or JS gives zeros; an unreachable page gives no coverage', async () => {
    const config = cfg();
    await withPool(config, async (pool) => {
      const sig = new AbortController().signal;
      const plain = await renderUrl(here('/plain'), pool, renderOptionsFromConfig(config), sig);
      expect(plain.ok).toBe(true);
      expect(plain.coverage).toEqual({ cssBytes: 0, cssUnusedBytes: 0, jsBytes: 0, jsUnusedBytes: 0 });
      const dead = await renderUrl('http://127.0.0.1:1/', pool, renderOptionsFromConfig(config), sig);
      expect(dead.ok).toBe(false);
      expect(dead.coverage).toBeUndefined();
    });
  }, 60_000);

  it('a reused page: the same page rendered again gives the same numbers, nothing of the previous document is counted', async () => {
    const config = cfg();
    await withPool(config, async (pool) => {
      const sig = new AbortController().signal;
      const opts = renderOptionsFromConfig(config);
      const first = await renderUrl(here('/page'), pool, opts, sig);
      const plain = await renderUrl(here('/plain'), pool, opts, sig);
      const again = await renderUrl(here('/page'), pool, opts, sig);
      expect(plain.coverage).toEqual({ cssBytes: 0, cssUnusedBytes: 0, jsBytes: 0, jsUnusedBytes: 0 });
      expect(again.coverage).toEqual(first.coverage);
      expect(again.coverage!.cssBytes).toBe(10_000);
    });
  }, 60_000);

  it('option off: no coverage, and the next render on the same page is not affected', async () => {
    const config = cfg({ coverage: false });
    await withPool(config, async (pool) => {
      const sig = new AbortController().signal;
      const off = await renderUrl(here('/page'), pool, renderOptionsFromConfig(config), sig);
      expect(off.coverage).toBeUndefined();
      const on = await renderUrl(here('/page'), pool, { ...renderOptionsFromConfig(config), collectCoverage: true }, sig);
      expect(on.coverage!.cssBytes).toBe(10_000);
      const off2 = await renderUrl(here('/page'), pool, renderOptionsFromConfig(config), sig);
      expect(off2.coverage).toBeUndefined();
    });
  }, 60_000);

  it('10: coverage with the cookie list, console errors, a pre-render script and axe: all of them still work', async () => {
    const config = cfg({
      cookieList: true,
      consoleErrors: true,
      prerenderJs: 'window.__pre = 1; document.cookie = "pre=1; path=/";',
    });
    await withPool(config, async (pool) => {
      const sig = new AbortController().signal;
      const r = await renderUrl(here('/page'), pool, { ...renderOptionsFromConfig(config), detectAxe: true, axeSource: FAKE_AXE }, sig);
      expect(r.ok).toBe(true);
      expect(r.coverage!.cssBytes).toBe(10_000);
      expect(r.cookies!.list.map((c) => c.n)).toContain('pre');
      expect(r.consoleLog).toBeDefined();
      expect(r.axe?.violations ?? r.axe).toBeTruthy();
      expect(r.html).toContain('three of ten rules');
    });
  }, 90_000);
});
