import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ProjectDb } from '@freecrawl/db';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { exportUrlsToCsv } from './csv-export.js';
import { renderHtmlReport } from './html-report.js';

let dir: string;
let db: ProjectDb;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b45x-'));
  db = new ProjectDb(path.join(dir, 'p.seoproject'));
  // zzz first on purpose: rows are written in id order, not sorted.
  for (const [u, n, c] of [
    ['zzz', 2, '{"duplicate-id":1,"missing-doctype":1}'],
    ['aaa', 0, null],
  ] as const) {
    db.upsertUrl({ url: `https://ex.com/${u}`, depth: 0, statusCode: 200, indexability: 'indexable', contentKind: 'html', markupErrors: n, markupCodes: c });
  }
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

it('URL CSV: Markup Errors and Markup Error Codes sit right before Crawled At; rows in id order', async () => {
  const f = path.join(dir, 'a.csv');
  await exportUrlsToCsv(db, f);
  const lines = fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '').split('\n').filter(Boolean);
  expect(lines[0]!.split(',')).toEqual([
    'URL',
    'Is External',
    'Status',
    'Type',
    'Indexability',
    'Indexability Status',
    'Title 1',
    'Title 1 Length',
    'Meta Description 1',
    'Meta Description 1 Length',
    'H1-1',
    'H2 Count',
    'Word Count',
    'Content Area Word Count',
    'Canonical Link Element 1',
    'HTTP Canonical',
    'Meta Robots 1',
    'X-Robots-Tag 1',
    'Content Type',
    'Size (Bytes)',
    'Response Time',
    'Crawl Depth',
    'Inlinks',
    'Outlinks',
    'Redirect URL',
    'JS H1 Changed',
    'JS Canonical Changed',
    'JS Links Changed',
    'JS Text Changed',
    'Render Diff',
    'Console Errors',
    'Failed Resources',
    'Console Log',
    'Markup Errors',
    'Markup Error Codes',
    'Cookies',
    'Cookies Truncated',
    'Cookies JSON',
    'CSS Bytes',
    'Unused CSS Bytes',
    'JS Bytes',
    'Unused JS Bytes',
    // B136: the ten module-5 page signals, right before Crawl Timestamp.
    'Hreflang Outside <head>',
    'Title Outside <head>',
    'Description Outside <head>',
    'Meta Robots Outside <head>',
    'OG Tag Uses name=',
    'Internal Link with UTM',
    'Noindex for Other Engines',
    'Pagination Loop',
    'Hreflang on Non-Canonical Page',
    'Noindex Alternate',
    'Crawl Timestamp',
  ]);
  expect(lines[1]).toContain('https://ex.com/zzz');
  expect(lines[2]).toContain('https://ex.com/aaa');
  expect(lines[1]).toContain('2,"{""duplicate-id"":1,""missing-doctype"":1}",');
});

it('HTML report lists both issues', async () => {
  const html = await renderHtmlReport(db, { startUrl: 'https://ex.com/' });
  expect(html).toContain('HTML Markup Errors');
  expect(html).toContain('Duplicate id Attributes');
});
