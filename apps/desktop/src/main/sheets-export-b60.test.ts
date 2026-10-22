import { describe, expect, it, vi } from 'vitest';
import type { ProjectDb } from '@freecrawl/db';
import type { GoogleDeps } from './google-retry.js';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  safeStorage: {},
}));

const { exportCategoryToSheets, sheetsRowCap } = await import('./sheets-export.js');

type Cell = string | number | boolean | null;
interface Call {
  method: string;
  url: string;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** A Sheets API that keeps a grid, rejects writes outside it and logs every call. */
function fakeSheets(
  script: (call: Call, n: number) => number | undefined = () => undefined,
  headers: (status: number) => Record<string, string> = () => ({}),
) {
  const calls: Call[] = [];
  const grid = { rows: 0, cols: 0 };
  const cells = new Map<number, Cell[]>();
  let title = '';
  let creates = 0;
  const sleeps: number[] = [];
  let valueCalls = 0;
  const deps: Partial<GoogleDeps> = {
    fetch: (async (url: string, init: RequestInit) => {
      const call: Call = {
        method: init.method ?? 'GET',
        url,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      const isWrite = call.url.includes('/values/');
      const forced = script(call, isWrite ? ++valueCalls : 0);
      if (forced) {
        return new Response('{}', { status: forced, headers: headers(forced) });
      }
      const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
      if (call.url.endsWith('/v4/spreadsheets')) {
        creates++;
        const g = call.body.sheets?.[0]?.properties?.gridProperties;
        grid.rows = g?.rowCount ?? 1000;
        grid.cols = g?.columnCount ?? 26;
        title = call.body.properties.title;
        return ok({
          spreadsheetId: 'S1',
          spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/S1',
          sheets: [{ properties: { sheetId: 7 } }],
        });
      }
      if (call.url.endsWith(':batchUpdate')) {
        for (const r of call.body.requests) {
          if (r.updateSheetProperties) {
            const g = r.updateSheetProperties.properties.gridProperties;
            if (g.rowCount !== undefined) grid.rows = g.rowCount;
            if (g.columnCount !== undefined) grid.cols = g.columnCount;
          }
          if (r.updateSpreadsheetProperties) title = r.updateSpreadsheetProperties.properties.title;
        }
        return ok({});
      }
      const m = /\/values\/A(\d+):([A-Z]+)(\d+)\?valueInputOption=RAW$/.exec(call.url);
      if (call.method === 'PUT' && m) {
        const start = Number(m[1]);
        const end = Number(m[3]);
        if (end > grid.rows) return new Response('{}', { status: 400 });
        (call.body.values as Cell[][]).forEach((row, i) => cells.set(start + i, row));
        expect(end - start + 1).toBe(call.body.values.length);
        return ok({});
      }
      return new Response('{}', { status: 404 });
    }) as unknown as GoogleDeps['fetch'],
    getToken: async () => 'tok',
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => 0,
    random: () => 0,
    log: () => {},
  };
  return {
    deps,
    calls,
    grid,
    cells,
    sleeps,
    title: () => title,
    creates: () => creates,
    puts: () => calls.filter((c) => c.method === 'PUT'),
  };
}

function urlRows(n: number, pad = 0) {
  return (function* () {
    for (let i = 1; i <= n; i++) {
      yield {
        id: i,
        url: `https://x.test/${i}`,
        statusCode: 200,
        title: pad ? 'x'.repeat(pad) : `T${i}`,
        metaDescription: '',
        h1: '',
        indexability: 'indexable',
        responseTimeMs: 10,
        depth: 1,
        inlinks: 1,
        outlinks: 1,
        wordCount: 5,
      };
    }
  })();
}

function fakeDb(n: number, pad = 0, extra: Record<string, unknown> = {}): ProjectDb {
  return { iterateUrlsByCategory: () => urlRows(n, pad), ...extra } as unknown as ProjectDb;
}

describe('sheetsRowCap (B60)', () => {
  it.each([
    [11, 909_089],
    [26, 384_614],
    [5, 1_999_999],
  ])('F = %i columns holds %i data rows', (f, rows) => {
    expect(sheetsRowCap(f)).toBe(rows);
  });
});

describe('Sheets export (B60)', () => {
  it('writes 25 000 rows in 3 consecutive updates, header once, never an append', async () => {
    const s = fakeSheets();
    const r = await exportCategoryToSheets(fakeDb(25_000), 'all', 't', {
      deps: s.deps,
      limits: { batchRows: 10_000 },
    });
    expect(r).toMatchObject({ rowsWritten: 25_000, totalRows: 25_000, truncated: false, dataset: 'urls' });
    expect(s.puts().map((c) => c.url.match(/values\/(A\d+:K\d+)/)![1])).toEqual([
      'A1:K10001',
      'A10002:K20001',
      'A20002:K25001',
    ]);
    expect(s.puts()[0]!.body.values[0][0]).toBe('URL');
    expect(s.puts()[1]!.body.values[0][0]).toBe('https://x.test/10001');
    expect(s.calls.some((c) => /append/i.test(c.url))).toBe(false);
    expect(s.cells.size).toBe(25_001);
  });

  it('stops at the cap, counts the rest, and sizes every grid to the dataset column count', async () => {
    const s = fakeSheets();
    const r = await exportCategoryToSheets(fakeDb(2_500), 'all', 't', {
      deps: s.deps,
      limits: { maxRows: 1_000, batchRows: 400 },
    });
    expect(r).toMatchObject({ rowsWritten: 1_000, totalRows: 2_500, truncated: true });
    expect(s.cells.size).toBe(1_001);
    const create = s.calls[0]!.body.sheets[0].properties.gridProperties;
    expect(create.columnCount).toBe(11);
    const resizes = s.calls.filter((c) => c.url.endsWith(':batchUpdate'));
    expect(resizes.length).toBeGreaterThan(0);
    for (const c of resizes) {
      expect(c.body.requests[0].updateSheetProperties.properties.gridProperties.columnCount).toBe(11);
      expect(c.body.requests[0].updateSheetProperties.properties.sheetId).toBe(7);
    }
    expect(s.grid.rows).toBe(1_001);
  });

  it('a dataset exports its own columns, raw, in a grid of its own width', async () => {
    const s = fakeSheets();
    const db = fakeDb(0, 0, {
      iterateIssuesLong: function* () {
        yield { url: 'https://x.test/a', issueKey: '=1+1' };
        yield { url: 'https://x.test/b', issueKey: '-50%' };
      },
    });
    const r = await exportCategoryToSheets(db, 'all', 't', { dataset: 'issues-long', deps: s.deps });
    expect(r).toMatchObject({ rowsWritten: 2, dataset: 'issues-long' });
    expect(s.calls[0]!.body.sheets[0].properties.gridProperties.columnCount).toBe(2);
    expect(s.puts()[0]!.body.values).toEqual([
      ['URL', 'Issue'],
      ['https://x.test/a', '=1+1'],
      ['https://x.test/b', '-50%'],
    ]);
    expect(s.puts()[0]!.url).toContain('valueInputOption=RAW');
    expect(s.puts()[0]!.url).toContain('A1:B3');
  });

  it('splits batches by the 1.5 MB limit before the row limit', async () => {
    const s = fakeSheets();
    const r = await exportCategoryToSheets(fakeDb(600, 5_000), 'all', 't', { deps: s.deps });
    expect(r.rowsWritten).toBe(600);
    expect(s.puts().length).toBeGreaterThan(1);
    for (const p of s.puts()) {
      expect(JSON.stringify(p.body.values).length).toBeLessThanOrEqual(1_500_000);
    }
    expect(s.puts().every((p) => p.body.values.length < 5_000)).toBe(true);
    expect(s.cells.size).toBe(601);
  });

  it('a batch failing 500 twice then succeeding is rewritten to the same range with no duplicates', async () => {
    const s = fakeSheets((_c, n) => (n === 2 || n === 3 ? 500 : undefined));
    const r = await exportCategoryToSheets(fakeDb(25), 'all', 't', {
      deps: s.deps,
      limits: { batchRows: 10 },
    });
    expect(r.rowsWritten).toBe(25);
    const batch2 = s.puts().filter((p) => p.url.includes('A12:'));
    expect(batch2).toHaveLength(3);
    expect(s.cells.size).toBe(26);
    expect(s.sleeps).toEqual([1000, 2000]);
  });

  it('a batch failing until the budget ends renames the sheet and puts its URL in the error', async () => {
    const s = fakeSheets((_c, n) => (n >= 2 ? 503 : undefined));
    const err = await exportCategoryToSheets(fakeDb(25), 'all', 't', {
      deps: s.deps,
      limits: { batchRows: 10 },
    }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('https://docs.google.com/spreadsheets/d/S1');
    expect(s.title()).toBe('FreeCrawl — FAILED export (partial)');
    expect(s.sleeps).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 64000]);
    expect(s.sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(180_000);
  });

  it('a 429 with Retry-After: 90 sleeps 90 s', async () => {
    const s = fakeSheets((_c, n) => (n === 1 ? 429 : undefined), () => ({ 'retry-after': '90' }));
    await exportCategoryToSheets(fakeDb(3), 'all', 't', { deps: s.deps });
    expect(s.sleeps).toEqual([90_000]);
  });

  it('a 400 write is not retried; the failed first write renames the sheet', async () => {
    const s = fakeSheets((_c, n) => (n === 1 ? 400 : undefined));
    const err = await exportCategoryToSheets(fakeDb(3), 'all', 't', { deps: s.deps }).catch((e: Error) => e);
    expect(s.puts()).toHaveLength(1);
    expect(s.sleeps).toEqual([]);
    expect((err as Error).message).toContain('/d/S1');
    expect(s.title()).toContain('FAILED');
  });

  it('an empty dataset creates nothing', async () => {
    const s = fakeSheets();
    const r = await exportCategoryToSheets(fakeDb(0), 'all', 't', { deps: s.deps });
    expect(r).toMatchObject({ rowsWritten: 0, totalRows: 0, truncated: false, spreadsheetUrl: '' });
    expect(s.calls).toHaveLength(0);
  });

  it('keeps the error URL when the rename itself fails', async () => {
    const s = fakeSheets((c, n) => (n === 1 || c.url.endsWith(':batchUpdate') ? 400 : undefined));
    const err = await exportCategoryToSheets(fakeDb(3), 'all', 't', { deps: s.deps }).catch((e: Error) => e);
    expect((err as Error).message).toContain('/d/S1');
  });

  it('does not repeat the create request after a network error', async () => {
    let n = 0;
    const deps: Partial<GoogleDeps> = {
      ...fakeSheets().deps,
      fetch: (async () => {
        n++;
        throw new Error('socket hang up https://sheets.googleapis.com Bearer SECRET');
      }) as unknown as GoogleDeps['fetch'],
    };
    const err = await exportCategoryToSheets(fakeDb(3), 'all', 't', { deps }).catch((e: Error) => e);
    expect(n).toBe(1);
    expect((err as Error).message).toContain('check Drive for an empty spreadsheet');
    expect((err as Error).message).not.toContain('SECRET');
  });
});
