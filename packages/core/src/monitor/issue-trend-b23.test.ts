import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import type { CrawlSnapshot } from '@freecrawl/shared-types';
import { buildCrawlSnapshot } from './snapshot.js';
import { issueTrend } from './history.js';

let dir: string;
let db: ProjectDb;
let single: ProjectDb;
let empty: ProjectDb;
let upgraded: ProjectDb;
const START = 'https://example.test/';

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'fc-trend-b23-'));
  db = new ProjectDb(join(dir, 'p.seoproject'));
  single = new ProjectDb(join(dir, 's.seoproject'));
  empty = new ProjectDb(join(dir, 'e.seoproject'));
  upgraded = new ProjectDb(join(dir, 'u.seoproject'));
  const base = buildCrawlSnapshot(db);
  const add = (
    target: ProjectDb,
    finishedAt: string,
    edit: (s: CrawlSnapshot) => void,
    toolVersion: string | null = '1.0.0',
    startUrl = START,
  ) => {
    const snapshot = structuredClone(base);
    edit(snapshot);
    target.appendCrawlRun({ finishedAt, startUrl, mode: 'spider', durationMs: 1, toolVersion, snapshot });
  };
  add(db, '2026-01-01T00:00:00.000Z', (s) => {
    s.counts.issues.titleMissing = 1;
  });
  add(db, '2026-02-01T00:00:00.000Z', (s) => {
    s.counts.issues.titleMissing = 7;
    s.counts.issues.h1Missing = 5;
    s.disabledChecks = ['issues:h1-missing' as never];
  });
  // A crawl of another site in between is not "the previous crawl".
  add(db, '2026-02-15T00:00:00.000Z', (s) => {
    s.counts.issues.titleMissing = 100;
  }, '1.0.0', 'https://other.test/');
  add(db, '2026-03-01T00:00:00.000Z', (s) => {
    s.counts.issues.titleMissing = 4;
    s.counts.issues.h1Missing = 9;
  });
  add(single, '2026-01-01T00:00:00.000Z', () => {});
  add(upgraded, '2026-01-01T00:00:00.000Z', () => {}, '1.0.0');
  add(upgraded, '2026-02-01T00:00:00.000Z', () => {}, '1.1.0');
});
afterAll(() => {
  for (const d of [db, single, empty, upgraded]) d.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('issueTrend after a crawl stopped by hand (B113)', () => {
  it('names the two finished crawls it compares, and live rows of an unfinished crawl change nothing', () => {
    const before = issueTrend(db);
    expect(before?.previousFinishedAt).toBe('2026-02-01T00:00:00.000Z');
    expect(before?.currentFinishedAt).toBe('2026-03-01T00:00:00.000Z');
    // A crawl stopped by hand writes pages but no crawl_runs row.
    const raw = new DatabaseSync(join(dir, 'p.seoproject'));
    for (let i = 0; i < 5; i++) {
      raw.exec(`INSERT INTO urls (url, status_code, is_external, content_kind) VALUES ('https://example.test/live-${i}', 404, 0, 'html')`);
    }
    raw.close();
    expect(issueTrend(db)).toEqual(before);
  });
});

describe('issueTrend (B23)', () => {
  it('newest crawl minus the previous one of the same start URL, per check', () => {
    const trend = issueTrend(db);
    expect(trend?.previousFinishedAt).toBe('2026-02-01T00:00:00.000Z');
    expect(trend?.checks['issues:title-missing']).toEqual({ previous: 7, change: -3 });
  });
  it('a check off in either crawl has no trend', () => {
    expect(issueTrend(db)?.checks['issues:h1-missing']).toBeUndefined();
  });
  it('an unchanged check is listed with change 0', () => {
    expect(issueTrend(upgraded)?.checks['issues:title-missing']).toEqual({
      previous: base0(upgraded),
      change: 0,
    });
  });
  it('fewer than two crawls: no trend', () => {
    expect(issueTrend(single)).toBeNull();
    expect(issueTrend(empty)).toBeNull();
  });
  it('says when the two crawls ran on different app versions', () => {
    expect(issueTrend(db)?.toolVersionChanged).toBe(false);
    expect(issueTrend(upgraded)?.toolVersionChanged).toBe(true);
  });
});

/** The empty project's title-missing count, the same in both of its crawls. */
function base0(target: ProjectDb): number {
  return target.listCrawlRuns(START)[0]!.snapshot.counts.issues.titleMissing ?? 0;
}
