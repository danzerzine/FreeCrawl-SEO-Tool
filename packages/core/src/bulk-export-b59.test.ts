import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProjectDb } from '@freecrawl/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BULK_EXPORT_TASKS, runBulkExport } from './bulk-export.js';

let dir: string;
let db: ProjectDb;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b59-'));
  const file = path.join(dir, 'p.seoproject');
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec(`INSERT INTO urls (id, url, is_external, status_code) VALUES
    (1,'https://ex.com/a',0,200),(2,'https://ex.com/b',0,404);`);
  raw.close();
  db = new ProjectDb(file);
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('B59 bulk export', () => {
  it('lists every category once', () => {
    const seen = new Map<string, number>();
    for (const t of BULK_EXPORT_TASKS) seen.set(t.category, (seen.get(t.category) ?? 0) + 1);
    expect([...seen].filter(([, n]) => n > 1).map(([c]) => c)).toEqual([]);
    const files = BULK_EXPORT_TASKS.map((t) => t.file);
    expect(new Set(files).size).toBe(files.length);
  });

  it('writes manifest.json last, with relative paths, rows, times, version', async () => {
    const out = path.join(dir, 'out');
    const r = await runBulkExport(db, out, { toolVersion: '9.9.9', projectFile: '/x/p.seoproject' });
    const m = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
    expect(m.toolVersion).toBe('9.9.9');
    expect(m.projectFile).toBe('/x/p.seoproject');
    expect(Date.parse(m.startedAt)).toBeLessThanOrEqual(Date.parse(m.finishedAt));
    expect(m.files.length).toBe(r.files.length);
    expect(m.files.length).toBeGreaterThan(0);
    const all = m.files.find((f: { path: string }) => f.path === 'all-urls.csv');
    expect(all).toMatchObject({ label: 'All URLs', rows: 2 });
    expect(fs.existsSync(path.join(out, 'manifest.json.part'))).toBe(false);
  });

  it('headers keys reach the bulk files', async () => {
    const out = path.join(dir, 'raw');
    await runBulkExport(db, out, { headers: 'keys' });
    const head = fs.readFileSync(path.join(out, 'all-urls.csv'), 'utf8').replace(/^﻿/, '').split('\n')[0]!;
    expect(head.split(',')[0]).toBe('url');
  });

  it('narrowed runs write no manifest', async () => {
    const out = path.join(dir, 'n');
    await runBulkExport(db, out, { tasks: BULK_EXPORT_TASKS.slice(0, 1) });
    expect(fs.existsSync(path.join(out, 'manifest.json'))).toBe(false);
  });
});

import { exportUrlsToCsv, exportBrokenLinksToCsv, exportImagesToCsv } from './csv-export.js';
import { exportUrlsToJson } from './json-export.js';
import { exportUrlsToXml } from './xml-export.js';
import { exportGrid, exportTabular } from './tabular-export.js';
import { exportSitemap } from './sitemap-export.js';

describe('B59 single-file exports go through .part', () => {
  const noPart = (d: string) =>
    fs.readdirSync(d, { recursive: true }).filter((f) => String(f).endsWith('.part'));

  it('every writer creates the directory and leaves no .part', async () => {
    const d = path.join(dir, 'deep', 'er');
    await exportUrlsToCsv(db, path.join(d, 'a.csv'));
    await exportUrlsToJson(db, path.join(d, 'a.json'));
    await exportUrlsToXml(db, path.join(d, 'a.xml'));
    await exportBrokenLinksToCsv(db, path.join(d, 'b.csv'), { internal: 'all' });
    await exportImagesToCsv(db, path.join(d, 'i.csv'), {});
    await exportSitemap(db, path.join(d, 's.xml'));
    await exportGrid(path.join(d, 'g.xlsx'), { format: 'xlsx', headers: ['a'], rows: [[1]] });
    await exportTabular(db, path.join(d, 't.xlsx'), {
      format: 'xlsx', columns: ['url'], sections: [{ label: 'All', category: 'all' }],
    });
    await exportTabular(db, path.join(d, 'multi'), {
      format: 'csv', columns: ['url'],
      sections: [{ label: 'A', category: 'all' }, { label: 'B', category: 'all' }],
    });
    expect(fs.readdirSync(d).length).toBeGreaterThanOrEqual(8);
    expect(noPart(d)).toEqual([]);
  });

  it('a failed write keeps the earlier file and leaves no .part', async () => {
    const f = path.join(dir, 'g.csv');
    await exportGrid(f, { format: 'csv', headers: ['a'], rows: [[1]] });
    const before = fs.readFileSync(f, 'utf8');
    const bad = { *[Symbol.iterator]() { yield [2]; throw new Error('boom'); } };
    await expect(
      exportGrid(f, { format: 'csv', headers: ['a'], rows: bad as unknown as unknown[][] }),
    ).rejects.toThrow('boom');
    expect(fs.readFileSync(f, 'utf8')).toBe(before);
    expect(noPart(dir)).toEqual([]);
  });
});

describe('B36 structured-data export', () => {
  it('names the missing required properties in the missing-required file', async () => {
    const file = path.join(dir, 'p.seoproject');
    db.close();
    const raw = new DatabaseSync(file);
    const finding = { block: 0, type: 'Restaurant', kind: 'missing-required', props: ['address'] };
    raw
      .prepare(
        `UPDATE urls SET content_kind = 'html', schema_missing_required = 1, schema_findings = ? WHERE id = 1`,
      )
      .run(JSON.stringify([finding]));
    raw.close();
    db = new ProjectDb(file);
    const out = path.join(dir, 'sd');
    const task = BULK_EXPORT_TASKS.filter((t) => t.file === 'structured-data-missing-required.csv');
    await runBulkExport(db, out, { tasks: task, headers: 'keys' });
    const [head, row] = fs
      .readFileSync(path.join(out, 'structured-data-missing-required.csv'), 'utf8')
      .replace(/^\uFEFF/, '')
      .split('\n');
    expect(head!.split(',')).toContain('schemaFindings');
    expect(row).toContain('address');
  });
});
