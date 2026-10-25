import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import type { GoogleDeps } from './google-retry.js';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  safeStorage: {},
}));

const { exportCategoryToSheets } = await import('./sheets-export.js');
const { exportCategoryToBigQuery } = await import('./bigquery-export.js');
const { datasetTable } = await import('./google-export-rows.js');

// B156: one Sheets / BigQuery run writes several datasets (tabs / tables), and
// `links` (every stored link edge, internal and external) is one of them.
let dir: string;
let db: ProjectDb;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b156-'));
  const file = path.join(dir, 'p.seoproject');
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec(`
    INSERT INTO urls (id, url, status_code, title, indexability) VALUES (1, 'https://ex.com/a', 200, 'A', 'indexable');
    INSERT INTO urls (id, url, status_code, indexability) VALUES (2, 'https://ex.com/b', 404, 'non-indexable:client-error');
    INSERT INTO links (from_url_id, to_url, anchor, is_internal) VALUES
      (1, 'https://ex.com/b', 'to b', 1),
      (1, 'https://other.test/x', 'out', 0),
      (2, 'https://ex.com/a', 'back', 1);
  `);
  raw.close();
  db = new ProjectDb(file, { readOnly: true });
});
afterAll(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

type Body = any; // eslint-disable-line @typescript-eslint/no-explicit-any

function google(overrides: (url: string, body: Body) => Response | undefined = () => undefined) {
  const calls: { url: string; method: string; body: Body }[] = [];
  const deps: Partial<GoogleDeps> = {
    fetch: (async (url: string, init: RequestInit) => {
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method: init.method ?? 'GET', body });
      const forced = overrides(url, body);
      if (forced) return forced;
      if (url.endsWith('/v4/spreadsheets')) {
        return new Response(
          JSON.stringify({
            spreadsheetId: 'S',
            sheets: (body.sheets as unknown[]).map((_s, i) => ({ properties: { sheetId: 10 + i } })),
          }),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 200 });
    }) as unknown as GoogleDeps['fetch'],
    getToken: async () => 'tok',
    sleep: async () => {},
    now: () => 1_700_000_000_000,
    random: () => 0,
    log: () => {},
  };
  return { deps, calls, puts: () => calls.filter((c) => c.method === 'PUT') };
}

describe('links dataset (B156)', () => {
  it('lists every stored link edge, internal and external, with its scope', () => {
    const { headers, rows } = datasetTable(db, 'links');
    expect(headers.slice(0, 3)).toEqual(['Source', 'Destination', 'Status Code']);
    expect(headers).toContain('Scope');
    const list = [...rows];
    expect(list).toHaveLength(3);
    const scope = headers.indexOf('Scope');
    const byTarget = new Map(list.map((r) => [r[1], r]));
    expect(byTarget.get('https://ex.com/b')![0]).toBe('https://ex.com/a');
    expect(byTarget.get('https://ex.com/b')![2]).toBe(404);
    expect(byTarget.get('https://ex.com/b')![scope]).toBe('internal');
    expect(byTarget.get('https://other.test/x')![scope]).toBe('external');
  });
});

describe('Sheets export of several datasets (B156)', () => {
  it('one spreadsheet, one named tab per dataset, every write aimed at its tab', async () => {
    const g = google();
    const r = await exportCategoryToSheets(db, 'all', 't', {
      datasets: ['urls', 'links', 'broken-links'],
      deps: g.deps,
    });
    const creates = g.calls.filter((c) => c.url.endsWith('/v4/spreadsheets'));
    expect(creates).toHaveLength(1);
    expect(creates[0]!.body.sheets.map((s: Body) => s.properties.title)).toEqual([
      'urls',
      'links',
      'broken-links',
    ]);
    expect(r.tables.map((t) => [t.dataset, t.rowsWritten])).toEqual([
      ['urls', 2],
      ['links', 3],
      ['broken-links', 1],
    ]);
    expect(r).toMatchObject({ rowsWritten: 6, totalRows: 6, truncated: false, dataset: 'urls' });
    const linksPut = g.puts().find((p) => p.url.includes(encodeURIComponent("'links'")))!;
    expect(linksPut.body.values[0][0]).toBe('Source');
    expect(linksPut.body.values).toHaveLength(4);
    expect(linksPut.body.range).toMatch(/^'links'!A1:[A-Z]+4$/);
    expect(g.puts()).toHaveLength(3);
  });

  it('an empty dataset gets no tab; all empty creates nothing', async () => {
    const g = google();
    const r = await exportCategoryToSheets(db, 'all', 't', {
      datasets: ['links', 'cookies'],
      deps: g.deps,
    });
    const create = g.calls.find((c) => c.url.endsWith('/v4/spreadsheets'))!;
    expect(create.body.sheets.map((s: Body) => s.properties.title)).toEqual(['links']);
    expect(r.tables).toEqual([
      expect.objectContaining({ dataset: 'links', rowsWritten: 3 }),
      expect.objectContaining({ dataset: 'cookies', rowsWritten: 0, totalRows: 0 }),
    ]);
    const none = google();
    const r2 = await exportCategoryToSheets(db, 'all', 't', { datasets: ['cookies'], deps: none.deps });
    expect(r2.spreadsheetUrl).toBe('');
    expect(none.calls).toHaveLength(0);
  });

  it('the cell limit is shared by the tabs: a later tab is cut to what is left', async () => {
    const g = google();
    // urls has 11 columns: header + 2 rows = 33 cells; the links tab gets the
    // rest, header + 2 rows. Batches of one row: the grids made at create
    // time (header + first batch) count against the limit from the start.
    const cols = datasetTable(db, 'links').headers.length;
    const r = await exportCategoryToSheets(db, 'all', 't', {
      datasets: ['urls', 'links'],
      deps: g.deps,
      limits: { maxCells: 33 + cols * 3, batchRows: 1 },
    });
    expect(r.tables.map((t) => [t.dataset, t.rowsWritten, t.totalRows, t.truncated])).toEqual([
      ['urls', 2, 2, false],
      ['links', 2, 3, true],
    ]);
    expect(r.truncated).toBe(true);
  });
});

describe('BigQuery export of several datasets (B156)', () => {
  it('one table per dataset under one timestamp, the dataset created once', async () => {
    const g = google();
    const r = await exportCategoryToBigQuery(db, 'all', {
      datasets: ['urls', 'links'],
      deps: g.deps,
      creds: () => ({ projectId: 'proj', serviceAccountJson: '' }),
    });
    expect(g.calls.filter((c) => c.url.endsWith('/datasets'))).toHaveLength(1);
    const tables = g.calls.filter((c) => c.url.endsWith('/tables')).map((c) => c.body.tableReference.tableId);
    expect(tables).toEqual(['urls_1700000000', 'links_1700000000']);
    expect(r.tables.map((t) => [t.dataset, t.tableRef, t.rowsWritten])).toEqual([
      ['urls', 'proj.freecrawl_seo.urls_1700000000', 2],
      ['links', 'proj.freecrawl_seo.links_1700000000', 3],
    ]);
    expect(r).toMatchObject({ tableRef: 'proj.freecrawl_seo.urls_1700000000', rowsWritten: 5, dataset: 'urls' });
    const linkInsert = g.calls.find((c) => c.url.includes('/tables/links_1700000000/insertAll'))!;
    expect(linkInsert.body.rows[0].json).toMatchObject({ source: 'https://ex.com/a', scope: 'internal' });
  });

  it('a failure in a later table names the tables already written', async () => {
    const g = google((url) =>
      url.includes('/links_1700000000/insertAll') ? new Response('{}', { status: 400 }) : undefined,
    );
    const err = await exportCategoryToBigQuery(db, 'all', {
      datasets: ['urls', 'links'],
      deps: g.deps,
      creds: () => ({ projectId: 'proj', serviceAccountJson: '' }),
    }).catch((e: Error) => e);
    expect((err as Error).message).toContain('links_1700000000');
    expect((err as Error).message).toContain('proj.freecrawl_seo.urls_1700000000');
  });
});
