import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProjectDb, LATER_CHECKS } from '@freecrawl/db';
import {
  EXPORT_DATASET_COLUMNS,
  ISSUE_CATEGORIES,
  PAGE_SIGNAL_CHECKS,
  SIGNAL_CHECKS_ALWAYS_FILLED,
  URL_SIGNAL_CHECKS,
  YES_NO_URL_COLUMNS,
  URL_COLUMN_HEADERS,
  isExportDatasetKey,
  urlSignalCell,
  type CrawlUrlRow,
} from '@freecrawl/shared-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BULK_EXPORT_DATASET_TASKS, BULK_EXPORT_TASKS, runBulkExport } from './bulk-export.js';
import { exportUrlsToCsv, urlCsvFormat } from './csv-export.js';
import { datasetRows } from './dataset-export.js';
import { parseExportWhat, runExportItems } from './export-items.js';
import { exportTabular } from './tabular-export.js';
import { m5ColumnsNotChecked } from './url-signals.js';
import { exportUrlsToXml } from './xml-export.js';

const NEW_HEADERS = [
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
];
const NEW_KEYS = [
  'hreflangOutsideHead',
  'titleOutsideHead',
  'descriptionOutsideHead',
  'metaRobotsOutsideHead',
  'ogNameAttr',
  'internalUtmLinks',
  'metaNoindexBots',
  'paginationLoop',
  'hreflangNotCanonical',
  'hreflangNoindexTargets',
];

let dir: string;
let file: string;
let db: ProjectDb;

const FULL_FILLED = JSON.stringify(LATER_CHECKS);

/** Pages: 1 head tags, 2 og/utm/bots, 3 pagination + hreflang flags + AMP, 4 clean, 5 404 with defects, 6 external. */
function build(filled: boolean): void {
  file = path.join(dir, `p-${filled ? 'new' : 'old'}.seoproject`);
  const first = new ProjectDb(file);
  const put = (u: string, over: Record<string, unknown> = {}): void => {
    first.upsertUrl({
      url: `https://ex.com/${u}`,
      depth: 0,
      statusCode: 200,
      indexability: 'indexable',
      contentKind: 'html',
      h2Count: 1,
      h2First: `H2 of ${u}`,
      ...over,
    });
  };
  put('head', {
    hreflangOutsideHead: 1,
    titleOutsideHead: 2,
    descriptionOutsideHead: 1,
    metaRobotsOutsideHead: 3,
    h2First: 'Same',
  });
  put('og', { ogNameAttr: 1, internalUtmLinks: 4, metaNoindexBots: 'bingbot,yandex', h2First: 'Same' });
  put('pag', { amphtml: 'https://ex.com/amp-pag' });
  put('clean');
  put('gone', { statusCode: 404, titleOutsideHead: 5, ogNameAttr: 1, h2Count: 0, h2First: null });
  put('ext', { titleOutsideHead: 1 });
  if (filled) first.setMeta('checksFilled', FULL_FILLED);
  first.close();
  const raw = new DatabaseSync(file);
  raw.exec(`UPDATE urls SET is_external = 1 WHERE url = 'https://ex.com/ext';
    UPDATE urls SET pagination_loop = 1, hreflang_not_canonical = 1, hreflang_noindex_targets = 2
      WHERE url = 'https://ex.com/pag';
    UPDATE urls SET pagination_loop = 1 WHERE url = 'https://ex.com/gone';
    INSERT INTO amp_targets (url, status_code, redirect_target, error, blocked)
      VALUES ('https://ex.com/amp-pag', 404, NULL, NULL, 0);`);
  raw.close();
  db = new ProjectDb(file);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b136-'));
  build(true);
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** One CSV line to cells ("" quoting). */
function splitLine(line: string): string[] {
  const cells: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      cells.push(cur);
      cur = '';
    } else cur += ch;
  }
  cells.push(cur);
  return cells;
}
const readCsv = (f: string): string[][] =>
  fs
    .readFileSync(f, 'utf8')
    .replace(/^\uFEFF/, '')
    .split('\n')
    .filter(Boolean)
    .map(splitLine);

/** Cells of the ten signal columns of each page, keyed by URL path. */
async function signalCells(opts: { headers?: 'labels' | 'keys' } = {}): Promise<Record<string, string[]>> {
  const f = path.join(dir, `urls-${opts.headers ?? 'labels'}.csv`);
  await exportUrlsToCsv(db, f, opts);
  const [head, ...rows] = readCsv(f);
  const idx = (opts.headers === 'keys' ? NEW_KEYS : NEW_HEADERS).map((h) => head!.indexOf(h));
  return Object.fromEntries(rows.map((r) => [r[0]!.replace('https://ex.com/', ''), idx.map((i) => r[i]!)]));
}

describe('B136 shared definitions', () => {
  it('every Yes/No column has a header and a check; the checks match LATER_CHECKS', () => {
    expect([...YES_NO_URL_COLUMNS]).toEqual(NEW_KEYS);
    for (const k of YES_NO_URL_COLUMNS) {
      expect(URL_COLUMN_HEADERS).toHaveProperty(k);
      expect(ISSUE_CATEGORIES).toContain(URL_SIGNAL_CHECKS[k]);
    }
    expect(YES_NO_URL_COLUMNS.map((k) => URL_COLUMN_HEADERS[k as keyof typeof URL_COLUMN_HEADERS])).toEqual(NEW_HEADERS);
    // The checks not in LATER_CHECKS are exactly the always-filled ones.
    const later = new Set<string>(LATER_CHECKS);
    expect(PAGE_SIGNAL_CHECKS.filter((c) => !later.has(c)).sort()).toEqual([...SIGNAL_CHECKS_ALWAYS_FILLED].sort());
  });

  it('PAGE_SIGNAL_CHECKS: 18 checks in ISSUE_CATEGORIES order', () => {
    expect(PAGE_SIGNAL_CHECKS).toHaveLength(18);
    const order = PAGE_SIGNAL_CHECKS.map((c) => ISSUE_CATEGORIES.indexOf(c));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order).not.toContain(-1);
  });

  it('urlSignalCell: Yes/No in labels mode, raw in machine mode, blank when not checked', () => {
    const row = { isExternal: false, contentKind: 'html', statusCode: 200, titleOutsideHead: 2, internalUtmLinks: 0, metaNoindexBots: 'bingbot' } as unknown as CrawlUrlRow;
    expect(urlSignalCell(row, 'titleOutsideHead', 'labels')).toBe('Yes');
    expect(urlSignalCell(row, 'internalUtmLinks', 'labels')).toBe('No');
    expect(urlSignalCell(row, 'metaNoindexBots', 'labels')).toBe('Yes');
    expect(urlSignalCell(row, 'titleOutsideHead', 'machine')).toBe(2);
    expect(urlSignalCell(row, 'titleOutsideHead', 'labels', new Set(['titleOutsideHead']))).toBeNull();
    expect(urlSignalCell({ ...row, statusCode: 404 }, 'titleOutsideHead', 'labels')).toBeNull();
    expect(urlSignalCell({ ...row, isExternal: true }, 'titleOutsideHead', 'machine')).toBeNull();
    expect(urlSignalCell({ ...row, contentKind: 'image' }, 'titleOutsideHead', 'labels')).toBeNull();
  });

  it('page-signals is a dataset key with URL, Signal, Detail', () => {
    expect(isExportDatasetKey('page-signals')).toBe(true);
    expect(EXPORT_DATASET_COLUMNS['page-signals'].map((c) => c.header)).toEqual(['URL', 'Signal', 'Detail']);
    expect(EXPORT_DATASET_COLUMNS['page-signals'].map((c) => c.key)).toEqual(['url', 'signal', 'detail']);
  });
});

describe('B136 mapper', () => {
  it('the three post-crawl flags reach CrawlUrlRow', () => {
    const row = [...db.iterateAllUrls()].find((r) => r.url.endsWith('/pag'))!;
    expect(row.paginationLoop).toBe(1);
    expect(row.hreflangNotCanonical).toBe(1);
    expect(row.hreflangNoindexTargets).toBe(2);
    const clean = [...db.iterateAllUrls()].find((r) => r.url.endsWith('/clean'))!;
    expect([clean.paginationLoop, clean.hreflangNotCanonical, clean.hreflangNoindexTargets]).toEqual([0, 0, 0]);
  });
});

describe('B136 URL CSV columns', () => {
  it('the ten headers sit before Crawl Timestamp, which stays last', async () => {
    const f = path.join(dir, 'a.csv');
    await exportUrlsToCsv(db, f);
    const head = readCsv(f)[0]!;
    expect(head.slice(-11)).toEqual([...NEW_HEADERS, 'Crawl Timestamp']);
    expect(head.slice(-15, -11)).toEqual(['CSS Bytes', 'Unused CSS Bytes', 'JS Bytes', 'Unused JS Bytes']);
  });

  it('labels mode: Yes/No; external and non-2xx pages are blank', async () => {
    const c = await signalCells();
    expect(c['head']).toEqual(['Yes', 'Yes', 'Yes', 'Yes', 'No', 'No', 'No', 'No', 'No', 'No']);
    expect(c['og']).toEqual(['No', 'No', 'No', 'No', 'Yes', 'Yes', 'Yes', 'No', 'No', 'No']);
    expect(c['pag']).toEqual(['No', 'No', 'No', 'No', 'No', 'No', 'No', 'Yes', 'Yes', 'Yes']);
    expect(c['clean']).toEqual(Array(10).fill('No'));
    expect(c['gone']).toEqual(Array(10).fill(''));
    expect(c['ext']).toEqual(Array(10).fill(''));
  });

  it('keys mode keeps raw values', async () => {
    const c = await signalCells({ headers: 'keys' });
    expect(c['head']).toEqual(['1', '2', '1', '3', '0', '0', '', '0', '0', '0']);
    expect(c['og']![5]).toBe('4');
    expect(c['og']![6]).toBe('bingbot,yandex');
    expect(c['pag']![9]).toBe('2');
    expect(c['gone']).toEqual(Array(10).fill(''));
  });

  it('an old project (no checksFilled) is blank where the check is a later one, Yes/No for the rest', async () => {
    db.close();
    build(false);
    const c = await signalCells();
    // hreflang-outside-head predates the mechanism; the other nine are LATER_CHECKS.
    expect(c['head']).toEqual(['Yes', ...Array(9).fill('')]);
    expect(c['clean']).toEqual(['No', ...Array(9).fill('')]);
    expect(m5ColumnsNotChecked(db).size).toBe(9);
    expect(m5ColumnsNotChecked(db).has('hreflangOutsideHead')).toBe(false);
  });

  it('a filled project blanks nothing', () => {
    expect(m5ColumnsNotChecked(db).size).toBe(0);
  });

  it('urlCsvFormat blanks the columns it is given as not checked', () => {
    const { line } = urlCsvFormat({ columns: ['url', 'titleOutsideHead'], notChecked: new Set(['titleOutsideHead']) });
    const row = [...db.iterateAllUrls()][0]!;
    expect(line(row)).toBe('https://ex.com/head,\n');
  });
});

describe('B136 other writers blank unfilled checks with no option passed', () => {
  it('XML: raw values appended, null as a self-closing tag', async () => {
    const f = path.join(dir, 'a.xml');
    await exportUrlsToXml(db, f);
    const xml = fs.readFileSync(f, 'utf8');
    expect(xml).toMatch(/<hreflangOutsideHead>1<\/hreflangOutsideHead>/);
    expect(xml).toMatch(/<titleOutsideHead>2<\/titleOutsideHead>/);
    expect(xml).toMatch(/<metaNoindexBots>bingbot,yandex<\/metaNoindexBots>/);
    expect(xml).toMatch(/<paginationLoop>1<\/paginationLoop>/);
    // The 404 page: all ten self-closing.
    const gone = xml.split('\n').find((l) => l.includes('ex.com/gone<'))!;
    for (const k of NEW_KEYS) expect(gone).toContain(`<${k}/>`);
    db.close();
    build(false);
    const g = path.join(dir, 'b.xml');
    await exportUrlsToXml(db, g);
    const old = fs.readFileSync(g, 'utf8');
    expect(old).toMatch(/<titleOutsideHead\/>/);
    expect(old).not.toMatch(/<titleOutsideHead>/);
    expect(old).toMatch(/<hreflangOutsideHead>1<\/hreflangOutsideHead>/);
  });

  it('exportTabular: Yes/No in labels CSV, raw in keys CSV and JSON, blank on an old project', async () => {
    const cols = ['url', 'titleOutsideHead', 'metaNoindexBots'];
    const labels = path.join(dir, 't1.csv');
    await exportTabular(db, labels, { format: 'csv', sections: [{ label: 'x', category: 'all' }], columns: cols });
    expect(readCsv(labels).map((r) => r.slice(0, 2).join(','))).toContain('https://ex.com/head,Yes');
    expect(readCsv(labels).map((r) => r.slice(0, 2).join(','))).toContain('https://ex.com/clean,No');
    const keys = path.join(dir, 't2.csv');
    await exportTabular(db, keys, { format: 'csv', headers: 'keys', sections: [{ label: 'x', category: 'all' }], columns: cols });
    expect(readCsv(keys).map((r) => r.slice(0, 2).join(','))).toContain('https://ex.com/head,2');
    const json = path.join(dir, 't3.json');
    await exportTabular(db, json, { format: 'json', sections: [{ label: 'x', category: 'all' }], columns: cols });
    const parsed = JSON.parse(fs.readFileSync(json, 'utf8')) as Record<string, unknown>[];
    expect(parsed.find((r) => r.url === 'https://ex.com/head')!.titleOutsideHead).toBe(2);
    expect(parsed.find((r) => r.url === 'https://ex.com/gone')!.titleOutsideHead).toBeNull();
    db.close();
    build(false);
    const old = path.join(dir, 't4.csv');
    await exportTabular(db, old, { format: 'csv', sections: [{ label: 'x', category: 'all' }], columns: cols });
    expect(readCsv(old).map((r) => r.slice(0, 2).join(','))).toContain('https://ex.com/head,');
  });
});

describe('B136 bulk export', () => {
  it('all-urls.csv has the ten columns, a task with its own columns does not; manifest lists page-signals.csv', async () => {
    const out = path.join(dir, 'out');
    await runBulkExport(db, out, {});
    const head = readCsv(path.join(out, 'all-urls.csv'))[0]!;
    expect(head.slice(-11)).toEqual([...NEW_HEADERS, 'Crawl Timestamp']);
    const own = BULK_EXPORT_TASKS.find((t) => t.columns && fs.existsSync(path.join(out, t.file)))!;
    expect(readCsv(path.join(out, own.file))[0]).not.toContain('Title Outside <head>');
    expect(BULK_EXPORT_DATASET_TASKS.map((t) => t.dataset)).toContain('page-signals');
    const m = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8')) as { files: Record<string, unknown>[] };
    const ps = m.files.find((f) => f.path === 'page-signals.csv')!;
    expect(ps.label).toBe('Page Signals — One Row Per URL and Signal');
    expect(ps.rows).toBeGreaterThan(0);
    expect(typeof ps.peakRssMb).toBe('number');
    expect(ps.warnings).toBeUndefined();
  });

  it('an old project still gets the file (six un-gated checks) with the unfilled checks as a warning', async () => {
    db.close();
    build(false);
    const out = path.join(dir, 'out-old');
    const r = await runBulkExport(db, out, {});
    const lines = readCsv(path.join(out, 'page-signals.csv'));
    expect(lines.length).toBeGreaterThan(1);
    const kinds = new Set(lines.slice(1).map((l) => l[1]));
    for (const k of kinds) expect(SIGNAL_CHECKS_ALWAYS_FILLED).toContain(k);
    const f = r.files.find((x) => x.label.startsWith('Page Signals'))!;
    expect(f.warnings!.join(' ')).toContain('issues:title-outside-head');
    const m = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8')) as { files: { path: string; warnings?: string[] }[] };
    expect(m.files.find((x) => x.path === 'page-signals.csv')!.warnings).toBeDefined();
  });

  it('no file and reason (a) on a pre-M5 project with nothing from the six; reason (b) on a checked one', async () => {
    const empty = (filled: boolean): string => {
      const f = path.join(dir, `e-${filled}.seoproject`);
      const e = new ProjectDb(f);
      e.upsertUrl({ url: 'https://ex.com/', depth: 0, statusCode: 200, indexability: 'indexable', contentKind: 'html', h2Count: 1, h2First: 'x' });
      if (filled) e.setMeta('checksFilled', FULL_FILLED);
      e.close();
      return f;
    };
    for (const [filled, text] of [
      [false, 'crawled by a build before module 5'],
      [true, 'No page has any of these signals.'],
    ] as const) {
      const e = new ProjectDb(empty(filled));
      const out = path.join(dir, `o-${filled}`);
      const r = await runBulkExport(e, out, {});
      e.close();
      expect(fs.existsSync(path.join(out, 'page-signals.csv'))).toBe(false);
      expect(r.skipped!.find((s) => s.label.startsWith('Page Signals'))!.reason).toContain(text);
    }
  });
});

describe('B136 page-signals dataset', () => {
  const rows = (): { url: string; signal: string; detail: string }[] =>
    [...datasetRows(db, 'page-signals')] as { url: string; signal: string; detail: string }[];

  it('rows per signal equal the check filter counts; sidebar order, then crawl order', () => {
    const r = rows();
    for (const check of PAGE_SIGNAL_CHECKS) {
      expect(r.filter((x) => x.signal === check).length, check).toBe(db.urlIdsByCategory(check).length);
    }
    const sig = r.map((x) => PAGE_SIGNAL_CHECKS.indexOf(x.signal as never));
    expect(sig).toEqual([...sig].sort((a, b) => a - b));
    const titles = r.filter((x) => x.signal === 'issues:title-outside-head');
    expect(titles.map((x) => x.url)).toEqual(['https://ex.com/head']);
  });

  it('detail: counts, bot list, repeated H2, AMP probe answer; empty otherwise', () => {
    const r = rows();
    const d = (signal: string, u: string): string | undefined =>
      r.find((x) => x.signal === signal && x.url === `https://ex.com/${u}`)?.detail;
    expect(d('issues:title-outside-head', 'head')).toBe('2');
    expect(d('issues:meta-robots-outside-head', 'head')).toBe('3');
    expect(d('issues:link-utm-internal', 'og')).toBe('4');
    expect(d('issues:noindex-other-bot', 'og')).toBe('bingbot,yandex');
    expect(d('issues:hreflang-noindex-target', 'pag')).toBe('2');
    expect(d('issues:h2-duplicate', 'head')).toBe('Same');
    expect(d('issues:h2-duplicate', 'og')).toBe('Same');
    expect(d('issues:amp-target-broken', 'pag')).toContain('404');
    expect(d('issues:og-name-attribute', 'og')).toBe('');
    expect(d('issues:pagination-loop', 'pag')).toBe('');
  });

  it('the 404 page has no finding row, the external row neither', () => {
    const urls = new Set(rows().map((x) => x.url));
    expect(urls.has('https://ex.com/gone')).toBe(false);
    expect(urls.has('https://ex.com/ext')).toBe(false);
    expect(urls.has('https://ex.com/clean')).toBe(false);
  });

  it('a silenced check gives no rows', () => {
    db.setDisabledIssues(['issues:title-outside-head']);
    expect(rows().some((x) => x.signal === 'issues:title-outside-head')).toBe(false);
    expect(rows().some((x) => x.signal === 'issues:og-name-attribute')).toBe(true);
  });

  it('an Error list fails the dataset, an unfilled later check gives no rows', async () => {
    db.close();
    build(false);
    const r = rows();
    const later = new Set<string>(LATER_CHECKS);
    expect(r.length).toBeGreaterThan(0);
    for (const x of r) expect(later.has(x.signal)).toBe(false);
  });

  it('20 000 flagged pages stream without the map of every URL', () => {
    const raw = new DatabaseSync(file);
    raw.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20000)
      INSERT INTO urls (url, is_external, status_code, content_kind, h2_count, h2_first, og_name_attr)
      SELECT 'https://ex.com/bulk/' || i, 0, 200, 'html', 1, 'h' || i, 1 FROM n;`);
    raw.close();
    db.close();
    db = new ProjectDb(file);
    const spy = vi.spyOn(DatabaseSync.prototype, 'prepare');
    try {
      const n = rows().filter((x) => x.signal === 'issues:og-name-attribute').length;
      expect(n).toBe(20_001);
      expect(spy.mock.calls.some(([sql]) => /SELECT id, url FROM urls\b/.test(String(sql)))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('B136 CLI wiring in core', () => {
  it('--what dataset:page-signals parses; a bad key lists page-signals', () => {
    expect(parseExportWhat('dataset:page-signals')).toEqual([
      { kind: 'dataset', name: 'dataset:page-signals', dataset: 'page-signals' },
    ]);
    expect(() => parseExportWhat('dataset:nope')).toThrow(/page-signals/);
  });

  it('single-dataset run writes page-signals.csv with the warnings of an old project, and reasons when empty', async () => {
    const out = path.join(dir, 'cli');
    fs.mkdirSync(out);
    const o = await runExportItems(db, out, parseExportWhat('dataset:page-signals'));
    expect(readCsv(path.join(out, 'page-signals.csv'))[0]).toEqual(['URL', 'Signal', 'Detail']);
    expect(o.files[0]!.rows).toBeGreaterThan(0);
    expect(o.files[0]!.warnings).toBeUndefined();
    db.close();
    build(false);
    const out2 = path.join(dir, 'cli2');
    fs.mkdirSync(out2);
    const o2 = await runExportItems(db, out2, parseExportWhat('dataset:page-signals'));
    expect(o2.files[0]!.warnings!.join(' ')).toContain('issues:title-outside-head');
  });
});
