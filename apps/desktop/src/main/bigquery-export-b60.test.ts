import { describe, expect, it, vi } from 'vitest';
import type { ProjectDb } from '@freecrawl/db';
import type { GoogleDeps } from './google-retry.js';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  safeStorage: {},
}));

const { exportCategoryToBigQuery } = await import('./bigquery-export.js');

interface Call {
  method: string;
  url: string;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}
interface InsertRow {
  insertId: string;
  json: Record<string, unknown>;
}

/** A BigQuery that dedupes by insertId and, with skipInvalidRows, stores the valid rows. */
function fakeBigQuery(
  opts: {
    failInsert?: (n: number) => number | undefined;
    retryAfter?: string;
    tableExists?: { fields: unknown[] };
  } = {},
) {
  const calls: Call[] = [];
  const stored = new Map<string, InsertRow>();
  const sleeps: number[] = [];
  let inserts = 0;
  let createdSchema: { fields: unknown[] } | null = null;
  const deps: Partial<GoogleDeps> = {
    fetch: (async (url: string, init: RequestInit) => {
      const call: Call = {
        method: init.method ?? 'GET',
        url,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      const ok = (b: unknown = {}) => new Response(JSON.stringify(b), { status: 200 });
      if (call.method === 'POST' && call.url.endsWith('/datasets')) return ok();
      if (call.method === 'POST' && call.url.endsWith('/tables')) {
        if (opts.tableExists) return new Response('{}', { status: 409 });
        createdSchema = call.body.schema;
        return ok();
      }
      if (call.method === 'GET' && /\/tables\/[^/]+$/.test(call.url)) {
        return ok({ schema: opts.tableExists });
      }
      if (call.url.endsWith('/insertAll')) {
        const status = opts.failInsert?.(++inserts);
        if (status) {
          return new Response('{}', {
            status,
            headers: opts.retryAfter ? { 'retry-after': opts.retryAfter } : {},
          });
        }
        const rows = call.body.rows as InsertRow[];
        const insertErrors: unknown[] = [];
        rows.forEach((r, index) => {
          if (r.json['title'] === 'BAD' && call.body.skipInvalidRows) {
            insertErrors.push({ index, errors: [{ message: `bad value in row ${index}` }] });
          } else {
            stored.set(r.insertId, r);
          }
        });
        return ok(insertErrors.length ? { insertErrors } : {});
      }
      return new Response('{}', { status: 404 });
    }) as unknown as GoogleDeps['fetch'],
    getToken: async () => 'tok',
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => 1_700_000_000_000,
    random: () => 0,
    log: () => {},
  };
  return {
    deps,
    calls,
    stored,
    sleeps,
    schema: () => createdSchema,
    inserts: () => calls.filter((c) => c.url.endsWith('/insertAll')),
  };
}

const creds = () => ({ projectId: 'proj', serviceAccountJson: '' });

function fakeDb(n: number, bad: number[] = [], extra: Record<string, unknown> = {}): ProjectDb {
  return {
    iterateUrlsByCategory: function* () {
      for (let i = 1; i <= n; i++) {
        yield { id: 100 + i, url: `https://x.test/${i}`, title: bad.includes(i) ? 'BAD' : `T${i}`, statusCode: 200 };
      }
    },
    ...extra,
  } as unknown as ProjectDb;
}

describe('BigQuery export (B60)', () => {
  it('sends skipInvalidRows and an insertId on each row; a 503 on chunk 2 is retried with the same ids', async () => {
    const bq = fakeBigQuery({ failInsert: (n) => (n === 2 ? 503 : undefined) });
    const r = await exportCategoryToBigQuery(fakeDb(1200), 'all', { deps: bq.deps, creds });
    expect(r).toMatchObject({ rowsWritten: 1200, rowsRejected: 0, dataset: 'urls' });
    const inserts = bq.inserts();
    expect(inserts).toHaveLength(4); // chunk 1, chunk 2 twice, chunk 3
    for (const c of inserts) {
      expect(c.body.skipInvalidRows).toBe(true);
      for (const row of c.body.rows) expect(typeof row.insertId).toBe('string');
    }
    expect(inserts[2]!.body.rows.map((x: InsertRow) => x.insertId)).toEqual(
      inserts[1]!.body.rows.map((x: InsertRow) => x.insertId),
    );
    expect(bq.stored.size).toBe(1200);
    expect(bq.stored.has('101')).toBe(true); // the URL's database id
    expect(bq.sleeps).toEqual([1000]);
  });

  it('a 429 with Retry-After: 3 waits 3 s', async () => {
    const bq = fakeBigQuery({ failInsert: (n) => (n === 1 ? 429 : undefined), retryAfter: '3' });
    await exportCategoryToBigQuery(fakeDb(5), 'all', { deps: bq.deps, creds });
    expect(bq.sleeps).toEqual([3000]);
  });

  it('counts rejected rows from insertErrors and returns the first message', async () => {
    const bq = fakeBigQuery();
    const r = await exportCategoryToBigQuery(fakeDb(500, [7, 300]), 'all', { deps: bq.deps, creds });
    expect(r).toMatchObject({ rowsRejected: 2, rowsWritten: 498, firstRejectionError: 'bad value in row 6' });
    expect(bq.stored.size).toBe(498);
  });

  it('a dataset gets its own all-STRING table named <dataset>_<unix> with ids dataset:index', async () => {
    const bq = fakeBigQuery();
    const db = fakeDb(0, [], {
      iterateIssuesLong: function* () {
        yield { url: 'https://x.test/a', issueKey: '=1+1' };
        yield { url: 'https://x.test/b', issueKey: null };
      },
    });
    const r = await exportCategoryToBigQuery(db, 'all', { dataset: 'issues-long', deps: bq.deps, creds });
    expect(r.tableId).toBe('issues_long_1700000000');
    expect(r).toMatchObject({ rowsWritten: 2, dataset: 'issues-long' });
    expect(bq.schema()).toEqual({
      fields: [
        { name: 'url', type: 'STRING', mode: 'NULLABLE' },
        { name: 'issue', type: 'STRING', mode: 'NULLABLE' },
      ],
    });
    expect(bq.inserts()[0]!.body.rows).toEqual([
      { insertId: 'issues-long:0', json: { url: 'https://x.test/a', issue: '=1+1' } },
      { insertId: 'issues-long:1', json: { url: 'https://x.test/b', issue: null } },
    ]);
  });

  it('a chunk that fails past the retry budget stops the export and names the table and rows written', async () => {
    const bq = fakeBigQuery({ failInsert: (n) => (n >= 2 ? 500 : undefined) });
    const err = await exportCategoryToBigQuery(fakeDb(1200), 'all', { deps: bq.deps, creds }).catch(
      (e: Error) => e,
    );
    const msg = (err as Error).message;
    expect(msg).toContain('chunk 2');
    expect(msg).toContain('500 row(s)');
    expect(msg).toContain('proj.freecrawl_seo.urls_1700000000');
    expect(bq.sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(180_000);
  });

  it('a 409 on createTable is success when the existing schema equals ours', async () => {
    const first = fakeBigQuery();
    await exportCategoryToBigQuery(fakeDb(1), 'all', { deps: first.deps, creds });
    const bq = fakeBigQuery({ tableExists: first.schema()! });
    const r = await exportCategoryToBigQuery(fakeDb(3), 'all', { deps: bq.deps, creds });
    expect(r.rowsWritten).toBe(3);
  });

  it('a 409 on createTable with another schema fails and names the mismatch', async () => {
    const bq = fakeBigQuery({ tableExists: { fields: [{ name: 'other', type: 'STRING', mode: 'NULLABLE' }] } });
    const err = await exportCategoryToBigQuery(fakeDb(3), 'all', { deps: bq.deps, creds }).catch(
      (e: Error) => e,
    );
    expect((err as Error).message).toMatch(/schema/i);
    expect(bq.inserts()).toHaveLength(0);
  });
});
