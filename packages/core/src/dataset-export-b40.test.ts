import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProjectDb } from '@freecrawl/db';
import { EXPORT_DATASET_COLUMNS, type AxeAudit } from '@freecrawl/shared-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { datasetRows, readCell } from './dataset-export.js';
import { CLI_EXPORT_DATASETS } from './export-items.js';

const A = 'https://ex.test/a';
const B = 'https://ex.test/b';

const audit: AxeAudit = {
  version: '4.14.0',
  violations: [
    {
      id: 'image-alt', impact: 'critical', help: 'Images must have alternative text',
      helpUrl: 'https://dequeuniversity.com/rules/axe/4.14/image-alt', tags: ['wcag2a', 'wcag111'], nodes: 3,
      samples: [{ target: 'img.hero', html: '<img class="hero" src="a.png">', summary: 'Fix any of the following' }, { target: 'img.b', html: '<img>', summary: 's' }],
    },
  ],
  incomplete: [
    {
      id: 'color-contrast', impact: 'serious', help: 'Elements must meet contrast', helpUrl: 'https://x/cc',
      tags: ['wcag2aa'], nodes: 1, samples: [],
    },
  ],
  violationsTotal: 1,
  seriousTotal: 1,
};

let dir: string;
let db: ProjectDb;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b40x-'));
  const file = path.join(dir, 'p.seoproject');
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec(`INSERT INTO urls (id, url, is_external, content_kind, status_code) VALUES (1,'${A}',0,'html',200), (2,'${B}',0,'html',200)`);
  raw.close();
  db = new ProjectDb(file);
  db.setUrlAxe(1, audit);
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('B40 R14: dataset axe-violations', () => {
  it('has the columns of the spec, one row per page x rule', () => {
    expect(EXPORT_DATASET_COLUMNS['axe-violations'].map((c) => c.header)).toEqual([
      'URL', 'Rule', 'Kind', 'Impact', 'Help', 'Help URL', 'WCAG Tags', 'Elements', 'First Selector', 'First HTML',
    ]);
    const rows = [...datasetRows(db, 'axe-violations', {})].map((r) =>
      EXPORT_DATASET_COLUMNS['axe-violations'].map((c) => readCell(r, c.key)),
    );
    // Key order (page, rule, kind), compared as emitted: no sorting here.
    expect(rows).toEqual([
      [A, 'color-contrast', 'needs-review', 'serious', 'Elements must meet contrast', 'https://x/cc', 'wcag2aa', 1, null, null],
      [A, 'image-alt', 'violation', 'critical', 'Images must have alternative text',
        'https://dequeuniversity.com/rules/axe/4.14/image-alt', 'wcag2a,wcag111', 3, 'img.hero', '<img class="hero" src="a.png">'],
    ]);
  });

  it('emits rows in key order (url, rule, kind) through iterateAxeResults, not in the UI worst-first order', () => {
    const rule = (id: string, impact: 'minor' | 'critical', nodes: number) => ({
      id, impact, help: id, helpUrl: null, tags: [], nodes, samples: [],
    });
    // Key order: (A,aaa,incomplete) (A,bbb,violation) (B,ccc,violation).
    // Worst-first (kind, impact, nodes DESC, url, rule): ccc, bbb, aaa. The two orders differ.
    db.setUrlAxe(1, {
      version: '4.14.0',
      violations: [rule('bbb', 'minor', 1)],
      incomplete: [rule('aaa', 'minor', 1)],
      violationsTotal: 1,
      seriousTotal: 0,
    } as unknown as AxeAudit);
    db.setUrlAxe(2, {
      version: '4.14.0',
      violations: [rule('ccc', 'critical', 9)],
      incomplete: [],
      violationsTotal: 1,
      seriousTotal: 1,
    } as unknown as AxeAudit);
    expect(db.queryAxe({ limit: 10, offset: 0 }).rows.map((r) => r.ruleId)).toEqual(['ccc', 'bbb', 'aaa']);

    const iterate = vi.spyOn(db, 'iterateAxeResults');
    const queryAxe = vi.spyOn(db, 'queryAxe');
    const out = [...datasetRows(db, 'axe-violations', {})].map((r) => [readCell(r, 'url'), readCell(r, 'ruleId'), readCell(r, 'kind')]);
    expect(iterate).toHaveBeenCalledTimes(1);
    expect(queryAxe).not.toHaveBeenCalled();
    expect(out).toEqual([
      [A, 'aaa', 'needs-review'],
      [A, 'bbb', 'violation'],
      [B, 'ccc', 'violation'],
    ]);
  });

  it('the CLI offers it as --what dataset:axe-violations', () => {
    expect(CLI_EXPORT_DATASETS).toContain('axe-violations');
  });

  it('a project without axe results exports no rows', () => {
    db.setUrlAxe(1, { ...audit, violations: [], incomplete: [], violationsTotal: 0, seriousTotal: 0 });
    expect([...datasetRows(db, 'axe-violations', {})]).toEqual([]);
  });
});
