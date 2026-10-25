import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GscInspectionResult } from '@freecrawl/shared-types';
import { runMigrations } from './migrations.js';
import { ProjectDb } from './project-db.js';

// B38: the migration number is 123 (m11-render holds 121/122); the old-project
// test builds the schema as of the highest version before this module.
const BEFORE_B38 = 120;
const NEW_COLUMNS = [
  'page_fetch_state',
  'crawled_as',
  'sitemaps_json',
  'referring_urls_json',
  'rich_results_json',
];

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b38-'));
  file = path.join(dir, 'p.seoproject');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const OLD_ROW = `('https://ex.test/a', 'acc1', 'PASS', 'Submitted and indexed', 'ALLOWED', 'INDEXING_ALLOWED',
  '2026-10-01T10:00:00Z', 'https://ex.test/a', 'https://ex.test/a', 'PASS', NULL, 'FAIL', 'ok', NULL, '2026-10-02T00:00:00Z')`;

function oldProject(): void {
  const raw = new DatabaseSync(file);
  runMigrations(raw, BEFORE_B38);
  raw.exec(`
    INSERT INTO urls (id, url, status_code, content_type, indexability)
    VALUES (1, 'https://ex.test/a', 200, 'text/html', 'indexable'),
           (2, 'https://ex.test/b', 200, 'text/html', 'indexable'),
           (3, 'https://ex.test/c', 200, 'text/html', 'indexable');
    INSERT INTO gsc_inspection_results
      (url, account_id, verdict, coverage_state, robots_txt_state, indexing_state, last_crawl_time,
       google_canonical, user_canonical, mobile_verdict, amp_verdict, rich_results_verdict, status, error, fetched_at)
    VALUES ${OLD_ROW};
  `);
  raw.close();
}

const result = (over: Partial<GscInspectionResult> = {}): GscInspectionResult => ({
  verdict: 'PASS',
  coverageState: 'Indexed',
  robotsTxtState: 'ALLOWED',
  indexingState: 'INDEXING_ALLOWED',
  lastCrawlTime: null,
  googleCanonical: null,
  userCanonical: null,
  mobileVerdict: null,
  ampVerdict: null,
  richResultsVerdict: 'PASS',
  pageFetchState: 'SUCCESSFUL',
  crawledAs: 'MOBILE',
  sitemaps: ['https://ex.test/s.xml'],
  referringUrls: ['https://ex.test/r1', 'https://ex.test/r2'],
  referringCount: 31,
  richResults: [
    { type: 'Breadcrumbs', items: [{ name: 'B', errors: 0, warnings: 2, messages: ['m1', 'm2'] }] },
  ],
  status: 'ok',
  error: null,
  fetchedAt: '2026-10-22T00:00:00Z',
  ...over,
});

describe('B38 migration on an old project file', () => {
  it('opens a project from before this module, keeps the row, new columns are NULL', () => {
    oldProject();
    const db = new ProjectDb(file);
    try {
      const { rows } = db.queryGsc({ limit: 10, offset: 0, accountId: 'acc1' });
      const a = rows.find((r) => r.url === 'https://ex.test/a')!;
      expect(a.inspection).toMatchObject({
        verdict: 'PASS',
        coverageState: 'Submitted and indexed',
        richResultsVerdict: 'FAIL',
        status: 'ok',
        fetchedAt: '2026-10-02T00:00:00Z',
      });
      expect(a.inspection!.pageFetchState).toBeNull();
      expect(a.inspection!.crawledAs).toBeNull();
      expect(a.inspection!.sitemaps).toBeNull();
      expect(a.inspection!.referringUrls).toBeNull();
      expect(a.inspection!.referringCount).toBeNull();
      expect(a.inspection!.richResults).toBeNull();
      const detail = db.getUrlAnalytics('https://ex.test/a', { gscAccountId: 'acc1' });
      expect(detail!.inspection!.sitemaps).toBeNull();
    } finally {
      db.close();
    }
    const raw = new DatabaseSync(file);
    const cols = (raw.prepare('PRAGMA table_info(gsc_inspection_results)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    for (const c of NEW_COLUMNS) expect(cols).toContain(c);
    const row = raw.prepare('SELECT * FROM gsc_inspection_results').get() as Record<string, unknown>;
    for (const c of NEW_COLUMNS) expect(row[c]).toBeNull();
    const v = raw.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number };
    expect(v.v).toBeGreaterThanOrEqual(123);
    raw.close();
  });

  it('running the migration twice is a no-op', () => {
    oldProject();
    new ProjectDb(file).close();
    const raw = new DatabaseSync(file);
    const before = (raw.prepare('SELECT COUNT(*) AS c FROM schema_version').get() as { c: number }).c;
    runMigrations(raw);
    expect((raw.prepare('SELECT COUNT(*) AS c FROM schema_version').get() as { c: number }).c).toBe(before);
    // the guarded ALTERs also survive a re-run of the step itself
    raw.exec('DELETE FROM schema_version WHERE version = 123');
    runMigrations(raw);
    expect((raw.prepare('SELECT COUNT(*) AS c FROM gsc_inspection_results').get() as { c: number }).c).toBe(1);
    raw.close();
  });
});

describe('B38 storage round trip', () => {
  it('stores and returns the new fields; an error row stores the five as NULL', () => {
    oldProject();
    const db = new ProjectDb(file);
    try {
      db.upsertGscInspection('https://ex.test/a', result(), 'acc1');
      let a = db.queryGsc({ limit: 10, offset: 0, accountId: 'acc1' }).rows.find((r) => r.url === 'https://ex.test/a')!;
      expect(a.inspection).toMatchObject({
        pageFetchState: 'SUCCESSFUL',
        crawledAs: 'MOBILE',
        sitemaps: ['https://ex.test/s.xml'],
        referringUrls: ['https://ex.test/r1', 'https://ex.test/r2'],
        referringCount: 31,
        richResults: [{ type: 'Breadcrumbs', items: [{ name: 'B', errors: 0, warnings: 2, messages: ['m1', 'm2'] }] }],
      });
      const detail = db.getUrlAnalytics('https://ex.test/a', { gscAccountId: 'acc1' });
      expect(detail!.inspection!.referringCount).toBe(31);
      expect(detail!.inspection!.richResults![0]!.type).toBe('Breadcrumbs');

      db.upsertGscInspection(
        'https://ex.test/a',
        result({
          status: 'error',
          error: 'boom',
          pageFetchState: null,
          crawledAs: null,
          sitemaps: null,
          referringUrls: null,
          referringCount: null,
          richResults: null,
          richResultsVerdict: null,
        }),
        'acc1',
      );
      a = db.queryGsc({ limit: 10, offset: 0, accountId: 'acc1' }).rows.find((r) => r.url === 'https://ex.test/a')!;
      expect(a.inspection!.status).toBe('error');
      expect(a.inspection!.sitemaps).toBeNull();
      expect(a.inspection!.richResults).toBeNull();
    } finally {
      db.close();
    }
    const raw = new DatabaseSync(file);
    const row = raw.prepare('SELECT * FROM gsc_inspection_results').get() as Record<string, unknown>;
    for (const c of NEW_COLUMNS) expect(row[c]).toBeNull();
    raw.close();
  });

  it('stores referring_urls_json as {count, urls} and an empty list as [] not NULL', () => {
    oldProject();
    const db = new ProjectDb(file);
    db.upsertGscInspection('https://ex.test/b', result({ sitemaps: [], referringUrls: [], referringCount: 0, richResults: [] }), 'acc1');
    db.close();
    const raw = new DatabaseSync(file);
    const row = raw
      .prepare("SELECT sitemaps_json, referring_urls_json, rich_results_json FROM gsc_inspection_results WHERE url = 'https://ex.test/b'")
      .get() as Record<string, string>;
    expect(row['sitemaps_json']).toBe('[]');
    expect(JSON.parse(row['referring_urls_json']!)).toEqual({ count: 0, urls: [] });
    expect(row['rich_results_json']).toBe('[]');
    raw.close();
  });
});

describe('B38 preset rich-result-warnings', () => {
  it('lists pages with warnings and no errors; ignores NULL rows; rich-result-invalid is unchanged', () => {
    oldProject(); // /a is an old NULL row
    const db = new ProjectDb(file);
    const item = (errors: number, warnings: number) => ({ name: 'i', errors, warnings, messages: [] });
    db.upsertGscInspection('https://ex.test/b', result({ richResults: [{ type: 'T', items: [item(0, 1)] }] }), 'acc1');
    db.upsertGscInspection(
      'https://ex.test/c',
      result({ richResultsVerdict: 'FAIL', richResults: [{ type: 'T', items: [item(0, 1), item(1, 0)] }] }),
      'acc1',
    );
    const q = (filter: 'rich-result-warnings' | 'rich-result-invalid') =>
      db.queryGsc({ limit: 10, offset: 0, accountId: 'acc1', filter }).rows.map((r) => r.url);
    expect(q('rich-result-warnings')).toEqual(['https://ex.test/b']);
    expect(q('rich-result-invalid').sort()).toEqual(['https://ex.test/a', 'https://ex.test/c']);
    db.close();
  });
});
