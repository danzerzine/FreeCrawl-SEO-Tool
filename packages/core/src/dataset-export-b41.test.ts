import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProjectDb } from '@freecrawl/db';
import { EXPORT_DATASET_COLUMNS, type PagespeedMetrics } from '@freecrawl/shared-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { datasetRows, readCell } from './dataset-export.js';
import { CLI_EXPORT_DATASETS } from './export-items.js';

const A = 'https://ex.test/a';
const B = 'https://ex.test/b';
const m: PagespeedMetrics = {
  performance: 80, lcp: 2000, cls: 0.1, fcp: 1000, tbt: 100, speedIndex: 1500, tti: 3000, maxPotentialFid: 90, inp: null,
  status: 'ok', error: null, fetchedAt: '2026-10-23T10:00:00.000Z',
};

let dir: string;
let db: ProjectDb;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b41x-'));
  const file = path.join(dir, 'p.seoproject');
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec(`INSERT INTO urls (id, url, is_external, content_kind, status_code) VALUES (1,'${A}',0,'html',200),(2,'${B}',0,'html',200)`);
  raw.close();
  db = new ProjectDb(file);
  db.upsertPagespeedResult(A, 'mobile', m, {
    lighthouseVersion: '13.5.0',
    audits: [
      { auditId: 'image-delivery-insight', kind: 'insight', title: 'Improve image delivery', score: 0, displayValue: 'Est savings of 666 KiB', savingsMs: 1200, savingsBytes: 682028, items: [{ url: 'https://ex.test/i.gif', wastedBytes: 682028 }], itemsTruncated: false },
      { auditId: 'bf-cache', kind: 'diagnostic', title: 'Page prevented back/forward cache restoration', score: 0, displayValue: null, savingsMs: null, savingsBytes: null, items: [], itemsTruncated: false },
    ],
  });
  db.upsertPagespeedResult(A, 'desktop', m, { lighthouseVersion: '13.5.0', audits: [] });
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const table = (key: 'pagespeed' | 'pagespeed-audits') =>
  [...datasetRows(db, key, {})].map((r) => EXPORT_DATASET_COLUMNS[key].map((c) => readCell(r, c.key)));

describe('B41 R9: dataset pagespeed-audits', () => {
  it('has the columns of the spec, one row per url x strategy x audit, biggest saving first', () => {
    expect(EXPORT_DATASET_COLUMNS['pagespeed-audits'].map((c) => c.header)).toEqual([
      'URL', 'Strategy', 'Audit', 'Kind', 'Title', 'Score', 'Display Value', 'Savings (ms)', 'Savings (bytes)',
      'Resources Count', 'Resources JSON', 'Lighthouse Version', 'Fetched At',
    ]);
    expect(table('pagespeed-audits')).toEqual([
      [A, 'mobile', 'image-delivery-insight', 'insight', 'Improve image delivery', 0, 'Est savings of 666 KiB', 1200, 682028, 1,
        '[{"url":"https://ex.test/i.gif","wastedBytes":682028}]', '13.5.0', '2026-10-23T10:00:00.000Z'],
      [A, 'mobile', 'bf-cache', 'diagnostic', 'Page prevented back/forward cache restoration', 0, null, null, null, 0, '[]', '13.5.0', '2026-10-23T10:00:00.000Z'],
    ]);
  });

  it('the CLI offers it as --what dataset:pagespeed-audits', () => {
    expect(CLI_EXPORT_DATASETS).toContain('pagespeed-audits');
  });
});

describe('B41 R9: dataset pagespeed gets two more columns per device, appended at the end', () => {
  it('keeps the old columns in place and ends with opportunity count and top saving', () => {
    const headers = EXPORT_DATASET_COLUMNS.pagespeed.map((c) => c.header);
    expect(headers.slice(-4)).toEqual(['Mobile Opportunities', 'Mobile Top Saving (ms)', 'Desktop Opportunities', 'Desktop Top Saving (ms)']);
    expect(headers.slice(0, 3)).toEqual(['URL', 'Status', 'Mobile Performance']);
    const rows = table('pagespeed');
    expect(rows.find((r) => r[0] === A)!.slice(-4)).toEqual([1, 1200, 0, null]);
    expect(rows.find((r) => r[0] === B)!.slice(-4)).toEqual([0, null, 0, null]);
  });
});
