import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { DEFAULT_CRAWL_CONFIG } from '@freecrawl/shared-types';
import { BrowserPool, PlaywrightBrowserMissingError } from './browser-pool.js';
import { Crawler } from './crawler.js';
import { browserPoolOptionsFromConfig, createRenderHook } from './render-config.js';

// B33 with a real Chromium: a script rewrites the H1, adds a link, sets a canonical and adds text.
const PAGE = `<html><head><title>T</title></head><body><h1>Old</h1><p>short</p><a href="/one">one</a>
<script>
document.querySelector('h1').textContent = 'New';
var l = document.createElement('link'); l.rel = 'canonical'; l.href = '/canon'; document.head.appendChild(l);
var a = document.createElement('a'); a.href = '/added-by-js'; a.textContent = 'x'; document.body.appendChild(a);
var p = document.createElement('p'); p.textContent = '${'word '.repeat(80)}'; document.body.appendChild(p);
</script></body></html>`;

let server: Server;
let dir: string;
let base: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fc-m11-chromium-'));
  server = createServer((req, res) => {
    if (req.url === '/') res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
    else res.writeHead(404).end('nope');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
});
afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

it('real Chromium: H1, canonical, links and text written by script give four verdicts of 1', async () => {
  const config = {
    ...DEFAULT_CRAWL_CONFIG,
    startUrl: base,
    renderingMode: 'js' as const,
    maxConcurrency: 1,
    discoverSitemaps: false,
    checkExternalLinks: false,
    probeTlsCerts: false,
    probeManifestJson: false,
    probeSocialImages: false,
    probeImageSizes: false,
    jsRender: { ...DEFAULT_CRAWL_CONFIG.jsRender },
  };
  const pool = new BrowserPool(browserPoolOptionsFromConfig(config));
  const db = new ProjectDb(join(dir, 'p.seoproject'));
  try {
    try {
      await pool.start();
    } catch (err) {
      if (err instanceof PlaywrightBrowserMissingError) {
        console.warn('SKIPPED: Chromium is not installed (', (err as Error).message, ')');
        return;
      }
      throw err;
    }
    const c = new Crawler(config, db, { renderUrl: createRenderHook(pool, config) });
    c.on('error', () => {});
    await c.start();
    const row = db.getUrlById(db.getUrlIdByUrl(base)!)!;
    expect([row.jsH1Changed, row.jsCanonicalChanged, row.jsLinksChanged, row.jsTextChanged]).toEqual([1, 1, 1, 1]);
    const d = JSON.parse(row.renderDiff!);
    expect(d.h1).toEqual({ served: 'Old', rendered: 'New' });
    expect(d.links.addedTargets).toEqual([`${base}added-by-js`]);
  } finally {
    await pool.close();
    db.close();
  }
}, 60_000);
