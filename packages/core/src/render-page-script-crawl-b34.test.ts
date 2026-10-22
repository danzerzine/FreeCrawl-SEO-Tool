import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { DEFAULT_CRAWL_CONFIG, type CrawlConfig } from '@freecrawl/shared-types';
import { Crawler } from './crawler.js';
import { fakeRender } from './fake-render.test-support.js';
import { renderOptionsFromConfig, type RenderHook } from './render-config.js';

// M11 B34 through a Crawler run with the fake render hook: the $script result, the
// fetch and response-time timers, the failed-render fallback, Stop.
const SERVED = '<html><head><title>Served</title></head><body><h1>H</h1><a href="/next">n</a></body></html>';
const RENDERED = '<html><head><title>Rendered</title></head><body><h1>H</h1></body></html>';
let server: Server;
let dir: string;
let base: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fc-m11-b34-'));
  server = createServer((req, res) => {
    if (req.url === '/' || req.url === '/next')
      return void res.writeHead(200, { 'content-type': 'text/html' }).end(SERVED);
    res.writeHead(404).end('nope');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

let n = 0;
function makeCrawler(hook: RenderHook, over: Partial<CrawlConfig> = {}, pageScript = 'return 1') {
  const db = new ProjectDb(join(dir, `p${n++}.seoproject`));
  const c = new Crawler(
    {
      ...DEFAULT_CRAWL_CONFIG,
      startUrl: base + '/',
      renderingMode: 'js',
      maxConcurrency: 1,
      discoverSitemaps: false,
      checkExternalLinks: false,
      probeTlsCerts: false,
      probeManifestJson: false,
      probeSocialImages: false,
      probeImageSizes: false,
      jsRender: { ...DEFAULT_CRAWL_CONFIG.jsRender, pageScript },
      ...over,
    },
    db,
    { renderUrl: hook },
  );
  const warns: string[] = [];
  c.on('warn', (m) => warns.push(String(m)));
  c.on('error', () => {});
  return { c, db, warns };
}
const rowOf = (db: ProjectDb, path: string) => db.getUrlById(db.getUrlIdByUrl(base + path)!)!;

describe('$script result', () => {
  it('lands in extraction_results under "$script"', async () => {
    const { c, db } = makeCrawler(
      fakeRender({ [base + '/']: RENDERED, [base + '/next']: RENDERED }, { scriptRan: true, scriptResult: '{"n":3}' }),
    );
    await c.start();
    const ex = JSON.parse(rowOf(db, '/').extractionResults!);
    expect(ex['$script']).toEqual({ n: 3 });
  });

  it('nothing is stored when the script returned nothing', async () => {
    const { c, db } = makeCrawler(fakeRender({ [base + '/']: RENDERED }, { scriptRan: true }));
    await c.start();
    expect(rowOf(db, '/').extractionResults).toBeNull();
  });

  it('an error result is warned once per crawl, without the script text', async () => {
    const { c, warns } = makeCrawler(
      fakeRender(
        { [base + '/']: RENDERED, [base + '/next']: RENDERED },
        { scriptRan: true, scriptResult: '{"error":"boom"}' },
      ),
      {},
      'SECRET_SCRIPT_BODY()',
    );
    await c.start();
    const w = warns.filter((m) => m.includes('page script'));
    expect(w).toHaveLength(1);
    expect(warns.join('\n')).not.toContain('SECRET_SCRIPT_BODY');
  });
});

describe('timers of a render with a page script (R2-1, R2-2)', () => {
  it('a hook slower than requestTimeoutMs and maxResponseTimeMs: stored normally, both timers cleared', async () => {
    const live: Array<{ ms: number; t: { _destroyed?: boolean } }> = [];
    const realSet = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void, ms?: number, ...a: unknown[]) => {
      const t = (realSet as (...x: unknown[]) => unknown)(fn, ms, ...a);
      if (ms === 700 || ms === 600) live.push({ ms, t: t as { _destroyed?: boolean } });
      return t;
    }) as typeof setTimeout;
    let seenDestroyed: boolean[] = [];
    try {
      const hook: RenderHook = async () => {
        seenDestroyed = live.map((x) => x.t._destroyed === true);
        await new Promise((r) => realSet(r, 900));
        return { ok: true, html: RENDERED, timingMs: 900, scriptRan: true };
      };
      const { c, db } = makeCrawler(hook, { requestTimeoutMs: 700, maxResponseTimeMs: 600 });
      await c.start();
      const row = rowOf(db, '/');
      expect(row.statusCode).toBe(200);
      expect(row.title).toBe('Rendered');
      // Both timers (700 and 600 ms) exist and were cleared by the time the render ran.
      expect(live.length).toBeGreaterThanOrEqual(2);
      expect(seenDestroyed.every(Boolean)).toBe(true);
    } finally {
      globalThis.setTimeout = realSet;
    }
  });

  it('without a page script the timers keep running (today)', async () => {
    const hook: RenderHook = async () => {
      await new Promise((r) => setTimeout(r, 900));
      return { ok: true, html: RENDERED, timingMs: 900 };
    };
    const { c, db } = makeCrawler(hook, { requestTimeoutMs: 400, maxResponseTimeMs: 0 }, '');
    await c.start();
    const row = rowOf(db, '/');
    // Aborted by the fetch timer: stored as a network error, not as the rendered page.
    expect(row.title).not.toBe('Rendered');
  });
});

describe('whitespace-only page script is no script (B34)', () => {
  it('renderOptionsFromConfig passes no script', () => {
    const cfg = { ...DEFAULT_CRAWL_CONFIG, jsRender: { ...DEFAULT_CRAWL_CONFIG.jsRender, pageScript: ' \n ' } };
    expect(renderOptionsFromConfig(cfg).pageScript).toBeUndefined();
  });

  it('the fetch timer keeps running and nothing is warned about a script', async () => {
    const hook: RenderHook = async () => {
      await new Promise((r) => setTimeout(r, 900));
      return { ok: true, html: RENDERED, timingMs: 900 };
    };
    const { c, db, warns } = makeCrawler(hook, { requestTimeoutMs: 400, maxResponseTimeMs: 0 }, '  \n\t ');
    await c.start();
    expect(rowOf(db, '/').title).not.toBe('Rendered');
    expect(warns.filter((m) => m.includes('page script'))).toHaveLength(0);
  });
});

describe('failed render with a page script', () => {
  it.each(['render time limit exceeded', 'script blocked the page'])(
    '"%s": the page is stored from the served HTML, not as no-response',
    async (error) => {
      const { c, db } = makeCrawler(async () => ({ ok: false, html: '', timingMs: 5, error }));
      await c.start();
      const row = rowOf(db, '/');
      expect(row.statusCode).toBe(200);
      expect(row.title).toBe('Served');
      expect(row.outlinks).toBeGreaterThanOrEqual(1);
    },
  );

  it('limit and watchdog failures are warned once per crawl, not once per page', async () => {
    const { c, warns } = makeCrawler(async () => ({
      ok: false,
      html: '',
      timingMs: 5,
      error: 'render time limit exceeded',
    }));
    await c.start();
    expect(warns.filter((m) => m.includes('render time limit exceeded'))).toHaveLength(1);
  });

  it('Stop aborts a slow render at once', async () => {
    let started!: () => void;
    const hookStarted = new Promise<void>((r) => (started = r));
    const hook: RenderHook = (_u, _id, signal) =>
      new Promise((_res, rej) => {
        started();
        signal.addEventListener('abort', () => rej(new Error('aborted')));
      });
    const { c } = makeCrawler(hook, { requestTimeoutMs: 20_000 });
    const done = c.start();
    await hookStarted;
    const t0 = Date.now();
    c.stop();
    await done;
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});
