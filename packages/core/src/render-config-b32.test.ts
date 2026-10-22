import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { DEFAULT_CRAWL_CONFIG, type CrawlConfig } from '@freecrawl/shared-types';
import { BrowserPool } from './browser-pool.js';
import { Crawler } from './crawler.js';
import { MOBILE_DEVICE_SCALE_FACTOR, MOBILE_USER_AGENT, MOBILE_VIEWPORT } from './http-client.js';
import { browserPoolOptionsFromConfig, createRenderHook } from './render-config.js';

const config = (over: Partial<CrawlConfig> = {}, jsRender: Partial<CrawlConfig['jsRender']> = {}) => ({
  ...DEFAULT_CRAWL_CONFIG,
  ...over,
  jsRender: { ...DEFAULT_CRAWL_CONFIG.jsRender, ...jsRender },
});

describe('browserPoolOptionsFromConfig (B32)', () => {
  it('builds the desktop options from the crawl settings', () => {
    const o = browserPoolOptionsFromConfig(
      config(
        { maxConcurrency: 20, userAgent: 'UA/1', acceptLanguage: 'ru-RU' },
        {
          viewportWidth: 1000,
          viewportHeight: 700,
          browserChannel: 'chrome',
          prerenderJs: 'window.x = 1',
          blockResources: { image: true, font: true, media: false, stylesheet: false, script: true },
        },
      ),
    );
    expect(o).toMatchObject({
      maxPages: 8,
      headless: true,
      viewport: { width: 1000, height: 700 },
      userAgent: 'UA/1',
      acceptLanguage: 'ru-RU',
      channel: 'chrome',
      prerenderJs: 'window.x = 1',
    });
    expect(o.isMobile).toBeUndefined();
    expect([...o.blockResourceTypes!].sort()).toEqual(['font', 'image', 'script']);
  });

  it('takes the page count from the settings, else from the concurrency', () => {
    expect(browserPoolOptionsFromConfig(config({ maxConcurrency: 3 })).maxPages).toBe(3);
    expect(browserPoolOptionsFromConfig(config({ maxConcurrency: 3 }, { maxPages: 12 })).maxPages).toBe(12);
  });

  it('renders as a phone in mobile device mode', () => {
    const o = browserPoolOptionsFromConfig(config({ deviceMode: 'mobile', userAgent: 'UA/1' }));
    expect(o).toMatchObject({
      viewport: { width: MOBILE_VIEWPORT.width, height: MOBILE_VIEWPORT.height },
      isMobile: true,
      deviceScaleFactor: MOBILE_DEVICE_SCALE_FACTOR,
      userAgent: MOBILE_USER_AGENT,
    });
  });

  it('leaves out what is not set', () => {
    const o = browserPoolOptionsFromConfig(
      config({ userAgent: '', acceptLanguage: '' }, { blockResources: { image: false, font: false, media: false, stylesheet: false, script: false } }),
    );
    expect(o.userAgent).toBeUndefined();
    expect(o.acceptLanguage).toBeUndefined();
    expect(o.channel).toBeUndefined();
    expect(o.prerenderJs).toBeUndefined();
    expect(o.blockResourceTypes).toBeUndefined();
  });
});

let server: Server;
let dir: string;
let base: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fc-b32-'));
  server = createServer((req, res) => {
    if (req.url !== '/') return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'text/html' }).end(
      '<html><head><title>JS</title></head><body><div id="nav"></div>' +
        '<script>document.getElementById("nav").innerHTML = \'<a href="/from-script">s</a>\';</script></body></html>',
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
});
afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('createRenderHook (B32)', () => {
  it('returns the DOM after the scripts ran', async () => {
    const c = config({ maxConcurrency: 1 });
    const pool = new BrowserPool(browserPoolOptionsFromConfig(c));
    try {
      const r = await createRenderHook(pool, c)(base, null, new AbortController().signal);
      expect(r.ok).toBe(true);
      expect(r.html).toContain('href="/from-script"');
      expect(r.timingMs).toBeGreaterThan(0);
    } finally {
      await pool.close();
    }
  }, 60_000);
});

describe('JavaScript rendering without a browser (B32)', () => {
  const run = async (renderingMode: CrawlConfig['renderingMode']) => {
    const db = new ProjectDb(join(dir, `${renderingMode}.seoproject`));
    const c = new Crawler(
      config({
        startUrl: base,
        renderingMode,
        maxConcurrency: 1,
        discoverSitemaps: false,
        checkExternalLinks: false,
        probeTlsCerts: false,
        probeManifestJson: false,
        probeSocialImages: false,
        probeImageSizes: false,
      }),
      db,
      {},
    );
    const warns: string[] = [];
    c.on('warn', (m) => warns.push(String(m)));
    c.on('error', () => {});
    await c.start();
    db.close();
    return warns;
  };

  it('warns once that pages are read as plain HTML', async () => {
    const warns = await run('js');
    expect(
      warns.filter((m) => m === 'JavaScript rendering is on but this run has no browser: pages are read as plain HTML'),
    ).toHaveLength(1);
  }, 60_000);

  it('says nothing when rendering is off', async () => {
    expect((await run('text')).filter((m) => m.startsWith('JavaScript rendering'))).toEqual([]);
  }, 60_000);
});
