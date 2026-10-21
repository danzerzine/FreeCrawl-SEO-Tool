import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProjectDb } from '@freecrawl/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXPORT_DATASET_COLUMNS } from '@freecrawl/shared-types';
import { datasetRows } from './dataset-export.js';
import { exportTabular } from './tabular-export.js';
import { runBulkExport } from './bulk-export.js';

let dir: string;
let file: string;
let db: ProjectDb;
const BIG = 'x'.repeat(40_000);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b15-'));
  file = path.join(dir, 'p.seoproject');
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec(`
    INSERT INTO urls (id, url, status_code, content_type) VALUES
      (1,'https://ex.com/a',200,'text/html'),
      (2,'https://ex.com/b',200,'text/html'),
      (3,'https://ex.com/redir',301,NULL),
      (4,'https://ex.com/no-body',200,'text/html');
  `);
  raw.close();
  db = new ProjectDb(file);
  db.setUrlSource(1, `<html><head><style>p{}</style></head><body><h1>Hello</h1><script>var a=1;</script><p>World ${BIG}</p></body></html>`);
  db.setUrlSource(2, '<html><body><p>Second page</p></body></html>');
  db.setUrlHeaders(1, [['Content-Type', 'text/html'], ['X-Robots-Tag', 'noindex'], ['Set-Cookie', 's=secret']]);
  db.setUrlHeaders(3, [['Location', 'https://ex.com/a']]);
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('B15 headers and page bodies', () => {
  it('response-headers: one row per URL, header name and value', () => {
    const rows = [...datasetRows(db, 'response-headers')].map((r) => [r.url, r.name, r.value]);
    expect(rows).toEqual([
      ['https://ex.com/a', 'content-type', 'text/html'],
      ['https://ex.com/a', 'set-cookie', '[redacted]'],
      ['https://ex.com/a', 'x-robots-tag', 'noindex'],
      ['https://ex.com/redir', 'location', 'https://ex.com/a'],
    ]);
    expect(EXPORT_DATASET_COLUMNS['response-headers'].map((c) => c.key)).toEqual(['url', 'name', 'value']);
  });

  it('page-html: only pages with a stored body, with status and content type', () => {
    const rows = [...datasetRows(db, 'page-html')];
    expect(rows.map((r) => r.url)).toEqual(['https://ex.com/a', 'https://ex.com/b']);
    expect(rows[0]).toMatchObject({ statusCode: 200, contentType: 'text/html' });
    expect(String(rows[0]!.html)).toContain('<h1>Hello</h1>');
  });

  it('page-text: visible text without script and style', () => {
    const rows = [...datasetRows(db, 'page-text')];
    expect(rows.map((r) => r.url)).toEqual(['https://ex.com/a', 'https://ex.com/b']);
    expect(String(rows[0]!.text).startsWith('Hello World')).toBe(true);
    expect(String(rows[0]!.text)).not.toContain('var a');
    expect(String(rows[0]!.text)).not.toContain('p{}');
    expect(rows[1]!.text).toBe('Second page');
  });

  it('jsonl: one JSON object per line, long HTML intact', async () => {
    const out = path.join(dir, 'html.jsonl');
    const res = await exportTabular(db, out, {
      format: 'jsonl',
      sections: [{ label: 'Page HTML', dataset: 'page-html' }],
      columns: EXPORT_DATASET_COLUMNS['page-html'].map((c) => c.key),
    });
    expect(res.rowsWritten).toBe(2);
    const lines = fs.readFileSync(out, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!);
    expect(Object.keys(first)).toEqual(['url', 'statusCode', 'contentType', 'html', 'renderedHtml']);
    expect(first.html.length).toBeGreaterThan(32_767);
  });

  it('writes no file and says why when no body is stored', async () => {
    const raw = new DatabaseSync(file);
    raw.exec('DELETE FROM url_sources');
    raw.close();
    const out = path.join(dir, 'text.jsonl');
    const res = await exportTabular(db, out, {
      format: 'jsonl',
      sections: [{ label: 'Page Text', dataset: 'page-text' }],
      columns: ['url', 'text'],
    });
    expect(res.rowsWritten).toBe(0);
    expect(res.files).toEqual([]);
    expect(fs.existsSync(out)).toBe(false);
    expect(res.skipped?.[0]?.reason).toMatch(/storeBodySnapshots/);
  });

  it('bulk dump holds the headers file but not page HTML or text', async () => {
    const outDir = path.join(dir, 'bulk');
    fs.mkdirSync(outDir);
    await runBulkExport(db, outDir);
    expect(fs.existsSync(path.join(outDir, 'response-headers.csv'))).toBe(true);
    const names = fs.readdirSync(outDir).join(' ');
    expect(names).not.toMatch(/page-html|page-text/);
  });
});
