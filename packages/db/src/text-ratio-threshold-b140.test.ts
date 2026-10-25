import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { DEFAULT_SEO_THRESHOLDS, checksWithDifferentThresholds, fillThresholdLabel, resolveSeoThresholds } from '@freecrawl/shared-types';
import { ProjectDb } from './project-db.js';

// B140: the Low Text/Code Ratio limit is a threshold (default 10 %), like the length limits of B77.
let dir: string;
let db: ProjectDb;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b140-'));
  const file = path.join(dir, 'p.seoproject');
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  const ins = raw.prepare(
    `INSERT INTO urls (url, status_code, is_external, content_kind, indexability, text_code_ratio) VALUES (?, 200, 0, 'html', 'indexable', ?)`,
  );
  for (const [n, ratio] of [['low', 5], ['edge', 10], ['mid', 12], ['high', 30]] as const) ins.run(`https://ex.test/${n}`, ratio);
  raw.close();
  db = new ProjectDb(file);
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const flagged = (): string[] =>
  [...db.iterateUrlsByCategory('issues:text-code-ratio-low')].map((r) => r.url.slice('https://ex.test/'.length)).sort();

it('the default stays 10 %: only pages below it are flagged', () => {
  expect(DEFAULT_SEO_THRESHOLDS.textCodeRatioMinPercent).toBe(10);
  expect(flagged()).toEqual(['low']);
  expect(db.getOverviewCounts().issues.textCodeRatioLow).toBe(1);
});

it('a stored limit moves the count and the list together, and the label follows', () => {
  db.setSeoThresholds({ textCodeRatioMinPercent: 15 });
  expect(flagged()).toEqual(['edge', 'low', 'mid']);
  expect(db.getOverviewCounts().issues.textCodeRatioLow).toBe(3);
  expect(fillThresholdLabel('Low Text/Code Ratio (<{{textCodeRatioMinPercent}}%)', db.getSeoThresholds())).toBe('Low Text/Code Ratio (<15%)');
  expect(checksWithDifferentThresholds(DEFAULT_SEO_THRESHOLDS, resolveSeoThresholds({ textCodeRatioMinPercent: 15 }))).toEqual(['issues:text-code-ratio-low']);
});
