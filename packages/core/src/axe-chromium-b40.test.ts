import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { DEFAULT_CRAWL_CONFIG, type CrawlConfig } from '@freecrawl/shared-types';
import { BrowserPool, PlaywrightBrowserMissingError } from './browser-pool.js';
import { Crawler } from './crawler.js';
import { browserPoolOptionsFromConfig, renderHookFields, renderOptionsFromConfig } from './render-config.js';
import { renderUrl, type RenderOptions } from './render-fetcher.js';

// B40 R4-R7 with a real Chromium (the Mac has one, the PC repeats it). Skipped, with a message,
// where Chromium is not installed (same guard as render-compare-chromium-b33.test.ts).
const DEFECTS = `<!doctype html><html lang="en"><head><title>Defects</title></head><body>
<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
<p style="color:#ccc;background:#fff">low contrast text here</p>
<button></button>
<div id="d"></div><div id="d"></div>
</body></html>`;
const CLEAN = `<!doctype html><html lang="en"><head><title>Clean page</title></head><body><main><h1>Hello</h1><p>Plain readable text.</p></main></body></html>`;
const HANG = 'window.axe = { run: () => new Promise(() => {}) };';

let server: Server;
let other: Server;
let dir: string;
let base: string;
let otherBase: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fc-b40chr-'));
  other = createServer((_req, res) => void res.writeHead(200, { 'content-type': 'text/html' }).end(DEFECTS));
  await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
  otherBase = `http://127.0.0.1:${(other.address() as { port: number }).port}/`;
  server = createServer((req, res) => {
    const u = req.url ?? '/';
    if (u === '/defects') return void res.writeHead(200, { 'content-type': 'text/html' }).end(DEFECTS);
    if (u === '/csp')
      return void res
        .writeHead(200, { 'content-type': 'text/html', 'content-security-policy': "script-src 'none'; default-src 'self'" })
        .end(DEFECTS);
    if (u === '/missing') return void res.writeHead(404, { 'content-type': 'text/html' }).end(DEFECTS);
    if (u === '/json') return void res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    if (u === '/frame')
      return void res
        .writeHead(200, { 'content-type': 'text/html' })
        .end(`<!doctype html><html lang="en"><head><title>F</title></head><body><main><h1>Host</h1><iframe src="${otherBase}" title="x"></iframe></main></body></html>`);
    if (u === '/') return void res.writeHead(200, { 'content-type': 'text/html' }).end(CLEAN);
    res.writeHead(404).end('nope');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => {
  server.close();
  other.close();
  rmSync(dir, { recursive: true, force: true });
});

const baseConfig = (over: Partial<CrawlConfig> = {}, js: Partial<CrawlConfig['jsRender']> = {}): CrawlConfig => ({
  ...DEFAULT_CRAWL_CONFIG,
  startUrl: `${base}/`,
  renderingMode: 'js',
  maxConcurrency: 1,
  discoverSitemaps: false,
  checkExternalLinks: false,
  probeTlsCerts: false,
  probeManifestJson: false,
  probeSocialImages: false,
  probeImageSizes: false,
  ...over,
  jsRender: { ...DEFAULT_CRAWL_CONFIG.jsRender, ajaxTimeoutMs: 0, axeAudit: true, maxPages: 1, ...js },
});

/** A started pool whose page hand-outs are recorded; undefined when Chromium is missing. */
async function withPool<T>(
  config: CrawlConfig,
  fn: (ctx: { pool: BrowserPool; released: boolean[]; opts: RenderOptions; onAxeEvaluate: (f: (page: Page) => Promise<void>) => void }) => Promise<T>,
): Promise<T | undefined> {
  const real = new BrowserPool(browserPoolOptionsFromConfig(config));
  try {
    await real.start();
  } catch (err) {
    if (err instanceof PlaywrightBrowserMissingError) {
      console.warn('SKIPPED: Chromium is not installed (', (err as Error).message, ')');
      return undefined;
    }
    throw err;
  }
  const released: boolean[] = [];
  let beforeAxe: ((page: Page) => Promise<void>) | null = null;
  const spy = {
    isClosed: () => real.isClosed(),
    acquire: async () => {
      const h = await real.acquire();
      const orig = h.page.evaluate.bind(h.page) as (...a: unknown[]) => Promise<unknown>;
      (h.page as unknown as { evaluate: unknown }).evaluate = async (...a: unknown[]) => {
        if (beforeAxe && typeof a[0] === 'string' && a[0].includes('axe.run')) await beforeAxe(h.page);
        return orig(...a);
      };
      return { page: h.page, release: (d?: boolean) => { released.push(d === true); h.release(d); } };
    },
  } as unknown as BrowserPool;
  try {
    return await fn({ pool: spy, released, opts: renderOptionsFromConfig(config), onAxeEvaluate: (f) => { beforeAxe = f; } });
  } finally {
    await real.close();
  }
}

describe('renderUrl with detectAxe in real Chromium', () => {
  it('finds the known defects with the real axe rules and stores a reduced result (R4, R5)', async () => {
    await withPool(baseConfig(), async ({ pool, opts }) => {
      const r = await renderUrl(`${base}/defects`, pool, opts);
      expect(r.ok).toBe(true);
      expect(r.axe).toBeTruthy();
      const ids = r.axe!.violations.map((v) => v.id);
      expect(ids).toEqual(expect.arrayContaining(['image-alt', 'color-contrast', 'button-name']));
      expect(r.axe!.version).toMatch(/^4\./);
      const alt = r.axe!.violations.find((v) => v.id === 'image-alt')!;
      expect(alt.impact).toBe('critical');
      expect(alt.nodes).toBeGreaterThan(0);
      expect(alt.samples[0]!.html).toContain('<img');
      expect(alt.helpUrl).toContain('image-alt');
      expect(r.axe!.violationsTotal).toBe(r.axe!.violations.length);
      expect(r.axeMs).toBeGreaterThan(0);
      // Only WCAG A/AA tags are on: no best-practice-only rule such as 'region'.
      expect(ids).not.toContain('region');
      // The stored HTML is taken before axe runs and carries none of its effects.
      expect(r.html).not.toMatch(/data-axe/);
      expect(JSON.stringify(r.axe).length).toBeLessThanOrEqual(30 * 1024);
    });
  }, 60_000);

  it('a clean page is audited and clean: an empty violation list, not null', async () => {
    await withPool(baseConfig(), async ({ pool, opts }) => {
      const r = await renderUrl(`${base}/`, pool, opts);
      expect(r.axe).toBeTruthy();
      expect(r.axe!.violations).toEqual([]);
      expect(r.axe!.violationsTotal).toBe(0);
    });
  }, 60_000);

  it('a page whose CSP forbids all scripts is still audited (evaluate is not blocked by page CSP)', async () => {
    await withPool(baseConfig(), async ({ pool, opts }) => {
      const r = await renderUrl(`${base}/csp`, pool, opts);
      expect(r.ok).toBe(true);
      expect(r.axe?.violations.map((v) => v.id)).toEqual(expect.arrayContaining(['image-alt', 'button-name']));
    });
  }, 60_000);

  it('does not run on a 404, or on non-HTML content; axe is null and no time is reported', async () => {
    await withPool(baseConfig(), async ({ pool, opts }) => {
      for (const path of ['/missing', '/json']) {
        const r = await renderUrl(`${base}${path}`, pool, opts);
        expect(r.axe ?? null, path).toBeNull();
        expect(r.axeMs, path).toBeUndefined();
      }
    });
  }, 60_000);

  it('with the option off nothing is injected: axe is undefined and window.axe does not exist', async () => {
    await withPool(baseConfig({}, { axeAudit: false }), async ({ pool, opts }) => {
      const r = await renderUrl(`${base}/defects`, pool, opts);
      expect(r.axe).toBeUndefined();
      expect(r.axeMs).toBeUndefined();
    });
  }, 60_000);

  it('does not audit inside a cross-origin iframe and does not report the frame as needing review (R5)', async () => {
    await withPool(baseConfig(), async ({ pool, opts }) => {
      const r = await renderUrl(`${base}/frame`, pool, opts);
      expect(r.ok).toBe(true);
      expect(r.axe).toBeTruthy();
      expect(r.axe!.violations.map((v) => v.id)).not.toContain('image-alt');
      expect(r.axe!.incomplete.map((v) => v.id)).not.toContain('frame-tested');
    });
  }, 60_000);

  it('render time (timingMs) is taken before axe: a slow axe shows in axeMs only (R4)', async () => {
    await withPool(baseConfig(), async ({ pool, opts }) => {
      const r = await renderUrl(`${base}/`, pool, opts);
      const real = await import('./axe-run.js').then((m) => m.loadAxeSource()!);
      const slow = real + ';(function(){var run=axe.run;axe.run=function(){var a=arguments;return new Promise(function(r){setTimeout(r,900)}).then(function(){return run.apply(axe,a)})}})();';
      const s = await renderUrl(`${base}/`, pool, { ...opts, axeSource: slow });
      expect(s.axeMs).toBeGreaterThanOrEqual(900);
      expect(s.timingMs).toBeLessThan(s.axeMs!);
      expect(Math.abs(s.timingMs - r.timingMs)).toBeLessThan(800);
    });
  }, 60_000);

  it('R6: an axe.run that never finishes hits AXE_RUN_MS, the render still returns ok with axe null, a page that still answers stays warm', async () => {
    await withPool(baseConfig(), async ({ pool, opts, released }) => {
      const t0 = Date.now();
      const r = await renderUrl(`${base}/defects`, pool, { ...opts, axeSource: HANG, axeRunMs: 700 });
      expect(r.ok).toBe(true);
      expect(r.html).toContain('low contrast text here');
      expect(r.axe ?? null).toBeNull();
      expect(r.axeMs).toBeGreaterThanOrEqual(700);
      expect(r.axeError).toMatch(/timeout|did not finish/i);
      expect(Date.now() - t0).toBeLessThan(15_000);
      expect(released).toEqual([false]);
    });
  }, 60_000);

  it('R6: an axe.run that blocks the page is probed, and the stuck page is replaced (release(true))', async () => {
    await withPool(baseConfig(), async ({ pool, opts, released }) => {
      const r = await renderUrl(`${base}/defects`, pool, {
        ...opts,
        axeSource: 'window.axe = { run: () => { for (;;) {} } };',
        axeRunMs: 500,
        axeProbeMs: 400,
      });
      expect(r.ok).toBe(true);
      expect(r.html).toContain('low contrast text here');
      expect(r.axe ?? null).toBeNull();
      expect(released).toEqual([true]);
    });
  }, 60_000);

  it('R6: a tab that crashes during axe still returns the render, and the dead page is replaced, not handed back warm', async () => {
    await withPool(baseConfig(), async ({ pool, opts, released, onAxeEvaluate }) => {
      onAxeEvaluate(async (page) => {
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Page.crash').catch(() => {});
      });
      const r = await renderUrl(`${base}/defects`, pool, opts);
      expect(r.ok).toBe(true);
      expect(r.html).toContain('low contrast text here');
      expect(r.axe ?? null).toBeNull();
      expect(r.axeMs).toBeDefined();
      expect(released).toEqual([true]);
    });
  }, 60_000);

  it('R6: a plain JavaScript error from axe keeps the page warm (release(false))', async () => {
    await withPool(baseConfig(), async ({ pool, opts, released }) => {
      const r = await renderUrl(`${base}/`, pool, { ...opts, axeSource: 'window.axe = { run: () => { throw new Error("boom") } };' });
      expect(r.ok).toBe(true);
      expect(r.axe ?? null).toBeNull();
      expect(r.axeError).toContain('boom');
      expect(released).toEqual([false]);
    });
  }, 60_000);

  it('R6: a missing axe source is one failed run with a reason, not a crash', async () => {
    await withPool(baseConfig(), async ({ pool, opts }) => {
      const r = await renderUrl(`${base}/`, pool, { ...opts, axeSource: null });
      expect(r.ok).toBe(true);
      expect(r.axe ?? null).toBeNull();
      expect(r.axeError).toMatch(/not found|unreadable|missing/i);
    });
  }, 60_000);
});

describe('R6a through the real Crawler: the fetch timer must not cut a render whose axe never finishes', () => {
  it('requestTimeoutMs 3 s, axe hangs until its 5 s cap: the page is stored with status 200 and no axe', async () => {
    // AXE_RUN_MS (the knob below) must stay ABOVE the crawler's requestTimeoutMs here: only then
    // would the fetch timer fire during axe and turn the page into "Network error" if it still ran.
    const config = baseConfig({ requestTimeoutMs: 3000, maxDepth: 0 });
    const out = await withPool(config, async ({ pool, opts }) => {
      const db = new ProjectDb(join(dir, 'r6a.seoproject'));
      const hook = async (url: string, _id: number | null, signal: AbortSignal) =>
        renderHookFields(await renderUrl(url, pool, { ...opts, axeSource: HANG, axeRunMs: 5000 }, signal));
      const c = new Crawler(config, db, { renderUrl: hook });
      const infos: string[] = [];
      c.on('error', () => {});
      c.on('warn', (m: string) => infos.push(m));
      c.on('info', (m: string) => infos.push(m));
      await c.start();
      const row = db.getUrlById(db.getUrlIdByUrl(`${base}/`)!)!;
      const axeCols = [row.axeViolations, row.axeSerious, row.axeIncomplete];
      db.close();
      return { status: row.statusCode, axeCols, infos };
    });
    if (!out) return;
    expect(out.status).toBe(200);
    expect(out.axeCols).toEqual([null, null, null]);
    expect(out.infos.some((m) => /axe-core did not finish/.test(m))).toBe(true);
    expect(out.infos.some((m) => /axe-core: 0 pages, avg 0 ms, 1 failed/.test(m))).toBe(true);
  }, 90_000);
});
