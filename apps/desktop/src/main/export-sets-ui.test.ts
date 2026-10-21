import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProjectDb } from '@freecrawl/db';
import { deleteExportSet, listExportSets, parseExportWhat, saveExportSet } from '@freecrawl/core';
import { EXPORT_DATASET_COLUMNS } from '@freecrawl/shared-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportSelectedLinks, exportSetChoices, runSavedExportSet } from './export-sets.js';

let dir: string;
let db: ProjectDb;

// A and B are chosen; C, D are not. Links: C->A, D->A, A->B, A->C, B->A, D->C.
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-sets-ui-'));
  const file = path.join(dir, 'p.seoproject');
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec(`
    INSERT INTO urls (id, url, status_code, content_type) VALUES
      (1,'https://ex.com/a',200,'text/html'),(2,'https://ex.com/b',200,'text/html'),
      (3,'https://ex.com/c',200,'text/html'),(4,'https://ex.com/d',404,'text/html');
    INSERT INTO links (from_url_id, to_url, anchor, is_internal) VALUES
      (3,'https://ex.com/a','c-a',1),(4,'https://ex.com/a','d-a',1),
      (1,'https://ex.com/b','a-b',1),(1,'https://ex.com/c','a-c',1),
      (2,'https://ex.com/a','b-a',1),(2,'https://ex.com/d','b-d',1),(4,'https://ex.com/c','d-c',1);
  `);
  raw.close();
  db = new ProjectDb(file);
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const csvLines = (f: string): string[] =>
  fs.readFileSync(f, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.length > 0);

describe('export set choices (B14)', () => {
  it('offers every --what kind, and every offered token is valid', () => {
    const groups = exportSetChoices();
    const tokens = groups.flatMap((g) => g.choices.map((c) => c.token));
    expect(() => parseExportWhat(tokens.join(','))).not.toThrow();
    for (const t of ['bulk', 'seo-audit', 'html', 'issues', 'tab:redirects', 'dataset:broken-links',
      'error-inlinks', 'redirects-to-error', 'non-indexable-inlinks', 'redirect-inlinks']) {
      expect(tokens).toContain(t);
    }
    expect(tokens.some((t) => t.startsWith('issues:'))).toBe(true);
    expect(tokens.some((t) => t.startsWith('issue-inlinks:'))).toBe(true);
    expect(tokens.some((t) => t.startsWith('dataset:selected-'))).toBe(false);
    expect(new Set(tokens).size).toBe(tokens.length);
  });
});

describe('deleteExportSet (B14)', () => {
  it('removes only the named set; a missing name is false', () => {
    saveExportSet(db, { name: 'a', what: ['issues'] });
    saveExportSet(db, { name: 'b', what: ['bulk'], rawHeaders: true });
    expect(deleteExportSet(db, ' a ')).toBe(true);
    expect(listExportSets(db)).toEqual([{ name: 'b', what: ['bulk'], rawHeaders: true }]);
    expect(deleteExportSet(db, 'a')).toBe(false);
    expect(listExportSets(db).map((s) => s.name)).toEqual(['b']);
  });
});

describe('runSavedExportSet (B14)', () => {
  it('writes the set by name, with its raw-headers option', async () => {
    saveExportSet(db, { name: 'weekly', what: ['issues', 'error-inlinks'], rawHeaders: true });
    const out = path.join(dir, 'out');
    fs.mkdirSync(out);
    const r = await runSavedExportSet(db, out, 'weekly', { toolVersion: 't' });
    expect(r.errors).toEqual([]);
    expect(r.files.map((f) => path.basename(f.path)).sort()).toEqual(['error-inlinks.csv', 'issues-summary.csv']);
    expect(csvLines(path.join(out, 'issues-summary.csv'))[0]).not.toContain(' ');
    expect(fs.existsSync(path.join(out, 'manifest.json'))).toBe(true);
  });

  it('an unknown name throws and writes nothing', async () => {
    const out = path.join(dir, 'none');
    fs.mkdirSync(out);
    await expect(runSavedExportSet(db, out, 'nope', {})).rejects.toThrow(/No export set named "nope"/);
    expect(fs.readdirSync(out)).toEqual([]);
  });
});

describe('exportSelectedLinks (B16)', () => {
  it('writes the inlinks and outlinks of the chosen URLs only, with the tab columns', async () => {
    const out = path.join(dir, 'links');
    fs.mkdirSync(out);
    const r = await exportSelectedLinks(db, out, ['https://ex.com/a', 'https://ex.com/b'], {});
    expect(r.errors).toEqual([]);
    const inl = csvLines(path.join(out, 'selected-inlinks.csv'));
    const outl = csvLines(path.join(out, 'selected-outlinks.csv'));
    expect(inl[0]).toBe(EXPORT_DATASET_COLUMNS['selected-inlinks'].map((c) => c.header).join(','));
    expect(outl[0]).toBe(EXPORT_DATASET_COLUMNS['selected-outlinks'].map((c) => c.header).join(','));
    expect(inl.length - 1).toBe(4); // c->a, d->a, a->b, b->a
    expect(outl.length - 1).toBe(4); // a->b, a->c, b->a, b->d
    expect(r.files.map((f) => [path.basename(f.path), f.rows])).toEqual([
      ['selected-inlinks.csv', 4],
      ['selected-outlinks.csv', 4],
    ]);
  });
});
