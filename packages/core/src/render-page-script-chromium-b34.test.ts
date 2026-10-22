import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { DEFAULT_CRAWL_CONFIG, type CrawlConfig } from '@freecrawl/shared-types';
import { BrowserPool, PlaywrightBrowserMissingError } from './browser-pool.js';
import { Crawler } from './crawler.js';
import { browserPoolOptionsFromConfig, createRenderHook } from './render-config.js';

// M11 B34 with a real Chromium. Skipped (with a message) when Chromium is not installed.
const LOAD_MORE = `<html><head><title>Listing</title></head><body><h1>H</h1><div id="list"></div>
<button id="more" onclick="var l=document.getElementById('list');for(var i=1;i<=5;i++){var a=document.createElement('a');a.href='/item'+i;a.textContent='item'+i;l.appendChild(a);}">Load more</button>
<a href="/plain">plain</a></body></html>`;
const PLAIN = '<html><head><title>Plain</title></head><body><h1>P</h1></body></html>';

let server: Server;
let dir: string;
let base: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fc-m11-b34c-'));
  server = createServer((req, res) => {
    if (req.url === '/') return void res.writeHead(200, { 'content-type': 'text/html' }).end(LOAD_MORE);
    if (req.url === '/plain') return void res.writeHead(200, { 'content-type': 'text/html' }).end(PLAIN);
    res.writeHead(404).end('nope');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
});
afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

let n = 0;
/** Crawls base ('/') and, through its link, '/plain'. Returns undefined when Chromium is missing. */
async function crawlWith(pageScript: string, jsOver: Partial<CrawlConfig['jsRender']> = {}) {
  const config: CrawlConfig = {
    ...DEFAULT_CRAWL_CONFIG,
    startUrl: base,
    renderingMode: 'js',
    maxConcurrency: 1,
    maxDepth: 1,
    discoverSitemaps: false,
    checkExternalLinks: false,
    probeTlsCerts: false,
    probeManifestJson: false,
    probeSocialImages: false,
    probeImageSizes: false,
    jsRender: { ...DEFAULT_CRAWL_CONFIG.jsRender, ajaxTimeoutMs: 0, pageScript, ...jsOver },
  };
  const pool = new BrowserPool(browserPoolOptionsFromConfig(config));
  const db = new ProjectDb(join(dir, `p${n++}.seoproject`));
  try {
    try {
      await pool.start();
    } catch (err) {
      if (err instanceof PlaywrightBrowserMissingError) {
        console.warn('SKIPPED: Chromium is not installed (', (err as Error).message, ')');
        return undefined;
      }
      throw err;
    }
    const c = new Crawler(config, db, { renderUrl: createRenderHook(pool, config) });
    const warns: string[] = [];
    c.on('warn', (m) => warns.push(String(m)));
    c.on('error', () => {});
    const t0 = Date.now();
    await c.start();
    const row = (path: string) => db.getUrlById(db.getUrlIdByUrl(base + path.slice(1))!)!;
    const home = row('/');
    return {
      home,
      plain: row('/plain'),
      ms: Date.now() - t0,
      warns,
      script: home.extractionResults ? (JSON.parse(home.extractionResults) as Record<string, unknown>)['$script'] : undefined,
      links: db.getOutlinks(home.id, 100).rows.map((r) => r.toUrl),
    };
  } finally {
    await pool.close();
    db.close();
  }
}

describe('page script in real Chromium', () => {
  it('clicks "Load more": the 5 links are in the stored DOM and the title is under $script', async () => {
    const r = await crawlWith(`document.getElementById('more').click(); return document.title;`);
    if (!r) return;
    expect(r.script).toBe('Listing');
    expect(r.links.filter((u) => /\/item\d$/.test(String(u)))).toHaveLength(5);
  }, 60_000);

  it('a throwing script: the page is stored with its normal fields', async () => {
    const r = await crawlWith(`throw new Error('nope')`);
    if (!r) return;
    expect(r.home.statusCode).toBe(200);
    expect(r.home.title).toBe('Listing');
    expect(r.script).toEqual({ error: 'nope' });
    expect(r.warns.filter((m) => m.includes('page script'))).toHaveLength(1);
  }, 60_000);

  it('a never-ending async script ends within the timeout', async () => {
    const r = await crawlWith(`await new Promise(() => {})`, { pageScriptTimeoutMs: 500 });
    if (!r) return;
    expect(r.script).toEqual({ error: 'timeout' });
    expect(r.home.title).toBe('Listing');
    expect(r.ms).toBeLessThan(20_000);
  }, 60_000);

  it('a synchronous while(true){}: the watchdog closes the page, the page is stored from the served HTML', async () => {
    const r = await crawlWith(`while (true) {}`, { pageScriptTimeoutMs: 500 });
    if (!r) return;
    expect(r.home.statusCode).toBe(200);
    expect(r.home.title).toBe('Listing');
    expect(r.home.indexability).not.toContain('no-response');
    expect(r.links).toContain(base + 'plain');
    // The pool replaced the closed page: the next URL rendered normally.
    expect(r.plain.title).toBe('Plain');
  }, 90_000);
});
