import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_CRAWL_CONFIG, type CrawlConfig } from '@freecrawl/shared-types';
import { BrowserPool, PlaywrightBrowserMissingError } from './browser-pool.js';
import { browserPoolOptionsFromConfig, renderOptionsFromConfig } from './render-config.js';
import { renderUrl } from './render-fetcher.js';

// B44b with a real Chromium: the files behind the coverage totals. 127.0.0.1 fixtures only.
const CSS = `.used{color:red}${'.unused{color:blue}'.repeat(50)}`;
const JS = `function used(){return 1}\nfunction neverCalled(){${'var x=1;'.repeat(100)}}\nused();\n`;
const INLINE_JS = `function inline(){return 2}\ninline();\n`;

let server: Server;
let port: number;
const here = (p: string): string => `http://127.0.0.1:${port}${p}`;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/page') {
      res.writeHead(200, { 'content-type': 'text/html' }).end(
        `<html><head><link rel="stylesheet" href="/site.css"><script src="/app.js"></script>
<style>.inline{color:green}</style><script>${INLINE_JS}</script></head><body><p class="used inline">x</p></body></html>`,
      );
    } else if (req.url === '/site.css') {
      res.writeHead(200, { 'content-type': 'text/css' }).end(CSS);
    } else if (req.url === '/app.js') {
      res.writeHead(200, { 'content-type': 'application/javascript' }).end(JS);
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

const config: CrawlConfig = {
  ...DEFAULT_CRAWL_CONFIG,
  renderingMode: 'js',
  jsRender: { ...DEFAULT_CRAWL_CONFIG.jsRender, coverage: true, ajaxTimeoutMs: 300, maxPages: 1 },
};

describe('B44b real Chromium', () => {
  it('one entry per external file; the inline style and script count in the totals only', async () => {
    const pool = new BrowserPool(browserPoolOptionsFromConfig(config));
    try {
      await pool.start();
    } catch (err) {
      if (err instanceof PlaywrightBrowserMissingError) {
        console.warn('SKIPPED: Chromium is not installed (', (err as Error).message, ')');
        return;
      }
      throw err;
    }
    try {
      const r = await renderUrl(here('/page'), pool, renderOptionsFromConfig(config), new AbortController().signal);
      expect(r.ok).toBe(true);
      const c = r.coverage!;
      const files = c.files ?? [];
      expect(files.map((f) => [f.url, f.kind, f.bytes]).sort()).toEqual(
        [
          [here('/app.js'), 'js', JS.length],
          [here('/site.css'), 'css', CSS.length],
        ].sort(),
      );
      const css = files.find((f) => f.kind === 'css')!;
      expect(css.unusedBytes).toBeGreaterThan(CSS.length * 0.9);
      // The totals hold the inline code too.
      expect(c.cssBytes).toBeGreaterThan(CSS.length);
      expect(c.jsBytes).toBe(JS.length + INLINE_JS.length);
      console.log('B44b files', JSON.stringify(files));
    } finally {
      await pool.close();
    }
  }, 60_000);
});
