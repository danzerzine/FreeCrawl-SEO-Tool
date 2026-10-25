import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LATER_CHECKS, ProjectDb } from '@freecrawl/db';
import type { CrawlSnapshot } from '@freecrawl/shared-types';
import { exportIssuesSummary } from '../report-export.js';
import { buildCrawlSnapshot } from './snapshot.js';
import { issueTrend } from './history.js';

let dir: string;
const opened: ProjectDb[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fc-b162b-'));
});
afterEach(() => {
  for (const d of opened.splice(0)) d.close();
  rmSync(dir, { recursive: true, force: true });
});
const open = (name: string): ProjectDb => {
  const db = new ProjectDb(join(dir, `${name}.seoproject`));
  opened.push(db);
  return db;
};
const START = 'https://example.test/';
const page = (db: ProjectDb, path: string, rendered: boolean) =>
  db.upsertUrl({
    url: `${START}${path}`,
    depth: 0,
    statusCode: 200,
    indexability: 'indexable',
    contentKind: 'html',
    ...(rendered ? { jsH1Changed: 1, jsCanonicalChanged: 0, jsLinksChanged: 0, jsTextChanged: 0 } : {}),
  });

describe('a crawl the browser rendered only partly (B162b)', () => {
  it('the snapshot counts the pages a rendering crawl left unrendered; a text crawl has none to count', () => {
    const js = open('js');
    js.setMeta('checksFilled', JSON.stringify(LATER_CHECKS));
    page(js, 'a', true);
    page(js, 'b', false);
    page(js, 'c', false);
    expect(buildCrawlSnapshot(js).unrenderedPages).toBe(2);

    const text = open('text');
    page(text, 'a', false);
    expect(buildCrawlSnapshot(text).unrenderedPages).toBeNull();
  });

  it('the trend of a render check is marked incomplete, not read as an improvement; other checks are not', async () => {
    const db = open('p');
    const base = buildCrawlSnapshot(db);
    const add = (finishedAt: string, edit: (s: CrawlSnapshot) => void) => {
      const snapshot = structuredClone(base);
      edit(snapshot);
      db.appendCrawlRun({ finishedAt, startUrl: START, mode: 'spider', durationMs: 1, toolVersion: '1', snapshot });
    };
    add('2026-01-01T00:00:00.000Z', (s) => {
      s.unrenderedPages = 0;
      s.counts.issues.h1ChangedByJs = 5;
      s.counts.issues.titleMissing = 3;
    });
    add('2026-02-01T00:00:00.000Z', (s) => {
      s.unrenderedPages = 40;
      s.counts.issues.h1ChangedByJs = 1;
      s.counts.issues.titleMissing = 2;
    });
    const trend = issueTrend(db)!;
    expect(trend.checks['issues:h1-changed-by-js']).toEqual({ previous: 5, change: -4, incomplete: true });
    expect(trend.checks['issues:title-missing']).toEqual({ previous: 3, change: -1 });

    const file = join(dir, 'issues-summary.csv');
    await exportIssuesSummary(db, file, { headers: 'keys' });
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    expect(lines.find((l) => l.startsWith('issues:h1-changed-by-js,'))).toMatch(/,5,incomplete$/);
    expect(lines.find((l) => l.startsWith('issues:title-missing,'))).toMatch(/,3,-1$/);
  });

  it('two fully rendered crawls (or snapshots from before the count) compare as before', () => {
    const db = open('full');
    const base = buildCrawlSnapshot(db);
    for (const [at, n] of [['2026-01-01T00:00:00.000Z', 5], ['2026-02-01T00:00:00.000Z', 1]] as const) {
      const snapshot = structuredClone(base);
      delete snapshot.unrenderedPages;
      snapshot.counts.issues.h1ChangedByJs = n;
      db.appendCrawlRun({ finishedAt: at, startUrl: START, mode: 'spider', durationMs: 1, toolVersion: '1', snapshot });
    }
    expect(issueTrend(db)!.checks['issues:h1-changed-by-js']).toEqual({ previous: 5, change: -4 });
  });
});
