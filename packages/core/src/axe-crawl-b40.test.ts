import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { DEFAULT_CRAWL_CONFIG, type AxeAudit, type CrawlConfig } from '@freecrawl/shared-types';
import { Crawler } from './crawler.js';
import { fakeRender } from './fake-render.test-support.js';
import type { RenderHook } from './render-config.js';

// B40 R2, R6a, R8, R9, R15 through a Crawler run with the fake render hook (it bypasses renderUrl,
// so the 2xx guard is tested in render-axe-guard-b40.test.ts and in the Chromium test).
const HTML = '<html><head><title>T</title></head><body><h1>H</h1></body></html>';
let server: Server;
let dir: string;
let base: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fc-b40c-'));
  server = createServer((_req, res) => void res.writeHead(200, { 'content-type': 'text/html' }).end(HTML));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
});
afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

const rule = (id: string, impact: string | null) => ({
  id, impact, help: `help ${id}`, helpUrl: `https://x/${id}`, tags: ['wcag2a'], nodes: 3,
  samples: [{ target: '#a', html: '<img>', summary: 's' }],
});
const AUDIT: AxeAudit = {
  version: '4.14.0',
  violations: [rule('image-alt', 'critical'), rule('region', 'moderate')],
  incomplete: [rule('aria-hidden-focus', null)],
  violationsTotal: 2,
  seriousTotal: 1,
};

let n = 0;
async function crawl(
  hook: RenderHook | undefined,
  o: { mode?: CrawlConfig['renderingMode']; axe?: boolean; db?: ProjectDb; requestTimeoutMs?: number } = {},
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
      ...(o.requestTimeoutMs ? { requestTimeoutMs: o.requestTimeoutMs } : {}),
      jsRender: { ...DEFAULT_CRAWL_CONFIG.jsRender, axeAudit: o.axe ?? true },
    },
    db,
    { renderUrl: hook },
  );
  const log: { level: string; msg: string }[] = [];
  c.on('error', () => {});
  c.on('warn', (m: string) => log.push({ level: 'warn', msg: m }));
  c.on('info', (m: string) => log.push({ level: 'info', msg: m }));
  await c.start();
  const row = db.getUrlById(db.getUrlIdByUrl(base)!)!;
  return { db, row, log, axeCols: [row.axeViolations, row.axeSerious, row.axeIncomplete, row.axeVersion] };
}
const hook = (over: Parameters<typeof fakeRender>[1]) => fakeRender({ [base]: HTML }, over);
const rules = (db: ProjectDb) => db.queryAxe({ url: base, limit: 50, offset: 0 }).rows.map((r) => `${r.kind}:${r.ruleId}`).sort();

describe('crawl with the fake render hook: axe columns, rows and issues', () => {
  it('stores the counts and one row per rule, and the issue filters list the page', async () => {
    const r = await crawl(hook({ axe: AUDIT, axeMs: 40 }));
    expect(r.axeCols).toEqual([2, 1, 1, '4.14.0']);
    expect(rules(r.db)).toEqual(['incomplete:aria-hidden-focus', 'violation:image-alt', 'violation:region']);
    const list = (k: string) => r.db.queryUrls({ limit: 10, offset: 0, category: `issues:${k}` as never }).rows.length;
    expect(list('axe-critical-serious')).toBe(1);
    expect(list('axe-moderate-minor')).toBe(1);
    expect(list('axe-needs-review')).toBe(1);
  });

  it('a hook with no axe result leaves the page not audited (NULL, no rows)', async () => {
    const r = await crawl(hook({}));
    expect(r.axeCols).toEqual([null, null, null, null]);
    expect(rules(r.db)).toEqual([]);
  });

  it('a re-crawl replaces the rows of the page', async () => {
    const first = await crawl(hook({ axe: AUDIT, axeMs: 1 }));
    const second = await crawl(hook({ axe: { ...AUDIT, violations: [rule('button-name', 'serious')], incomplete: [], violationsTotal: 1, seriousTotal: 1 }, axeMs: 1 }), { db: first.db });
    expect(rules(second.db)).toEqual(['violation:button-name']);
    expect(second.axeCols).toEqual([1, 1, 0, '4.14.0']);
  });

  it('R8: a re-crawl with axe on where axe gives nothing clears the old result', async () => {
    const first = await crawl(hook({ axe: AUDIT, axeMs: 1 }));
    expect(first.axeCols[0]).toBe(2);
    const second = await crawl(hook({ axe: null, axeMs: 5 }), { db: first.db });
    expect(second.axeCols).toEqual([null, null, null, null]);
    expect(rules(second.db)).toEqual([]);
  });

  it('R8: a failed render of the page also clears it (the stored DOM is the static one now)', async () => {
    const first = await crawl(hook({ axe: AUDIT, axeMs: 1 }));
    const second = await crawl(fakeRender({}), { db: first.db });
    expect(second.axeCols).toEqual([null, null, null, null]);
  });

  it('R8: with axeAudit off the crawl does not touch the old result, even if a hook returned one', async () => {
    const first = await crawl(hook({ axe: AUDIT, axeMs: 1 }));
    const second = await crawl(hook({ axe: { ...AUDIT, version: '9.9.9', violations: [], violationsTotal: 0, seriousTotal: 0 } }), { db: first.db, axe: false });
    expect(second.axeCols).toEqual([2, 1, 1, '4.14.0']);
    expect(rules(second.db)).toEqual(['incomplete:aria-hidden-focus', 'violation:image-alt', 'violation:region']);
  });

  it('with axeAudit off a first crawl audits nothing', async () => {
    const r = await crawl(hook({ axe: AUDIT }), { axe: false });
    expect(r.axeCols).toEqual([null, null, null, null]);
  });

  it('text mode never audits and never clears', async () => {
    const first = await crawl(hook({ axe: AUDIT, axeMs: 1 }));
    const second = await crawl(undefined, { db: first.db, mode: 'text' });
    expect(second.axeCols).toEqual([2, 1, 1, '4.14.0']);
  });
});

describe('R15: the cost line and the failure warning', () => {
  it('says how many pages were audited, the average time and how many failed', async () => {
    const r = await crawl(hook({ axe: AUDIT, axeMs: 40 }));
    expect(r.log.some((l) => l.level === 'info' && l.msg === 'axe-core: 1 pages, avg 40 ms, 0 failed')).toBe(true);
  });

  it('a page where axe did not finish is counted, with one warning that names the page', async () => {
    const r = await crawl(hook({ axe: null, axeMs: 10_000 }));
    expect(r.log.filter((l) => l.level === 'warn' && /axe-core did not finish/.test(l.msg))).toHaveLength(1);
    expect(r.log.some((l) => l.level === 'info' && l.msg === 'axe-core: 0 pages, avg 0 ms, 1 failed')).toBe(true);
  });

  it('no line when axe was off', async () => {
    const r = await crawl(hook({ axe: AUDIT, axeMs: 40 }), { axe: false });
    expect(r.log.some((l) => /axe-core/.test(l.msg))).toBe(false);
  });
});

describe('R6a: the fetch timer must not run through render and axe', () => {
  const slow: RenderHook = async () => {
    await new Promise((r) => setTimeout(r, 900));
    return { ok: true, html: HTML, timingMs: 900, axe: AUDIT, axeMs: 800 };
  };
  it('with axe on, a render that outlives requestTimeoutMs still stores the page with its status and axe', async () => {
    const r = await crawl(slow, { requestTimeoutMs: 300 });
    expect(r.row.statusCode).toBe(200);
    expect(r.axeCols[0]).toBe(2);
  });
  it('control: with axe off the same slow render is cut by the fetch timer (the old behaviour)', async () => {
    const r = await crawl(slow, { requestTimeoutMs: 300, axe: false });
    expect(r.row.statusCode).not.toBe(200);
  });
});
