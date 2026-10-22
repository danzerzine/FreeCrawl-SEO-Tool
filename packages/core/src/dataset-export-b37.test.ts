import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProjectDb } from '@freecrawl/db';
import { EXPORT_DATASET_COLUMNS } from '@freecrawl/shared-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { datasetRows, readCell } from './dataset-export.js';
import { CLI_EXPORT_DATASETS } from './export-items.js';

let dir: string;
let db: ProjectDb;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b37x-'));
  const file = path.join(dir, 'p.seoproject');
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec(`INSERT INTO urls (id, url, status_code, content_type, indexability) VALUES
    (1,'https://ex.test/a',200,'text/html','indexable'),(2,'https://ex.test/b',200,'text/html','indexable')`);
  raw.close();
  db = new ProjectDb(file);
  const base = { accountId: 'acc', property: 'properties/1', fetchedAt: 't', wipeAll: false };
  db.storeGa4CustomValues({
    ...base,
    fields: ['customEvent:author'],
    rows: [
      { url: 'https://ex.test/a', field: 'customEvent:author', value: 'Bob', sessions: 9 },
      { url: 'https://ex.test/a', field: 'customEvent:author', value: 'Ann', sessions: 3 },
      { url: 'https://ex.test/b', field: 'customEvent:author', value: 'Cy', sessions: 1 },
    ],
  });
  db.storeGa4CustomValues({
    ...base,
    fields: ['customEvent:words'],
    rows: [{ url: 'https://ex.test/a', field: 'customEvent:words', value: '1200', sessions: null }],
  });
  db.storeGa4CustomValues({
    ...base,
    fields: ['customEvent:gone'],
    rows: [{ url: 'https://ex.test/a', field: 'customEvent:gone', value: 'stale', sessions: 1 }],
  });
  db.setMeta(
    'ga4FetchMeta:acc',
    JSON.stringify({
      property: 'properties/1',
      propertyName: 'p',
      startDate: 's',
      endDate: 'e',
      fetchedAt: 't',
      rowCount: 2,
      customFields: [
        { field: 'customEvent:author', kind: 'dimension', rows: 3, ok: true },
        { field: 'customEvent:words', kind: 'metric', rows: 1, ok: true },
        { field: 'customEvent:gone', kind: 'dimension', rows: 0, ok: false },
      ],
    }),
  );
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('analytics-custom dataset (B37)', () => {
  const cols = EXPORT_DATASET_COLUMNS['analytics-custom'];
  const table = () => [...datasetRows(db, 'analytics-custom', { ga4AccountId: 'acc' })].map((r) => cols.map((c) => readCell(r, c.key)));

  it('has long-form columns: page, then field, value, sessions', () => {
    expect(cols.map((c) => c.header)).toEqual(['URL', 'Status', 'Field', 'Value', 'Sessions']);
  });

  it('writes one row per page, field and value for the fields that came back, values by sessions', () => {
    expect(table()).toEqual([
      ['https://ex.test/a', 200, 'customEvent:author', 'Bob', 9],
      ['https://ex.test/a', 200, 'customEvent:author', 'Ann', 3],
      ['https://ex.test/a', 200, 'customEvent:words', '1200', null],
      ['https://ex.test/b', 200, 'customEvent:author', 'Cy', 1],
    ]);
  });

  it('is an account dataset: the CLI does not offer it, the Analytics export is unchanged', () => {
    expect(CLI_EXPORT_DATASETS).not.toContain('analytics-custom');
    expect(EXPORT_DATASET_COLUMNS.analytics.map((c) => c.header)).toEqual([
      'URL',
      'Status',
      'Sessions',
      'Users',
      'Pageviews',
      'Engagement Rate',
      'Avg. Session Duration',
      'Fetched At',
    ]);
  });
});
