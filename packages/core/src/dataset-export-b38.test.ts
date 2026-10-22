import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProjectDb } from '@freecrawl/db';
import { EXPORT_DATASET_COLUMNS } from '@freecrawl/shared-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { datasetRows, readCell } from './dataset-export.js';

let dir: string;
let db: ProjectDb;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b38x-'));
  const file = path.join(dir, 'p.seoproject');
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec(`
    INSERT INTO urls (id, url, status_code, content_type, indexability) VALUES
      (1,'https://ex.test/a',200,'text/html','indexable'),
      (2,'https://ex.test/b',200,'text/html','indexable'),
      (3,'https://ex.test/c',200,'text/html','indexable');
    INSERT INTO gsc_inspection_results
      (url, account_id, verdict, coverage_state, status, fetched_at, page_fetch_state, crawled_as,
       sitemaps_json, referring_urls_json, rich_results_json) VALUES
      ('https://ex.test/a','', 'PASS','Indexed','ok','2026-10-22T00:00:00Z','SUCCESSFUL','MOBILE',
       '["https://ex.test/s1.xml","https://ex.test/s2.xml"]',
       '{"count":31,"urls":["https://ex.test/r1","https://ex.test/r2"]}',
       '[{"type":"Product snippets","items":[{"name":"I1","errors":2,"warnings":1,"messages":["m1","m2"]},{"name":"I2","errors":0,"warnings":3,"messages":["m3"]}]},{"type":"Breadcrumbs","items":[{"name":"B","errors":0,"warnings":0,"messages":[]}]}]'),
      ('https://ex.test/c','', 'PASS','Indexed','ok','2026-09-01T00:00:00Z',NULL,NULL,NULL,NULL,NULL);
  `);
  raw.close();
  db = new ProjectDb(file);
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const NEW_HEADERS = [
  'Page Fetch State',
  'Crawled As',
  'Sitemaps',
  'Referring URLs',
  'Referring Count',
  'Rich Result Types',
  'Rich Result Errors',
  'Rich Result Warnings',
  'Rich Result Messages',
];

describe('search-console export: B38 columns', () => {
  const cols = EXPORT_DATASET_COLUMNS['search-console'];
  const table = () =>
    [...datasetRows(db, 'search-console')].map((r) => cols.map((c) => readCell(r, c.key)));

  it('appends the nine new columns after Rich Results Verdict', () => {
    const headers = cols.map((c) => c.header);
    const i = headers.indexOf('Rich Results Verdict');
    expect(headers.slice(i + 1)).toEqual(NEW_HEADERS);
    expect(cols.slice(i + 1).map((c) => c.key)).toEqual([
      'inspection.pageFetchState',
      'inspection.crawledAs',
      'inspection.sitemaps',
      'inspection.referringUrls',
      'inspection.referringCount',
      'inspection.richResultTypes',
      'inspection.richResultErrors',
      'inspection.richResultWarnings',
      'inspection.richResultMessages',
    ]);
  });

  it('one inspected page exports every new cell', () => {
    const rows = table();
    const a = rows.find((r) => r[0] === 'https://ex.test/a')!;
    expect(a.slice(-9)).toEqual([
      'SUCCESSFUL',
      'MOBILE',
      'https://ex.test/s1.xml | https://ex.test/s2.xml',
      'https://ex.test/r1 | https://ex.test/r2',
      31,
      'Product snippets | Breadcrumbs',
      1, // items with errors
      2, // items with warnings
      'm1 | m2 | m3',
    ]);
  });

  it('a page without inspection and a page inspected before this version export empty cells', () => {
    const rows = table();
    const b = rows.find((r) => r[0] === 'https://ex.test/b')!;
    expect(b.slice(-9)).toEqual(Array(9).fill(null));
    const c = rows.find((r) => r[0] === 'https://ex.test/c')!;
    expect(c.slice(-9)).toEqual(Array(9).fill(null));
  });
});
