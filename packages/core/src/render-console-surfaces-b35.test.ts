import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ProjectDb } from '@freecrawl/db';
import { URL_COLUMN_HEADERS } from '@freecrawl/shared-types';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { exportUrlsToCsv } from './csv-export.js';
import { renderHtmlReport } from './html-report.js';

// B35 surfaces that need no UI: CSV export and the HTML report.
let dir: string;
let db: ProjectDb;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b35s-'));
  db = new ProjectDb(path.join(dir, 'p.seoproject'));
  db.upsertUrl({
    url: 'https://ex.com/a',
    depth: 0,
    statusCode: 200,
    indexability: 'indexable',
    contentKind: 'html',
    consoleErrors: 3,
    failedResources: 2,
    consoleLog: '[{"kind":"console","text":"x"}]',
  });
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

it('URL CSV has Console Errors, Failed Resources and Console Log columns', async () => {
  const f = path.join(dir, 'a.csv');
  await exportUrlsToCsv(db, f);
  const text = fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '');
  const head = text.split('\n')[0]!.split(',');
  expect(head).toContain('Console Errors');
  expect(head).toContain('Failed Resources');
  expect(head).toContain('Console Log');
  expect(text).toContain('3,2,');
  expect(URL_COLUMN_HEADERS.consoleErrors).toBe('Console Errors');
});

it('HTML report lists both issues with their counts', async () => {
  const html = await renderHtmlReport(db, { startUrl: 'https://ex.com/' });
  expect(html).toContain('Console Errors');
  expect(html).toContain('Failed Resources');
});
