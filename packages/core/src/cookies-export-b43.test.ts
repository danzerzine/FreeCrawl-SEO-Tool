import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ProjectDb } from '@freecrawl/db';
import { EXPORT_DATASET_COLUMNS } from '@freecrawl/shared-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportUrlsToCsv } from './csv-export.js';
import { datasetRows, readCell } from './dataset-export.js';
import { CLI_EXPORT_DATASETS, parseExportWhat, runExportItems } from './export-items.js';

let dir: string;
let file: string;
let out: string;
let db: ProjectDb;

const list = (...c: Array<Record<string, unknown>>): string => JSON.stringify(c);
const cookie = (n: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  n, d: 'www.ex.com', p: '/', s: 1, h: 0, ss: 'Lax', e: -1, by: 'header', ...over,
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b43x-'));
  file = path.join(dir, 'p.seoproject');
  out = path.join(dir, 'out');
  fs.mkdirSync(out);
  db = new ProjectDb(file);
  const put = (u: string, over: Record<string, unknown> = {}) =>
    db.upsertUrl({ url: `https://www.ex.com/${u}`, depth: 0, statusCode: 200, indexability: 'indexable', contentKind: 'html', ...over });
  // zzz first on purpose: rows come out in url_id order, never sorted by URL.
  put('zzz', {
    cookiesTotal: 4,
    cookiesTruncated: 1,
    cookiesJson: list(
      cookie('sid', { h: 1 }),
      cookie('ga', { by: 'script', s: 0, ss: '', e: 1893456000 }),
      cookie('fra', { d: 'ads.tracker.net', by: 'script', s: null, ss: null, e: null }),
      cookie('sub', { d: 'cdn.ex.com' }),
    ),
  });
  put('none', { cookiesTotal: 0, cookiesTruncated: 0, cookiesJson: '[]' });
  put('aaa', { cookiesTotal: 1, cookiesTruncated: 0, cookiesJson: list(cookie('a1', { s: 0, ss: 'None' })) });
  put('unrecorded');
  db.close();
  db = new ProjectDb(file);
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const manifest = (): string => path.join(out, 'manifest.json');

describe('B43 urls CSV columns', () => {
  it('Cookies, Cookies Truncated and Cookies JSON sit right before Crawl Timestamp; rows in id order', async () => {
    const f = path.join(dir, 'a.csv');
    await exportUrlsToCsv(db, f);
    const lines = fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '').split('\n').filter(Boolean);
    const head = lines[0]!.split(',');
    // B136: the ten page-signal columns sit between Unused JS Bytes and Crawl Timestamp.
    expect(head.slice(-19)).toEqual([
      'Markup Error Codes', 'Cookies', 'Cookies Truncated', 'Cookies JSON',
      'CSS Bytes', 'Unused CSS Bytes', 'JS Bytes', 'Unused JS Bytes',
      'Hreflang Outside <head>', 'Title Outside <head>', 'Description Outside <head>',
      'Meta Robots Outside <head>', 'OG Tag Uses name=', 'Internal Link with UTM',
      'Noindex for Other Engines', 'Pagination Loop', 'Hreflang on Non-Canonical Page',
      'Noindex Alternate', 'Crawl Timestamp',
    ]);
    expect(lines[1]).toContain('https://www.ex.com/zzz');
    expect(lines[1]).toContain(',4,1,"[{""n"":""sid""');
    expect(lines[2]).toContain('https://www.ex.com/none');
    expect(lines[2]).toContain(',0,0,[],,,,,');
    expect(lines[3]).toContain('https://www.ex.com/aaa');
    // Never recorded: empty cells, not zeros. B136: the row now ends with the ten
    // page-signal cells before the timestamp. This project has no `checksFilled`, so nine
    // of them are blank; hreflang outside head predates that mechanism and reads `No`.
    expect(lines[4]).toContain('https://www.ex.com/unrecorded');
    expect(lines[4]).toMatch(/,{7},No,{10}[^,]*$/);
  });
});

describe('B43 dataset cookies', () => {
  it('header list as in the spec', () => {
    expect(EXPORT_DATASET_COLUMNS['cookies'].map((c) => c.key)).toEqual([
      'url', 'name', 'domain', 'path', 'secure', 'httpOnly', 'sameSite', 'expires', 'setBy', 'thirdParty', 'pageCookiesTotal', 'pageCookiesTruncated',
    ]);
    expect(EXPORT_DATASET_COLUMNS['cookies'].map((c) => c.header)).toEqual([
      'URL', 'Cookie', 'Domain', 'Path', 'Secure', 'HttpOnly', 'SameSite', 'Expires', 'Set By', 'Third Party', 'Page Cookies Total', 'Page Cookies Truncated',
    ]);
  });

  it('rows come unsorted: page order (url_id), then the order of the page\'s list; third party by registrable domain', () => {
    const rows = [...datasetRows(db, 'cookies', {})].map((r) =>
      EXPORT_DATASET_COLUMNS['cookies'].map((c) => readCell(r, c.key)),
    );
    expect(rows).toEqual([
      ['https://www.ex.com/zzz', 'sid', 'www.ex.com', '/', true, true, 'Lax', 'session', 'header', false, 4, true],
      ['https://www.ex.com/zzz', 'ga', 'www.ex.com', '/', false, false, '', '2030-01-01T00:00:00.000Z', 'script', false, 4, true],
      ['https://www.ex.com/zzz', 'fra', 'ads.tracker.net', '/', null, false, null, null, 'script', true, 4, true],
      ['https://www.ex.com/zzz', 'sub', 'cdn.ex.com', '/', true, false, 'Lax', 'session', 'header', false, 4, true],
      ['https://www.ex.com/aaa', 'a1', 'www.ex.com', '/', false, false, 'None', 'session', 'header', false, 1, false],
    ]);
  });

  it('a cross-site iframe cookie (localhost on a 127.0.0.1 page) is third party', () => {
    const d2 = new ProjectDb(path.join(dir, 'q.seoproject'));
    d2.upsertUrl({
      url: 'http://127.0.0.1:8080/page', depth: 0, statusCode: 200, indexability: 'indexable', contentKind: 'html',
      cookiesTotal: 2, cookiesTruncated: 0, cookiesJson: list(cookie('ga', { d: '127.0.0.1', by: 'script' }), cookie('fra', { d: 'localhost', by: 'script' })),
    });
    const t = [...datasetRows(d2, 'cookies', {})].map((r) => [readCell(r, 'name'), readCell(r, 'thirdParty')]);
    d2.close();
    expect(t).toEqual([['ga', false], ['fra', true]]);
  });

  it('the CLI offers it as --what dataset:cookies', () => {
    expect(CLI_EXPORT_DATASETS).toContain('cookies');
    expect(parseExportWhat('dataset:cookies')).toEqual([{ kind: 'dataset', name: 'dataset:cookies', dataset: 'cookies' }]);
  });
});

describe('B43 export run: manifest', () => {
  it('--what dataset:cookies writes cookies.csv and manifest.json lists it with rows, ms and peakRssMb', async () => {
    const res = await runExportItems(db, out, parseExportWhat('dataset:cookies'));
    expect(res.errors).toEqual([]);
    const csv = fs.readFileSync(path.join(out, 'cookies.csv'), 'utf8').replace(/^\uFEFF/, '');
    const lines = csv.split('\n').filter(Boolean);
    expect(lines[0]).toBe('URL,Cookie,Domain,Path,Secure,HttpOnly,SameSite,Expires,Set By,Third Party,Page Cookies Total,Page Cookies Truncated');
    expect(lines).toHaveLength(6);
    expect(lines[1]!.startsWith('https://www.ex.com/zzz,sid,')).toBe(true);
    const m = JSON.parse(fs.readFileSync(manifest(), 'utf8')) as {
      what: string[];
      files: { path: string; rows: number; ms: number; peakRssMb: number }[];
    };
    expect(m.what).toEqual(['dataset:cookies']);
    expect(m.files).toHaveLength(1);
    expect(m.files[0]).toMatchObject({ path: 'cookies.csv', rows: 5 });
    expect(Number.isInteger(m.files[0]!.ms)).toBe(true);
    expect(Number.isInteger(m.files[0]!.peakRssMb)).toBe(true);
  });

  it('an interrupted run leaves no manifest', async () => {
    fs.writeFileSync(manifest(), '{"old":true}\n');
    await expect(
      runExportItems(db, out, parseExportWhat('dataset:cookies,html'), {
        onProgress: (line) => {
          if (line === 'Exporting html…') throw new Error('interrupted');
        },
      }),
    ).rejects.toThrow('interrupted');
    expect(fs.existsSync(manifest())).toBe(false);
  });

  it('a project without any cookie list: skipped with the "no rows" reason, no file, no error', async () => {
    const empty = new ProjectDb(path.join(dir, 'empty.seoproject'));
    const res = await runExportItems(empty, out, parseExportWhat('dataset:cookies'));
    empty.close();
    expect(res.errors).toEqual([]);
    expect(res.skipped).toEqual([{ label: 'dataset:cookies', reason: 'No rows in this crawl: no file written.' }]);
    expect(fs.existsSync(path.join(out, 'cookies.csv'))).toBe(false);
  });
});
