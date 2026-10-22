import { describe, expect, it, vi } from 'vitest';
import type { ProjectDb } from '@freecrawl/db';
import { googleRequest, type GoogleDeps } from './google-retry.js';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  safeStorage: {},
}));

const { exportCategoryToSheets } = await import('./sheets-export.js');
const { exportCategoryToBigQuery } = await import('./bigquery-export.js');

// M10 review round 1 (std M5): a 401 that survives one forced token refresh
// is an auth error ("reconnect the Google account"), not a network error,
// and is never retried.
const RECONNECT = /reconnect (the|your) Google account/i;

function deps(
  fetchFn: (url: string, init: RequestInit) => Response | 'network',
  opts: { refreshThrows?: boolean; clockStep?: number } = {},
) {
  const sleeps: number[] = [];
  const urls: string[] = [];
  let clock = 0;
  const d: GoogleDeps = {
    fetch: (async (url: string, init: RequestInit) => {
      urls.push(`${init.method} ${url}`);
      clock += opts.clockStep ?? 0;
      const r = fetchFn(url, init);
      if (r === 'network') throw new Error('connect failed');
      return r;
    }) as unknown as GoogleDeps['fetch'],
    getToken: async (refresh) => {
      if (refresh && opts.refreshThrows) throw new Error('invalid_grant: Token has been revoked');
      return refresh ? 'fresh' : 'old';
    },
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    random: () => 0,
    log: () => {},
  };
  return { d, sleeps, urls };
}
const json = (status: number, body: unknown = {}): Response => new Response(JSON.stringify(body), { status });
const req = { op: 'test op', method: 'GET', url: 'https://x.test/a' };

describe('googleRequest auth errors', () => {
  it('a 401 after the refresh throws an auth error that says to reconnect, with no further retry', async () => {
    const t = deps(() => json(401));
    const err = (await googleRequest(t.d, req).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(RECONNECT);
    expect(err.message).not.toMatch(/network/i);
    expect(t.urls).toHaveLength(2);
    expect(t.sleeps).toEqual([]);
  });

  it('a token refresh that fails (revoked grant, deleted key) is the same auth error, not a retried network error', async () => {
    const t = deps(() => json(401), { refreshThrows: true });
    const err = (await googleRequest(t.d, req).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(RECONNECT);
    expect(err.message).not.toMatch(/network/i);
    expect(t.urls).toHaveLength(1);
    expect(t.sleeps).toEqual([]);
  });

  it('time spent in the requests themselves counts toward the 180 s cap', async () => {
    // Every attempt "hangs" 100 s and fails: the cap is hit after two attempts, not eight.
    const t = deps(() => 'network', { clockStep: 100_000 });
    const err = (await googleRequest(t.d, req).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/network error after waiting/);
    expect(t.urls.length).toBeLessThanOrEqual(3);
  });
});

const fakeDb = (n: number): ProjectDb =>
  ({
    iterateUrlsByCategory: () =>
      (function* () {
        for (let i = 1; i <= n; i++) {
          yield { id: i, url: `https://x.test/${i}`, statusCode: 200, title: `T${i}`, metaDescription: '', h1: '', indexability: 'indexable', responseTimeMs: 1, depth: 1, inlinks: 1, outlinks: 1, wordCount: 1 };
        }
      })(),
  }) as unknown as ProjectDb;

describe('Sheets and BigQuery exports on a revoked Google sign-in', () => {
  it('Sheets create: reconnect message, no "check Drive" hint, one create attempt pair', async () => {
    const t = deps(() => json(401));
    const err = (await exportCategoryToSheets(fakeDb(3), 'all' as never, 'T', { deps: t.d }).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(RECONNECT);
    expect(err.message).not.toMatch(/check Drive/i);
    expect(t.sleeps).toEqual([]);
  });

  it('Sheets write: the batch fails once with the reconnect message; the renamed-partial note still points at the sheet', async () => {
    const t = deps((url, init) => {
      if (url.endsWith('/v4/spreadsheets')) {
        return json(200, { spreadsheetId: 'S1', spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/S1', sheets: [{ properties: { sheetId: 7 } }] });
      }
      if (init.method === 'PUT') return json(401);
      return json(200);
    });
    const err = (await exportCategoryToSheets(fakeDb(3), 'all' as never, 'T', { deps: t.d }).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(RECONNECT);
    expect(err.message).toContain('spreadsheets/d/S1');
    expect(t.urls.filter((u) => u.startsWith('PUT'))).toHaveLength(2); // original + one after the refresh
    expect(t.sleeps).toEqual([]);
  });

  it('BigQuery: service-account key message from the first call, not a network error', async () => {
    const t = deps(() => json(401));
    const err = (await exportCategoryToBigQuery(fakeDb(3), 'all' as never, {
      creds: () => ({ projectId: 'proj' }),
      deps: t.d,
    }).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/service-account key/i);
    expect(t.sleeps).toEqual([]);
  });
});

describe('Sheets batch size', () => {
  it('counts UTF-8 bytes: three Cyrillic rows do not fit a batch that three ASCII rows of the same length would', async () => {
    const puts: unknown[] = [];
    const t = deps((url, init) => {
      if (url.endsWith('/v4/spreadsheets')) return json(200, { spreadsheetId: 'S1', sheets: [{ properties: { sheetId: 0 } }] });
      if (init.method === 'PUT') puts.push(init.body);
      return json(200);
    });
    const db = {
      iterateUrlsByCategory: () =>
        (function* () {
          for (let i = 1; i <= 3; i++) {
            yield { id: i, url: `https://x.test/${i}`, statusCode: 200, title: 'я'.repeat(500), metaDescription: '', h1: '', indexability: '', responseTimeMs: 1, depth: 1, inlinks: 1, outlinks: 1, wordCount: 1 };
          }
        })(),
    } as unknown as ProjectDb;
    await exportCategoryToSheets(db, 'all' as never, 'T', { deps: t.d, limits: { batchBytes: 2500 } });
    expect(puts).toHaveLength(2);
  });
});
