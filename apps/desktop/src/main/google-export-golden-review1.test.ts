import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { datasetRows } from '@freecrawl/core';
import { EXPORT_DATASET_COLUMNS } from '@freecrawl/shared-types';
import type { GoogleDeps } from './google-retry.js';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  safeStorage: {},
}));

const { exportCategoryToSheets } = await import('./sheets-export.js');
const { exportCategoryToBigQuery } = await import('./bigquery-export.js');

// B60 Done 8 (review round 1): the golden for the `urls` dataset, recorded from
// the exporters as they stood before the dataset choice: header row and cell
// values for Sheets, table schema and row json for BigQuery. Distinct text per
// column, so a swapped column (meta_description fed from h1) fails. Plus the
// broken-links dataset on a fixture DB: headers and row count.
let dir: string;
let db: ProjectDb;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-golden-'));
  const file = path.join(dir, 'p.seoproject');
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec(`
    INSERT INTO urls (id, url, status_code, title, meta_description, h1, indexability, response_time_ms, depth, inlinks, outlinks, word_count)
      VALUES (1, 'https://ex.com/a', 200, 'TITLE-A', 'META-A', 'H1-A', 'indexable', 120, 1, 7, 9, 345);
    INSERT INTO urls (id, url, status_code, indexability) VALUES (2, 'https://ex.com/gone', 404, 'non-indexable:client-error');
    INSERT INTO urls (id, url, status_code, indexability) VALUES (3, 'https://ex.com/gone2', 410, 'non-indexable:client-error');
    INSERT INTO links (from_url_id, to_url, anchor, is_internal) VALUES (1, 'https://ex.com/gone', 'a', 1), (1, 'https://ex.com/gone2', 'b', 1), (1, 'https://ex.com/gone', 'c', 1);
  `);
  raw.close();
  db = new ProjectDb(file, { readOnly: true });
});
afterAll(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Fetch that records every body and answers like a healthy Google API. */
function recorder() {
  const bodies: { url: string; method: string; body: any }[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  const deps: Partial<GoogleDeps> = {
    fetch: (async (url: string, init: RequestInit) => {
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      bodies.push({ url, method: init.method ?? 'GET', body });
      if (url.endsWith('/v4/spreadsheets')) {
        return new Response(JSON.stringify({ spreadsheetId: 'S', sheets: [{ properties: { sheetId: 0 } }] }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as unknown as GoogleDeps['fetch'],
    getToken: async () => 'tok',
    sleep: async () => {},
    now: () => 1_700_000_000_000,
    random: () => 0,
    log: () => {},
  };
  return { bodies, deps };
}

describe('urls golden', () => {
  it('Sheets: header row and the cell values of a full row, column by column', async () => {
    const r = recorder();
    await exportCategoryToSheets(db, 'all', 't', { deps: r.deps });
    const put = r.bodies.find((b) => b.method === 'PUT')!;
    expect(put.body.values[0]).toEqual([
      'URL', 'Status', 'Title', 'Meta description', 'H1', 'Indexability',
      'Response time (ms)', 'Depth', 'Inlinks', 'Outlinks', 'Word count',
    ]);
    expect(put.body.values[1]).toEqual([
      'https://ex.com/a', 200, 'TITLE-A', 'META-A', 'H1-A', 'indexable', 120, 1, 7, 9, 345,
    ]);
    expect(put.body.values).toHaveLength(4); // header + 3 URLs
  });

  it('BigQuery: the table schema and the row json, field by field', async () => {
    const r = recorder();
    await exportCategoryToBigQuery(db, 'all', { creds: () => ({ projectId: 'p' }), deps: r.deps });
    const table = r.bodies.find((b) => b.url.endsWith('/tables') && b.method === 'POST')!;
    expect(table.body.schema.fields.map((f: { name: string; type: string }) => `${f.name}:${f.type}`)).toEqual([
      'url:STRING', 'status_code:INTEGER', 'title:STRING', 'meta_description:STRING', 'h1:STRING',
      'indexability:STRING', 'response_time_ms:INTEGER', 'depth:INTEGER', 'inlinks:INTEGER',
      'outlinks:INTEGER', 'word_count:INTEGER',
    ]);
    const insert = r.bodies.find((b) => b.url.endsWith('/insertAll'))!;
    expect(insert.body.rows[0]).toEqual({
      insertId: '1',
      json: {
        url: 'https://ex.com/a', status_code: 200, title: 'TITLE-A', meta_description: 'META-A', h1: 'H1-A',
        indexability: 'indexable', response_time_ms: 120, depth: 1, inlinks: 7, outlinks: 9, word_count: 345,
      },
    });
    expect(insert.body.rows).toHaveLength(3);
  });
});

describe('broken-links dataset on a fixture DB', () => {
  const headers = EXPORT_DATASET_COLUMNS['broken-links'].map((c) => c.header);

  it('Sheets: header equals the dataset columns and the row count equals datasetRows', async () => {
    const count = [...datasetRows(db, 'broken-links')].length;
    expect(count).toBe(3);
    const r = recorder();
    const out = await exportCategoryToSheets(db, 'all', 't', { dataset: 'broken-links', deps: r.deps });
    const put = r.bodies.find((b) => b.method === 'PUT')!;
    expect(put.body.values[0]).toEqual(headers);
    expect(put.body.values.length - 1).toBe(count);
    expect(out.rowsWritten).toBe(count);
  });

  it('BigQuery: one all-STRING column per dataset column and the same row count', async () => {
    const r = recorder();
    const out = await exportCategoryToBigQuery(db, 'all', {
      dataset: 'broken-links',
      creds: () => ({ projectId: 'p' }),
      deps: r.deps,
    });
    const table = r.bodies.find((b) => b.url.endsWith('/tables') && b.method === 'POST')!;
    expect(table.body.schema.fields).toHaveLength(headers.length);
    expect(table.body.schema.fields.every((f: { type: string }) => f.type === 'STRING')).toBe(true);
    expect(out.rowsWritten).toBe(3);
  });
});

describe('cells that look like formulas or numbers (8b) and create count (8c)', () => {
  const titles = ['-50%', '=1+1', '+7 495 1'];
  const fake = {
    iterateUrlsByCategory: () =>
      (function* () {
        for (const [i, t] of titles.entries()) {
          yield { id: i + 1, url: `https://ex.com/${i}`, statusCode: 200, title: t, metaDescription: '', h1: '', indexability: '', responseTimeMs: 1, depth: 1, inlinks: 1, outlinks: 1, wordCount: 1 };
        }
      })(),
  } as unknown as ProjectDb;

  it('Sheets gets them literally with RAW; BigQuery gets them literally as json', async () => {
    const s = recorder();
    await exportCategoryToSheets(fake, 'all', 't', { deps: s.deps });
    const put = s.bodies.find((b) => b.method === 'PUT')!;
    expect(put.url).toContain('valueInputOption=RAW');
    expect(put.body.values.slice(1).map((v: unknown[]) => v[2])).toEqual(titles);
    const b = recorder();
    await exportCategoryToBigQuery(fake, 'all', { creds: () => ({ projectId: 'p' }), deps: b.deps });
    const insert = b.bodies.find((x) => x.url.endsWith('/insertAll'))!;
    expect(insert.body.rows.map((r: { json: { title: string } }) => r.json.title)).toEqual(titles);
  });

  it('a write that fails after the create does not create a second spreadsheet', async () => {
    const s = recorder();
    const inner = s.deps.fetch!;
    s.deps.fetch = (async (url: string, init: RequestInit) =>
      init.method === 'PUT' ? new Response('{}', { status: 400 }) : inner(url, init)) as unknown as typeof fetch;
    await expect(exportCategoryToSheets(fake, 'all', 't', { deps: s.deps })).rejects.toThrow(/Sheets write batch 1/);
    expect(s.bodies.filter((b) => b.method === 'POST' && b.url.endsWith('/v4/spreadsheets'))).toHaveLength(1);
  });
});
