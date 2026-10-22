import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { GoogleAuthError, GooglePermissionError, GoogleQuotaError } from './google-retry.js';
import { planInspection, runGscInspection } from './gsc-inspect-run.js';
import type { GscInspectionRaw } from './gsc.js';

const NOW = Date.parse('2026-10-22T12:00:00Z');
const HOUR = 3_600_000;
const u = (n: number) => `https://ex.test/p${n}`;

let dir: string;
let db: ProjectDb;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b38run-'));
  db = new ProjectDb(path.join(dir, 'p.seoproject'));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const raw = (over: Partial<GscInspectionRaw> = {}): GscInspectionRaw => ({
  verdict: 'PASS',
  coverageState: 'Indexed',
  robotsTxtState: null,
  indexingState: null,
  lastCrawlTime: null,
  googleCanonical: null,
  userCanonical: null,
  mobileVerdict: null,
  ampVerdict: null,
  richResultsVerdict: null,
  pageFetchState: 'SUCCESSFUL',
  crawledAs: 'MOBILE',
  sitemaps: ['https://ex.test/s.xml'],
  referringUrls: [],
  referringCount: 0,
  richResults: null,
  ...over,
});

/** A stored row: `ageH` hours old, with or without the B38 sitemap data. */
function seed(url: string, account: string, opts: { ageH?: number; status?: 'ok' | 'error'; b38?: boolean }) {
  db.upsertGscInspection(
    url,
    {
      ...raw(),
      sitemaps: opts.b38 === false ? null : ['s'],
      referringUrls: opts.b38 === false ? null : [],
      referringCount: opts.b38 === false ? null : 0,
      status: opts.status ?? 'ok',
      error: null,
      fetchedAt: new Date(NOW - (opts.ageH ?? 1) * HOUR).toISOString(),
    },
    account,
  );
}

function harness(script: (url: string, call: number) => GscInspectionRaw | Error) {
  const seen: string[] = [];
  const progress: number[] = [];
  const inspect = async (_p: string, url: string): Promise<GscInspectionRaw> => {
    seen.push(url);
    const r = script(url, seen.length);
    if (r instanceof Error) throw r;
    return r;
  };
  const run = (urls: string[], over: { force?: boolean; accountId?: string; cancelAfter?: number } = {}) =>
    runGscInspection(
      { property: 'sc-domain:ex.test', urls, accountId: over.accountId ?? 'acc1', force: over.force },
      {
        inspect,
        db,
        now: () => NOW,
        isCancelled: () => over.cancelAfter !== undefined && seen.length >= over.cancelAfter,
        onProgress: (p) => progress.push(p.done),
      },
    );
  return { seen, progress, run };
}

describe('B38 runner: skipping fresh rows', () => {
  it('skips an ok row of the same account with sitemap data under 24 h; inspects the rest', async () => {
    seed(u(1), 'acc1', { ageH: 2 }); // fresh -> skipped
    seed(u(2), 'acc2', { ageH: 2 }); // other account -> inspected
    seed(u(3), 'acc1', { ageH: 2, b38: false }); // old NULL row -> re-inspected once
    seed(u(4), 'acc1', { ageH: 30 }); // older than 24 h
    seed(u(5), 'acc1', { ageH: 1, status: 'error' }); // error row -> retried
    const h = harness(() => raw());
    const res = await h.run([u(1), u(2), u(3), u(4), u(5), u(6)]);
    expect(h.seen).toEqual([u(2), u(3), u(4), u(5), u(6)]);
    expect(res).toMatchObject({ inspected: 5, skipped: 1, remaining: 0, quotaExhausted: false });
  });

  it('force re-inspects every URL', async () => {
    seed(u(1), 'acc1', { ageH: 2 });
    const h = harness(() => raw());
    const res = await h.run([u(1), u(2)], { force: true });
    expect(h.seen).toEqual([u(1), u(2)]);
    expect(res.skipped).toBe(0);
  });

  it('the plan the confirm dialog shows is the same split the runner makes', () => {
    seed(u(1), 'acc1', { ageH: 2 });
    seed(u(2), 'acc1', { ageH: 2, b38: false });
    const plan = planInspection(db, [u(1), u(2), u(3)], 'acc1', false, NOW);
    expect(plan).toEqual({ toInspect: [u(2), u(3)], skipped: [u(1)] });
    expect(planInspection(db, [u(1), u(2)], 'acc1', true, NOW)).toEqual({ toInspect: [u(1), u(2)], skipped: [] });
  });
});

describe('B38 runner: stopping', () => {
  it('a quota error at URL 3 of 5 stops with two rows stored and remaining 3', async () => {
    const h = harness((_u, n) => (n === 3 ? new GoogleQuotaError('URL Inspection', 'HTTP 429') : raw()));
    const res = await h.run([u(1), u(2), u(3), u(4), u(5)]);
    expect(h.seen).toEqual([u(1), u(2), u(3)]);
    expect(res).toMatchObject({ inspected: 2, remaining: 3, quotaExhausted: true, failed: 0 });
    const states = db.gscInspectionStates([u(1), u(2), u(3), u(4), u(5)], 'acc1');
    expect([...states.keys()].sort()).toEqual([u(1), u(2)]);
  });

  it.each([
    ['auth', new GoogleAuthError('URL Inspection')],
    ['403 PERMISSION_DENIED', new GooglePermissionError('URL Inspection', 'no access')],
  ])('%s error stops the run with a message and no error rows', async (_name, err) => {
    const h = harness((_u, n) => (n === 2 ? err : raw()));
    const res = await h.run([u(1), u(2), u(3)]);
    expect(h.seen).toEqual([u(1), u(2)]);
    expect(res).toMatchObject({ inspected: 1, remaining: 2, quotaExhausted: false });
    expect(res.stopMessage).toContain('URL Inspection');
    const states = db.gscInspectionStates([u(1), u(2), u(3)], 'acc1');
    expect([...states.keys()]).toEqual([u(1)]);
  });

  it('a plain error is stored as an error row with the five new columns NULL and the run goes on', async () => {
    const h = harness((url) => (url === u(2) ? new Error('Search Console API error (HTTP 500)') : raw()));
    const res = await h.run([u(1), u(2), u(3)]);
    expect(h.seen).toHaveLength(3);
    expect(res).toMatchObject({ inspected: 3, completed: 2, failed: 1, remaining: 0 });
    const st = db.gscInspectionStates([u(2)], 'acc1').get(u(2))!;
    expect(st.status).toBe('error');
    expect(st.sitemapsStored).toBe(false);
  });

  it('cancel stops after the current URL; remaining counts what was not reached', async () => {
    const h = harness(() => raw());
    const res = await h.run([u(1), u(2), u(3)], { cancelAfter: 1 });
    expect(res).toMatchObject({ inspected: 1, remaining: 2, cancelled: true });
  });

  it('reports progress after every URL', async () => {
    const h = harness(() => raw());
    await h.run([u(1), u(2)]);
    expect(h.progress.at(-1)).toBe(2);
  });
});
