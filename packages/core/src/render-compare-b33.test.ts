import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LATER_CHECKS, ProjectDb, RENDER_CHECKS } from '@freecrawl/db';
import { DEFAULT_CRAWL_CONFIG, type CrawlConfig } from '@freecrawl/shared-types';
import { compareCrawls } from './compare.js';
import { Crawler } from './crawler.js';
import { fakeRender } from './fake-render.test-support.js';
import { readServedSignalsInline, type ReadServedSignalsFn } from './html-parser.js';
import { ParserTimeoutError } from './parse-pool.js';
import type { RenderHook } from './render-config.js';

// B33: raw page against rendered page, through a Crawler run with the fake render hook.
const pages: Record<string, string> = {};
let server: Server;
let dir: string;
let base: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fc-m11-b33-'));
  server = createServer((req, res) => {
    const html = pages[req.url ?? '/'];
    if (html === undefined) return void res.writeHead(404).end('nope');
    res.writeHead(200, { 'content-type': 'text/html' }).end(html);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

const page = (body: string, head = '') => `<html><head><title>T</title>${head}</head><body>${body}</body></html>`;
let n = 0;
async function crawl(
  path: string,
  served: string,
  hook: RenderHook | undefined,
  extra: { mode?: CrawlConfig['renderingMode']; readServedSignals?: ReadServedSignalsFn; db?: ProjectDb } = {},
) {
  pages[path] = served;
  const db = extra.db ?? new ProjectDb(join(dir, `p${n++}.seoproject`));
  const url = base + path;
  const c = new Crawler(
    {
      ...DEFAULT_CRAWL_CONFIG,
      startUrl: url,
      renderingMode: extra.mode ?? 'js',
      maxConcurrency: 1,
      discoverSitemaps: false,
      checkExternalLinks: false,
      probeTlsCerts: false,
      probeManifestJson: false,
      probeSocialImages: false,
      probeImageSizes: false,
      jsRender: { ...DEFAULT_CRAWL_CONFIG.jsRender },
    },
    db,
    { renderUrl: hook, readServedSignals: extra.readServedSignals },
  );
  const warns: string[] = [];
  c.on('warn', (m) => warns.push(String(m)));
  c.on('error', () => {});
  await c.start();
  const row = db.getUrlById(db.getUrlIdByUrl(url)!)!;
  const verdicts = [row.jsH1Changed, row.jsCanonicalChanged, row.jsLinksChanged, row.jsTextChanged];
  return { row, verdicts, warns, url, db };
}
const NULLS = [null, null, null, null];

describe('crawl with the fake render hook: the four verdicts', () => {
  it('H1 changed by JS: verdict 1 and the detail carries both texts', async () => {
    const url = base + '/h1';
    const r = await crawl('/h1', page('<h1>Old</h1>'), fakeRender({ [url]: page('<h1>New</h1>') }));
    expect(r.verdicts).toEqual([1, 0, 0, 0]);
    const d = JSON.parse(r.row.renderDiff!);
    expect(d.h1).toEqual({ served: 'Old', rendered: 'New' });
  });

  it('equal pages: all 0 and no detail', async () => {
    const url = base + '/eq';
    const html = page('<h1>Same</h1><a href="/x">x</a>', '<link rel="canonical" href="/eq">');
    const r = await crawl('/eq', html, fakeRender({ [url]: html }));
    expect(r.verdicts).toEqual([0, 0, 0, 0]);
    expect(r.row.renderDiff).toBeNull();
  });

  it('canonical, links and text changed by JS', async () => {
    const url = base + '/all';
    const served = page('<h1>H</h1><a href="/one">1</a>' + 'w '.repeat(100), '<link rel="canonical" href="/a">');
    const rendered = page(
      '<h1>H</h1><a href="/one">1</a><a href="/two">2</a>' + 'w '.repeat(200),
      '<link rel="canonical" href="/b">',
    );
    const r = await crawl('/all', served, fakeRender({ [url]: rendered }));
    expect(r.verdicts).toEqual([0, 1, 1, 1]);
    const d = JSON.parse(r.row.renderDiff!);
    expect(d.links.addedTargets).toEqual([base + '/two']);
  });

  it('a failed render leaves all four NULL', async () => {
    const r = await crawl('/failed', page('<h1>A</h1>'), fakeRender({}));
    expect(r.verdicts).toEqual(NULLS);
    expect(r.row.renderDiff).toBeNull();
  });

  it('text mode leaves all four NULL', async () => {
    const r = await crawl('/text', page('<h1>A</h1>'), undefined, { mode: 'text' });
    expect(r.verdicts).toEqual(NULLS);
  });
});

describe('served side (step 0b)', () => {
  it('uses the browser own response (servedHtml) when it is given and differs from the crawler body', async () => {
    const url = base + '/sv';
    // The crawler body says Rotating; the browser's own response said Stable like the rendered DOM.
    const r = await crawl(
      '/sv',
      page('<h1>Rotating</h1>'),
      fakeRender({ [url]: page('<h1>Stable</h1>') }, { servedHtml: page('<h1>Stable</h1>') }),
    );
    expect(r.verdicts[0]).toBe(0);
  });

  it('falls back to the crawler body when servedHtml is absent', async () => {
    const url = base + '/sv2';
    const r = await crawl('/sv2', page('<h1>Rotating</h1>'), fakeRender({ [url]: page('<h1>Stable</h1>') }));
    expect(r.verdicts[0]).toBe(1);
  });

  it('a servedHtml over 5 M characters is dropped and the body is used', async () => {
    const url = base + '/sv3';
    const huge = page('<h1>Stable</h1>' + 'x'.repeat(5 * 1024 * 1024 + 1));
    const r = await crawl('/sv3', page('<h1>Rotating</h1>'), fakeRender({ [url]: page('<h1>Stable</h1>') }, { servedHtml: huge }));
    expect(r.verdicts[0]).toBe(1);
  });
});

describe('the separate served-signals request (step 3)', () => {
  it('a rejecting request leaves the verdicts NULL and writes the page normally', async () => {
    const url = base + '/rej';
    const r = await crawl('/rej', page('<h1>Old</h1>'), fakeRender({ [url]: page('<h1>New</h1>') }), {
      readServedSignals: () => Promise.reject(new Error('worker crashed')),
    });
    expect(r.verdicts).toEqual(NULLS);
    expect(r.row.renderDiff).toBeNull();
    expect(r.row.statusCode).toBe(200);
    expect(r.row.h1).toBe('New');
  });

  it('a ParserTimeoutError does the same and does not fail the URL', async () => {
    const url = base + '/to';
    const r = await crawl('/to', page('<h1>Old</h1>'), fakeRender({ [url]: page('<h1>New</h1>') }), {
      readServedSignals: () => Promise.reject(new ParserTimeoutError(60_000)),
    });
    expect(r.verdicts).toEqual(NULLS);
    expect(r.row.statusCode).toBe(200);
    expect(r.row.indexability).toBe('indexable');
  });

  it('with no pool wired the verdicts are computed inline', async () => {
    const url = base + '/inline';
    const r = await crawl('/inline', page('<h1>Old</h1>'), fakeRender({ [url]: page('<h1>New</h1>') }));
    expect(r.verdicts[0]).toBe(1);
  });

  it('a page script run: the pre-script HTML is read in the same request and decides', async () => {
    const url = base + '/ps';
    const served = page('<h1>Old</h1>');
    const seen: { servedHtml: string; preScriptHtml?: string }[] = [];
    const r = await crawl(
      '/ps',
      served,
      // Post-script DOM has five extra links; the pre-script HTML equals the served page.
      fakeRender(
        { [url]: page('<h1>Old</h1>' + [1, 2, 3, 4, 5].map((i) => `<a href="/l${i}">x</a>`).join('')) },
        { scriptRan: true, renderedHtmlPreScript: served },
      ),
      {
        readServedSignals: async (req, pageUrl, opts) => {
          seen.push(req);
          return readServedSignalsInline(req, pageUrl, opts);
        },
      },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]!.preScriptHtml).toBe(served);
    expect(r.verdicts).toEqual([0, 0, 0, 0]);
    // The stored rendered DOM is the post-script one (the five links are in the link graph).
    expect(r.db.getUrlById(r.row.id)!.outlinks).toBeGreaterThanOrEqual(5);
  });

  it('a page script run without the pre-script snapshot: NULL verdicts and a skipped note', async () => {
    const url = base + '/ps2';
    const r = await crawl('/ps2', page('<h1>Old</h1>'), fakeRender({ [url]: page('<h1>New</h1>') }, { scriptRan: true }));
    expect(r.verdicts).toEqual(NULLS);
    expect(JSON.parse(r.row.renderDiff!)).toEqual({ skipped: 'page script' });
  });

  it('a pre-script snapshot over 5 M characters: NULL verdicts and "too large"', async () => {
    const url = base + '/ps3';
    const r = await crawl(
      '/ps3',
      page('<h1>Old</h1>'),
      fakeRender(
        { [url]: page('<h1>New</h1>') },
        { scriptRan: true, renderedHtmlPreScript: page('x'.repeat(5 * 1024 * 1024 + 1)) },
      ),
    );
    expect(r.verdicts).toEqual(NULLS);
    expect(JSON.parse(r.row.renderDiff!)).toEqual({ skipped: 'too large' });
  });
});

describe('checks filled and compare (B1)', () => {
  const issueKeys = RENDER_CHECKS as readonly string[];
  const renderedProject = async (name: string, h1: string) => {
    const db = new ProjectDb(join(dir, `${name}.seoproject`));
    const path = `/${name}`;
    const html = page('<h1>Old</h1>');
    const url = base + path;
    await crawl(path, html, fakeRender({ [url]: page(`<h1>${h1}</h1>`) }), { db });
    return db;
  };

  it('a rendered crawl with a hook fills the four checks; text mode and js without a hook do not', async () => {
    const a = await renderedProject('fa', 'New');
    expect(issueKeys.every((k) => a.checksFilled().has(k))).toBe(true);
    const t = new ProjectDb(join(dir, 'ft.seoproject'));
    await crawl('/ft', page('<h1>x</h1>'), undefined, { mode: 'text', db: t });
    const j = new ProjectDb(join(dir, 'fj.seoproject'));
    await crawl('/fj', page('<h1>x</h1>'), undefined, { mode: 'js', db: j });
    for (const db of [t, j]) {
      expect(issueKeys.some((k) => db.checksFilled().has(k))).toBe(false);
      // Everything else is still filled.
      expect(LATER_CHECKS.filter((k) => !issueKeys.includes(k)).every((k) => db.checksFilled().has(k))).toBe(true);
    }
    for (const db of [a, t, j]) db.close();
  }, 30_000);

  it('compare reports a fixed H1 between two rendered crawls, and nothing (not checked) against a text-mode crawl', async () => {
    // The same page in three projects: A rendered with the H1 changed by JS, B rendered and equal, C text mode.
    const url = base + '/cmp';
    const served = page('<h1>Old</h1>');
    const a = new ProjectDb(join(dir, 'ca.seoproject'));
    await crawl('/cmp', served, fakeRender({ [url]: page('<h1>New</h1>') }), { db: a });
    const b = new ProjectDb(join(dir, 'cb.seoproject'));
    await crawl('/cmp', served, fakeRender({ [url]: served }), { db: b });
    const c = new ProjectDb(join(dir, 'cc.seoproject'));
    await crawl('/cmp', served, undefined, { mode: 'text', db: c });
    const fixed = compareCrawls(a, b).issueChanges;
    expect(fixed['issues:h1-changed-by-js']).toBeDefined();
    const notChecked = compareCrawls(a, c).issueChanges;
    for (const k of issueKeys) expect(Object.keys(notChecked)).not.toContain(k);
    for (const db of [a, b, c]) db.close();
  }, 30_000);
});
