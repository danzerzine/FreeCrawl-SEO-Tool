import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_CRAWL_CONFIG, type CrawlConfig } from '@freecrawl/shared-types';
import { BrowserPool, PlaywrightBrowserMissingError } from './browser-pool.js';
import { browserPoolOptionsFromConfig, renderOptionsFromConfig } from './render-config.js';
import { renderUrl } from './render-fetcher.js';

// B43 with a real Chromium. The main pages are on 127.0.0.1, the iframes on `localhost` (the same local
// server, another site as far as the browser is concerned).
let server: Server;
let port: number;
const here = (p: string): string => `http://127.0.0.1:${port}${p}`;
const there = (p: string): string => `http://localhost:${port}${p}`;
// The barrier of test 8b: /a and /b are answered only when both have arrived.
let barrier: Array<() => void> = [];
const arrive = (release: () => void): void => {
  barrier.push(release);
  if (barrier.length >= 2) {
    const all = barrier;
    barrier = [];
    for (const r of all) r();
  }
};

function html(res: ServerResponse, body: string, cookies: string[] = []): void {
  res.writeHead(200, { 'content-type': 'text/html', ...(cookies.length ? { 'set-cookie': cookies } : {}) }).end(body);
}

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/';
    if (url === '/page') {
      html(
        res,
        `<html><body><h1>P</h1><script src="/sub.js"></script>
<script>document.cookie = 'ga=2; path=/';</script>
<iframe src="${there('/frame')}"></iframe></body></html>`,
        ['sid=SENTINEL_VALUE_1; HttpOnly; Secure; Path=/'],
      );
    } else if (url === '/sub.js') {
      res.writeHead(200, { 'content-type': 'application/javascript', 'set-cookie': 'fromjs=SENTINEL_VALUE_2; Path=/js' }).end('/* no-op */');
    } else if (url === '/frame') {
      html(res, `<html><body><script>document.cookie = 'fra=3; path=/';</script></body></html>`);
    } else if (url === '/other') {
      html(res, '<html><body><h1>Other</h1></body></html>');
    } else if (url === '/a' || url === '/b') {
      const k = url === '/a' ? 'a' : 'b';
      arrive(() =>
        html(
          res,
          `<html><body><h1>${k}</h1>
<script>setTimeout(function(){ document.cookie = 's${k}=1; path=/'; }, ${k === 'a' ? 600 : 0});</script>
<iframe src="${there(`/f${k}`)}"></iframe></body></html>`,
          [`h${k}=1; Path=/`],
        ),
      );
    } else if (url === '/fa' || url === '/fb') {
      const k = url === '/fa' ? 'a' : 'b';
      html(res, `<html><body><script>document.cookie = 'fr${k}=1; path=/';</script></body></html>`);
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

const cfg = (maxPages: number): CrawlConfig => ({
  ...DEFAULT_CRAWL_CONFIG,
  maxConcurrency: maxPages,
  renderingMode: 'js',
  jsRender: { ...DEFAULT_CRAWL_CONFIG.jsRender, cookieList: true, ajaxTimeoutMs: 400, maxPages },
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

describe('B43 real Chromium', () => {
  it('8: header cookies (document and subresource), a script cookie, a cross-site iframe cookie, and nothing of it on the next URL', async () => {
    const config = cfg(1);
    await withPool(config, async (pool) => {
      const sig = new AbortController().signal;
      const opts = renderOptionsFromConfig(config);
      expect(opts.collectCookies).toBe(true);
      const r1 = await renderUrl(here('/page'), pool, opts, sig);
      expect(r1.ok).toBe(true);
      const list = r1.cookies!.list;
      const by = (n: string) => list.find((c) => c.n === n);
      expect(by('sid')).toMatchObject({ d: '127.0.0.1', p: '/', h: 1, s: 1, by: 'header' });
      expect(by('fromjs')).toMatchObject({ d: '127.0.0.1', p: '/js', by: 'header' });
      expect(by('ga')).toMatchObject({ d: '127.0.0.1', p: '/', h: 0, by: 'script' });
      // The write of the cross-site iframe belongs to the iframe's host, even if Chromium refused to store it.
      expect(by('fra')).toMatchObject({ d: 'localhost', p: '/', h: 0, by: 'script' });
      expect(r1.cookies).toMatchObject({ total: 4, truncated: false });
      expect(JSON.stringify(r1.cookies)).not.toContain('SENTINEL_VALUE');
      // The next URL on the same one-slot pool lists none of the first page's cookies.
      const r2 = await renderUrl(here('/other'), pool, opts, sig);
      expect(r2.ok).toBe(true);
      expect(r2.cookies).toEqual({ total: 0, truncated: false, list: [] });
    });
  }, 60_000);

  it('collectCookies off: no list at all, and no listener is left on the page', async () => {
    const config = cfg(1);
    await withPool(config, async (pool) => {
      const r = await renderUrl(here('/page'), pool, { ...renderOptionsFromConfig(config), collectCookies: false }, new AbortController().signal);
      expect(r.ok).toBe(true);
      expect(r.cookies).toBeUndefined();
    });
  }, 60_000);

  it('8b: two slots rendering at once, ten times: each page lists exactly its own cookies (red on any jar read)', async () => {
    const config = cfg(2);
    await withPool(config, async (pool) => {
      const sig = new AbortController().signal;
      const base = renderOptionsFromConfig(config);
      for (let i = 0; i < 10; i++) {
        // B is done (and wipes the shared jar) long before A's own script writes and A reads its list.
        const [a, b] = await Promise.all([
          renderUrl(here('/a'), pool, { ...base, ajaxTimeoutMs: 1500 }, sig),
          renderUrl(here('/b'), pool, { ...base, ajaxTimeoutMs: 100 }, sig),
        ]);
        expect(a.ok && b.ok, `round ${i}`).toBe(true);
        expect(a.cookies!.list.map((c) => c.n).sort(), `A in round ${i}`).toEqual(['fra', 'ha', 'sa']);
        expect(b.cookies!.list.map((c) => c.n).sort(), `B in round ${i}`).toEqual(['frb', 'hb', 'sb']);
        expect(a.cookies!.list.find((c) => c.n === 'fra')).toMatchObject({ d: 'localhost', by: 'script' });
        expect(b.cookies!.list.find((c) => c.n === 'frb')).toMatchObject({ d: 'localhost', by: 'script' });
      }
    });
  }, 120_000);
});
