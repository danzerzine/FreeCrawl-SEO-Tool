import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProjectDb } from '@freecrawl/db';
import { EXPORT_DATASET_COLUMNS } from '@freecrawl/shared-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { datasetRows } from './dataset-export.js';

let dir: string;
let file: string;

const u = (p: string) => `https://ex.com${p}`;
const http = (iso: string) => new Date(iso).toUTCString();
const DATE = http('2026-10-20T10:00:00Z');

interface Row {
  path: string;
  /** undefined = no `urls` row at all. */
  status?: number | null;
  indexability?: string;
  kind?: string;
  external?: boolean;
  /** undefined = not in the sitemap; null = in it without a lastmod. */
  sitemap?: string | null;
  lastModified?: string;
  date?: string;
}

const NOINDEX = 'non-indexable:noindex';

// One row per case of the spec, B61 «Done when» 3.
const CASES: Row[] = [
  { path: '/queued', status: null, indexability: 'indexable', sitemap: '2026-06-01' }, // a
  { path: '/ghost', sitemap: '2026-06-01' }, // b: in the sitemap, no urls row
  { path: '/moved', status: 301, indexability: 'non-indexable:redirect', sitemap: '2026-06-01' }, // c
  { path: '/gone', status: 404, indexability: 'non-indexable:client-error', sitemap: '2026-06-01' }, // d
  { path: '/broken', status: 0, indexability: 'non-indexable:no-response', sitemap: '2026-06-01' }, // d: error
  { path: '/noindex', status: 200, indexability: NOINDEX, sitemap: '2026-06-01' }, // e
  { path: '/crawled', status: 200, indexability: 'indexable' }, // f
  { path: '/hidden', status: 200, indexability: NOINDEX }, // g
  { path: '/nolastmod', status: 200, indexability: 'indexable', sitemap: null }, // h
  { path: '/blank', status: 200, indexability: 'indexable', sitemap: '  ' }, // h
  { path: '/diff3', status: 200, indexability: 'indexable', sitemap: '2026-06-10', lastModified: http('2026-06-07T08:00:00Z'), date: DATE }, // i
  { path: '/diff1', status: 200, indexability: 'indexable', sitemap: '2026-06-08', lastModified: http('2026-06-07T08:00:00Z'), date: DATE }, // j
  // k: differs by 5 days AND is a redirect: the higher verdict wins.
  { path: '/moved-differs', status: 302, indexability: 'non-indexable:redirect', sitemap: '2026-06-12', lastModified: http('2026-06-07T08:00:00Z'), date: DATE },
  { path: '/badlastmod', status: 200, indexability: 'indexable', sitemap: 'next tuesday' }, // l
  { path: '/doc.pdf', status: 200, indexability: 'indexable', kind: 'pdf', sitemap: '2026-06-01' }, // m
  // The server stamps "now": the header is rejected, so no lastmod-differs.
  { path: '/stamped', status: 200, indexability: 'indexable', sitemap: '2026-01-01', lastModified: http('2026-10-20T09:59:50Z'), date: DATE },
  { path: '/plain', status: 200, indexability: 'indexable', sitemap: '2026-06-01' },
  // Not rows: non-HTML not in the sitemap, an external URL.
  { path: '/pic.png', status: 200, indexability: 'indexable', kind: 'image' },
  { path: '/ext', status: 200, indexability: 'indexable', external: true },
];

const EXPECTED: Record<string, [verdict: string, note: string]> = {
  '/queued': ['sitemap-not-fetched', 'queued-or-blocked'],
  '/ghost': ['sitemap-not-fetched', 'not-in-crawl'],
  '/moved': ['redirect-in-sitemap', ''],
  '/gone': ['non-200-in-sitemap', ''],
  '/broken': ['non-200-in-sitemap', ''],
  '/noindex': ['non-indexable-in-sitemap', ''],
  '/crawled': ['crawled-not-in-sitemap', ''],
  '/hidden': ['not-in-sitemap-expected', ''],
  '/nolastmod': ['lastmod-missing', ''],
  '/blank': ['lastmod-missing', ''],
  '/diff3': ['lastmod-differs', ''],
  '/diff1': ['ok', ''],
  '/moved-differs': ['redirect-in-sitemap', ''],
  '/badlastmod': ['lastmod-missing', 'lastmod-unparsable'],
  '/doc.pdf': ['ok', ''],
  '/stamped': ['ok', ''],
  '/plain': ['ok', ''],
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b61r-'));
  file = path.join(dir, 'p.seoproject');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function build(rows: Row[]): ProjectDb {
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  const ins = raw.prepare(
    `INSERT INTO urls (id, url, status_code, indexability, content_kind, is_external, crawled_at)
     VALUES (?, ?, ?, ?, ?, ?, '2026-10-20 10:00:00')`,
  );
  const hdr = raw.prepare('INSERT INTO headers (url_id, name, value) VALUES (?, ?, ?)');
  const sm = raw.prepare('INSERT INTO sitemap_urls (url, lastmod, source_sitemap) VALUES (?, ?, ?)');
  rows.forEach((r, i) => {
    if (r.status !== undefined) {
      ins.run(i + 1, u(r.path), r.status, r.indexability ?? 'indexable', r.kind ?? 'html', r.external ? 1 : 0);
      if (r.lastModified) hdr.run(i + 1, 'last-modified', r.lastModified);
      if (r.date) hdr.run(i + 1, 'date', r.date);
    }
    if (r.sitemap !== undefined) sm.run(u(r.path), r.sitemap, u('/sitemap.xml'));
  });
  raw.close();
  return new ProjectDb(file);
}

const rowsOf = (db: ProjectDb) =>
  [...datasetRows(db, 'sitemap-reconciliation')] as Record<string, unknown>[];

describe('B61 sitemap-reconciliation dataset', () => {
  it('has the defined columns', () => {
    expect(EXPORT_DATASET_COLUMNS['sitemap-reconciliation'].map((c) => c.key)).toEqual([
      'url', 'inCrawl', 'inSitemap', 'statusCode', 'indexability', 'sitemapLastmod',
      'lastModifiedHeader', 'lastmodDiffDays', 'verdict', 'note',
    ]);
  });

  it('one row per URL of the union, with the first matching verdict', () => {
    const db = build(CASES);
    const rows = rowsOf(db);
    db.close();
    const byPath = new Map(rows.map((r) => [(r.url as string).slice('https://ex.com'.length), r]));
    expect([...byPath.keys()].sort()).toEqual(Object.keys(EXPECTED).sort());
    expect(rows).toHaveLength(Object.keys(EXPECTED).length);
    for (const [p, [verdict, note]] of Object.entries(EXPECTED)) {
      expect([p, byPath.get(p)?.verdict, byPath.get(p)?.note]).toEqual([p, verdict, note]);
    }
  });

  it('per-verdict counts from the fixture', () => {
    const db = build(CASES);
    const counts: Record<string, number> = {};
    for (const r of rowsOf(db)) counts[r.verdict as string] = (counts[r.verdict as string] ?? 0) + 1;
    db.close();
    const expected: Record<string, number> = {};
    for (const [verdict] of Object.values(EXPECTED)) expected[verdict] = (expected[verdict] ?? 0) + 1;
    expect(counts).toEqual(expected);
    expect(counts).toEqual({
      'sitemap-not-fetched': 2,
      'redirect-in-sitemap': 2,
      'non-200-in-sitemap': 2,
      'non-indexable-in-sitemap': 1,
      'crawled-not-in-sitemap': 1,
      'not-in-sitemap-expected': 1,
      'lastmod-missing': 3,
      'lastmod-differs': 1,
      ok: 4,
    });
  });

  it('flags and dates: in crawl / in sitemap, guarded header date, whole-day difference', () => {
    const db = build(CASES);
    const by = new Map(rowsOf(db).map((r) => [(r.url as string).slice(14), r]));
    db.close();
    expect(by.get('/ghost')).toMatchObject({ inCrawl: false, inSitemap: true, statusCode: '', indexability: '' });
    expect(by.get('/crawled')).toMatchObject({ inCrawl: true, inSitemap: false, statusCode: 200, sitemapLastmod: '' });
    expect(by.get('/queued')).toMatchObject({ inCrawl: true, inSitemap: true, statusCode: '' });
    expect(by.get('/diff3')).toMatchObject({ sitemapLastmod: '2026-06-10', lastModifiedHeader: '2026-06-07', lastmodDiffDays: 3 });
    expect(by.get('/diff1')).toMatchObject({ lastmodDiffDays: 1 });
    // Rejected header (server stamps "now"): empty, and so no difference either.
    expect(by.get('/stamped')).toMatchObject({ lastModifiedHeader: '', lastmodDiffDays: '' });
    expect(by.get('/doc.pdf')).toMatchObject({ inSitemap: true, inCrawl: true });
  });

  it('a project that read no sitemap has no rows (the item is skipped, not a table of one verdict)', () => {
    const db = build(CASES.filter((r) => r.sitemap === undefined && r.status !== undefined));
    expect(rowsOf(db)).toEqual([]);
    db.close();
  });
});
