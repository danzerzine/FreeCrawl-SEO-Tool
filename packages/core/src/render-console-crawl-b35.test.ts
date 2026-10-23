import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONSOLE_CHECKS, LATER_CHECKS, MARKUP_CHECKS, ProjectDb, RENDER_CHECKS } from '@freecrawl/db';
import { DEFAULT_CRAWL_CONFIG, type CrawlConfig } from '@freecrawl/shared-types';
import { compareCrawls } from './compare.js';
import { Crawler } from './crawler.js';
import { fakeRender } from './fake-render.test-support.js';
import type { RenderHook } from './render-config.js';

// B35: console errors and failed resources through a Crawler run with the fake render hook.
const HTML = '<html><head><title>T</title></head><body><h1>H</h1></body></html>';
let server: Server;
let dir: string;
let base: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fc-m11-b35-'));
  server = createServer((_req, res) => void res.writeHead(200, { 'content-type': 'text/html' }).end(HTML));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
});
afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

const LOG = {
  errors: 2,
  failed: 1,
  entries: [
    { kind: 'console' as const, text: 'x' },
    { kind: 'pageerror' as const, text: 'boom' },
    { kind: 'http' as const, url: 'http://a/b.js', type: 'script', status: 404 },
  ],
};
const hookWith = (consoleLog?: typeof LOG | { errors: number; failed: number; entries: [] }) =>
  fakeRender({ [base]: HTML }, { consoleLog });

let n = 0;
async function crawl(
  hook: RenderHook | undefined,
  o: { mode?: CrawlConfig['renderingMode']; consoleErrors?: boolean; db?: ProjectDb } = {},
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
      jsRender: { ...DEFAULT_CRAWL_CONFIG.jsRender, consoleErrors: o.consoleErrors ?? true },
    },
    db,
    { renderUrl: hook },
  );
  c.on('error', () => {});
  await c.start();
  const row = db.getUrlById(db.getUrlIdByUrl(base)!)!;
  return { db, row, cols: [row.consoleErrors, row.failedResources, row.consoleLog] };
}
const listed = (db: ProjectDb, k: string) =>
  db.queryUrls({ limit: 10, offset: 0, category: `issues:${k}` as never }).rows.length;

describe('crawl with the fake render hook: console columns and issues', () => {
  it('option on: the counts and the capped JSON are stored and both issues list the page', async () => {
    const r = await crawl(hookWith(LOG));
    expect(r.cols).toEqual([2, 1, JSON.stringify(LOG.entries)]);
    expect(listed(r.db, 'console-errors')).toBe(1);
    expect(listed(r.db, 'failed-resources')).toBe(1);
  });

  it('a clean page stores 0 and 0 with no JSON', async () => {
    const r = await crawl(hookWith({ errors: 0, failed: 0, entries: [] }));
    expect(r.cols).toEqual([0, 0, null]);
    expect(listed(r.db, 'console-errors')).toBe(0);
  });

  it('option off: nothing stored even if the hook returns a log', async () => {
    const r = await crawl(hookWith(LOG), { consoleErrors: false });
    expect(r.cols).toEqual([null, null, null]);
  });

  it('failed render and text mode store NULL', async () => {
    const failed = await crawl(fakeRender({}, { consoleLog: LOG }));
    expect(failed.cols).toEqual([null, null, null]);
    const text = await crawl(undefined, { mode: 'text' });
    expect(text.cols).toEqual([null, null, null]);
  });

  it('refresh with the option off overwrites the counts with NULL and the issues stop listing the page (B6)', async () => {
    const first = await crawl(hookWith(LOG));
    expect(listed(first.db, 'console-errors')).toBe(1);
    const again = await crawl(hookWith(LOG), { consoleErrors: false, db: first.db });
    expect(again.cols).toEqual([null, null, null]);
    expect(listed(again.db, 'console-errors')).toBe(0);
    expect(listed(again.db, 'failed-resources')).toBe(0);
  });
});

describe('checks filled and compare (B1)', () => {
  const ids = CONSOLE_CHECKS as readonly string[];
  const filled = (db: ProjectDb) => ids.map((k) => db.checksFilled().has(k as never));

  it('only rendering with a hook AND the option on fills the two ids', async () => {
    const on = await crawl(hookWith(LOG));
    expect(filled(on.db)).toEqual([true, true]);
    const off = await crawl(hookWith(LOG), { consoleErrors: false });
    const text = await crawl(undefined, { mode: 'text' });
    const noHook = await crawl(undefined, { mode: 'js' });
    for (const r of [off, text, noHook]) {
      expect(filled(r.db)).toEqual([false, false]);
      // Everything else a crawl fills is still filled (the render checks only with a hook).
      const rest = LATER_CHECKS.filter((k) => !ids.includes(k) && !(RENDER_CHECKS as readonly string[]).includes(k) && !(MARKUP_CHECKS as readonly string[]).includes(k));
      expect(rest.every((k) => r.db.checksFilled().has(k))).toBe(true);
    }
  }, 30_000);

  it('compare lists a fixed console error between two recorded crawls and "not checked" against the others', async () => {
    const a = await crawl(hookWith(LOG));
    const b = await crawl(hookWith({ errors: 0, failed: 0, entries: [] }));
    const off = await crawl(hookWith(LOG), { consoleErrors: false });
    const text = await crawl(undefined, { mode: 'text' });
    expect(Object.keys(compareCrawls(a.db, b.db).issueChanges)).toContain('issues:console-errors');
    for (const other of [off, text]) {
      const keys = Object.keys(compareCrawls(a.db, other.db).issueChanges);
      for (const k of ids) expect(keys).not.toContain(k);
    }
  }, 30_000);
});
