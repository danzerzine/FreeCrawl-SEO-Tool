import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { buildCrawlSnapshot } from './snapshot.js';
import { historyRows, latestAndPrevious } from './history.js';

let dir: string;
let db: ProjectDb;
let single: ProjectDb;
let empty: ProjectDb;
const START = 'https://example.test/';

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'fc-history-core-'));
  db = new ProjectDb(join(dir, 'p.seoproject'));
  single = new ProjectDb(join(dir, 's.seoproject'));
  empty = new ProjectDb(join(dir, 'e.seoproject'));
  const base = buildCrawlSnapshot(db);
  const add = (target: ProjectDb, finishedAt: string, startUrl: string, indexable: number) => {
    const snapshot = structuredClone(base);
    snapshot.counts.indexability.indexable = indexable;
    target.appendCrawlRun({ finishedAt, startUrl, mode: 'spider', durationMs: 1, toolVersion: null, snapshot });
  };
  add(db, '2026-01-01T00:00:00.000Z', START, 10);
  add(db, '2026-02-01T00:00:00.000Z', 'https://other.test/', 99);
  add(db, '2026-03-01T00:00:00.000Z', START, 11);
  add(db, '2026-04-01T00:00:00.000Z', START, 12);
  add(single, '2026-01-01T00:00:00.000Z', START, 5);
});
afterAll(() => {
  db.close();
  single.close();
  empty.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('latestAndPrevious', () => {
  it('the newest row and the one before it of the same start URL', () => {
    const pair = latestAndPrevious(db);
    expect(pair?.current.finishedAt).toBe('2026-04-01T00:00:00.000Z');
    expect(pair?.previous?.finishedAt).toBe('2026-03-01T00:00:00.000Z');
    expect(pair?.current.startUrl).toBe(START);
  });
  it('one crawl: no previous; no history: null', () => {
    expect(latestAndPrevious(single)?.previous).toBeNull();
    expect(latestAndPrevious(empty)).toBeNull();
  });
});

describe('historyRows', () => {
  it('rows of the newest start URL, oldest first, one value per metric', () => {
    const h = historyRows(db, ['indexable']);
    expect(h.startUrl).toBe(START);
    expect(h.rows).toEqual([
      { finishedAt: '2026-01-01T00:00:00.000Z', values: { indexable: 10 } },
      { finishedAt: '2026-03-01T00:00:00.000Z', values: { indexable: 11 } },
      { finishedAt: '2026-04-01T00:00:00.000Z', values: { indexable: 12 } },
    ]);
  });
  it('another start URL and a limit', () => {
    expect(historyRows(db, ['indexable'], { startUrl: 'https://other.test/' }).rows.map((r) => r.values.indexable)).toEqual([99]);
    expect(historyRows(db, ['indexable'], { limit: 1 }).rows.map((r) => r.values.indexable)).toEqual([12]);
  });
  it('no history: no start URL, no rows', () => {
    expect(historyRows(empty, ['indexable'])).toEqual({ startUrl: null, rows: [] });
  });
  it('an unknown metric or the status.<code> placeholder throws, even without history', () => {
    expect(() => historyRows(empty, ['nope'])).toThrow(/Unknown metric: nope/);
    expect(() => historyRows(db, ['status.<code>'])).toThrow(/Unknown metric: status\.<code>/);
  });
});
