import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { buildCrawlSnapshot } from '@freecrawl/core';
import { monitorHistory, monitorMetricNames } from './monitor-history.js';

let dir: string;
let db: ProjectDb;
let empty: ProjectDb;
const START = 'https://example.test/';

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-trends-'));
  db = new ProjectDb(path.join(dir, 'p.seoproject'));
  empty = new ProjectDb(path.join(dir, 'e.seoproject'));
  db.setMeta('lastStartUrl', 'typed.test');
  const base = buildCrawlSnapshot(db);
  db.appendCrawlRun({ finishedAt: '2025-12-01T00:00:00.000Z', startUrl: 'https://other.test/', mode: 'spider', durationMs: 1, toolVersion: null, snapshot: base });
  for (let i = 0; i < 5; i++) {
    const snapshot = structuredClone(base);
    snapshot.counts.indexability.indexable = 10 + i;
    snapshot.counts.responseCodes.clientError4xx = i;
    snapshot.disabledChecks = ['issues:h1-missing' as never];
    // Only the newest crawl's codes are offered: 500 is in an older one.
    snapshot.summary.byStatus = i === 4 ? { '404': 2, '200': 5, '301': 1 } : { '500': 1 };
    db.appendCrawlRun({ finishedAt: `2026-01-0${i + 1}T00:00:00.000Z`, startUrl: START, mode: 'spider', durationMs: 1, toolVersion: null, snapshot });
  }
});
afterAll(() => {
  db.close();
  empty.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('monitorHistory (B88e)', () => {
  it('5 rows give 5 points per metric, oldest first, other start URLs excluded', () => {
    const rows = monitorHistory(db, ['indexable', 'status.4xx']);
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.finishedAt)[0]).toBe('2026-01-01T00:00:00.000Z');
    expect(rows.map((r) => r.values.indexable)).toEqual([10, 11, 12, 13, 14]);
    expect(rows.map((r) => r.values['status.4xx'])).toEqual([0, 1, 2, 3, 4]);
  });
  it('a not computed metric is null', () => {
    const rows = monitorHistory(db, ['issues:h1-missing']);
    expect(rows.map((r) => r.values['issues:h1-missing'])).toEqual([null, null, null, null, null]);
  });
  it('limit keeps the newest rows; no history gives an empty list; unknown metric throws', () => {
    expect(monitorHistory(db, ['indexable'], 2).map((r) => r.values.indexable)).toEqual([13, 14]);
    expect(monitorHistory(empty, ['indexable'])).toEqual([]);
    expect(() => monitorHistory(db, ['nope'])).toThrow(/Unknown metric/);
  });
  it('lists the metric names for the picker: status.<code> as the codes of the newest crawl', () => {
    const names = monitorMetricNames(db);
    expect(names).toContain('indexable');
    expect(names).not.toContain('status.<code>');
    expect(names.filter((n) => /^status\.\d{3}$/.test(n))).toEqual(['status.200', 'status.301', 'status.404']);
    expect(names.indexOf('status.200')).toBeGreaterThan(names.indexOf('status.bot-blocked'));
    expect(monitorMetricNames(empty).filter((n) => n.startsWith('status.')).every((n) => !/\d{3}|</.test(n))).toBe(true);
  });
});
