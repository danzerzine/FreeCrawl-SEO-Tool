import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProjectDb } from '@freecrawl/db';
import { EXPORT_DATASET_COLUMNS, type AxeAudit } from '@freecrawl/shared-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { datasetRows, readCell } from './dataset-export.js';
import { CLI_EXPORT_DATASETS } from './export-items.js';

const A = 'https://ex.test/a';

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
  raw.exec(`INSERT INTO urls (id, url, is_external, content_kind, status_code) VALUES (1,'${A}',0,'html',200)`);
  raw.close();
  db = new ProjectDb(file);
  db.setUrlAxe(1, audit);
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('B40 R14: dataset axe-violations', () => {
  it('has the columns of the spec, one row per page x rule, violations before needs-review', () => {
    expect(EXPORT_DATASET_COLUMNS['axe-violations'].map((c) => c.header)).toEqual([
      'URL', 'Rule', 'Kind', 'Impact', 'Help', 'Help URL', 'WCAG Tags', 'Elements', 'First Selector', 'First HTML',
    ]);
    const rows = [...datasetRows(db, 'axe-violations', {})].map((r) =>
      EXPORT_DATASET_COLUMNS['axe-violations'].map((c) => readCell(r, c.key)),
    );
    expect(rows).toEqual([
      [A, 'image-alt', 'violation', 'critical', 'Images must have alternative text',
        'https://dequeuniversity.com/rules/axe/4.14/image-alt', 'wcag2a,wcag111', 3, 'img.hero', '<img class="hero" src="a.png">'],
      [A, 'color-contrast', 'needs-review', 'serious', 'Elements must meet contrast', 'https://x/cc', 'wcag2aa', 1, null, null],
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
