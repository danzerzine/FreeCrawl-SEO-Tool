import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProjectDb } from '@freecrawl/db';
import { ISSUE_CATEGORIES } from '@freecrawl/shared-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportIssueInlinks, runBulkExport } from './bulk-export.js';
import { parseExportWhat, runExportItems } from './export-items.js';

let dir: string;
let file: string;
let out: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-rfc-'));
  file = path.join(dir, 'p.seoproject');
  out = path.join(dir, 'out');
  fs.mkdirSync(out);
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec(`
    INSERT INTO urls (id, url, is_external, status_code) VALUES
      (1,'https://ex.com/t1',0,200),(11,'https://ex.com/s11',0,200);
    INSERT INTO links (from_url_id, to_url, anchor, is_internal) VALUES (11,'https://ex.com/t1','x',1);
    INSERT INTO urls_issues (url_id, issue_key) VALUES (1,'issues:duplicate-url-post-norm');
  `);
  raw.close();
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const manifest = (): string => path.join(out, 'manifest.json');
const interruptAt = (name: string) => (line: string) => {
  if (line === `Exporting ${name}…`) throw new Error('interrupted');
};

describe('run manifest marks only a finished run', () => {
  it('a rerun cut short leaves no manifest of the previous run', async () => {
    fs.writeFileSync(manifest(), '{"old":true}\n');
    const db = new ProjectDb(file);
    await expect(
      runExportItems(db, out, [{ kind: 'issues', name: 'issues' }, { kind: 'html', name: 'html' }], {
        onProgress: interruptAt('html'),
      }),
    ).rejects.toThrow('interrupted');
    db.close();
    expect(fs.existsSync(manifest())).toBe(false);
  });

  it('a bulk item writes no manifest of its own before the later items run', async () => {
    const db = new ProjectDb(file);
    let seenBetween: boolean | undefined;
    await runExportItems(db, out, [{ kind: 'bulk', name: 'bulk' }, { kind: 'issues', name: 'issues' }], {
      onProgress: (line) => {
        if (line === 'Exporting issues…') seenBetween = fs.existsSync(manifest());
      },
    });
    db.close();
    expect(seenBetween).toBe(false);
    const m = JSON.parse(fs.readFileSync(manifest(), 'utf8'));
    expect(m.what).toEqual(['bulk', 'issues']);
  });

  it('the desktop bulk export cut short leaves no manifest of the previous run', async () => {
    fs.writeFileSync(manifest(), '{"old":true}\n');
    const db = new ProjectDb(file);
    // Cut the run short once it starts reading the project.
    const cut = new Proxy(db, {
      get: (t, k) => (k === 'getDisabledIssues' ? () => { throw new Error('interrupted'); } : Reflect.get(t, k)),
    });
    await expect(runBulkExport(cut, out)).rejects.toThrow('interrupted');
    db.close();
    expect(fs.existsSync(manifest())).toBe(false);
  });
});

describe('exportIssueInlinks: a failed check keeps its previous file', () => {
  it('keeps the old inlinks CSV and reports the error', async () => {
    const d = new ProjectDb(file);
    d.setDisabledIssues(ISSUE_CATEGORIES.filter((c) => c !== 'issues:duplicate-url-post-norm'));
    d.close();
    const sub = path.join(out, 'issue-inlinks');
    const target = path.join(sub, 'inlinks-duplicate-url-post-norm.csv');
    fs.mkdirSync(path.join(`${target}.part`, 'x'), { recursive: true });
    fs.writeFileSync(target, 'previous good\n');
    const db = new ProjectDb(file);
    const res = await exportIssueInlinks(db, out);
    db.close();
    expect(res.errors.length).toBe(1);
    expect(fs.readFileSync(target, 'utf8')).toBe('previous good\n');
  });
});

describe('B45: --what issues:markup-errors', () => {
  const addMarkupRows = (): void => {
    const raw = new DatabaseSync(file);
    // Inserted out of alphabetical order on purpose: the file keeps the id order.
    raw.exec(`
      INSERT INTO urls (id, url, is_external, content_kind, status_code, markup_errors, markup_codes) VALUES
        (21,'https://ex.com/zzz',0,'html',200,2,'{"duplicate-id":1,"missing-doctype":1}'),
        (22,'https://ex.com/clean',0,'html',200,0,NULL),
        (23,'https://ex.com/aaa',0,'html',200,1,'{"missing-doctype":1}');
    `);
    raw.close();
  };

  it('writes one CSV with exactly the failing URLs, and manifest.json lists it with rows, ms and peakRssMb', async () => {
    addMarkupRows();
    const db = new ProjectDb(file);
    const items = parseExportWhat('issues:markup-errors');
    const res = await runExportItems(db, out, items);
    db.close();
    expect(res.errors).toEqual([]);
    const csv = fs.readFileSync(path.join(out, 'issues-markup-errors.csv'), 'utf8').replace(/^\uFEFF/, '');
    const lines = csv.split('\n').filter(Boolean);
    expect(lines[0]!.split(',')).toEqual([
      'URL', 'Status', 'Type', 'Indexability', 'Indexability Status', 'Title 1', 'Inlinks', 'Outlinks', 'Crawl Depth',
      'Markup Errors', 'Markup Error Codes',
    ]);
    // Unsorted: the id order (zzz before aaa), not alphabetical.
    expect(lines.slice(1).map((l) => l.split(',')[0])).toEqual(['https://ex.com/zzz', 'https://ex.com/aaa']);
    const m = JSON.parse(fs.readFileSync(manifest(), 'utf8')) as {
      what: string[];
      files: { path: string; rows: number; ms: number; peakRssMb: number }[];
    };
    expect(m.what).toEqual(['issues:markup-errors']);
    expect(m.files).toHaveLength(1);
    expect(m.files[0]).toMatchObject({ path: 'issues-markup-errors.csv', rows: 2 });
    expect(Number.isInteger(m.files[0]!.ms)).toBe(true);
    expect(Number.isInteger(m.files[0]!.peakRssMb)).toBe(true);
  });

  it('an interrupted run leaves no manifest', async () => {
    addMarkupRows();
    fs.writeFileSync(manifest(), '{"old":true}\n');
    const db = new ProjectDb(file);
    await expect(
      runExportItems(db, out, parseExportWhat('issues:markup-errors,html'), { onProgress: interruptAt('html') }),
    ).rejects.toThrow('interrupted');
    db.close();
    expect(fs.existsSync(manifest())).toBe(false);
  });
});
