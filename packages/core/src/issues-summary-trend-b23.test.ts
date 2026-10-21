import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ProjectDb } from '@freecrawl/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCrawlSnapshot } from './monitor/snapshot.js';
import { exportIssuesSummary } from './report-export.js';

let dir: string;
let db: ProjectDb;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b23-csv-'));
  db = new ProjectDb(path.join(dir, 'p.seoproject'));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function crawl(finishedAt: string, titleMissing: number): void {
  const snapshot = buildCrawlSnapshot(db);
  snapshot.counts.issues.titleMissing = titleMissing;
  db.appendCrawlRun({ finishedAt, startUrl: 'https://ex.com/', mode: 'spider', durationMs: 1, toolVersion: null, snapshot });
}

function summary(file: string): Map<string, Record<string, string>> {
  const [head, ...rows] = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trimEnd().split('\n');
  const cols = head!.split(',');
  return new Map(
    rows.map((r) => {
      const cells = r.split(',');
      return [cells[0]!, Object.fromEntries(cols.map((c, i) => [c, cells[i] ?? '']))];
    }),
  );
}

describe('issues-summary.csv previous and change (B23)', () => {
  it('two crawls: the previous count and newest minus previous', async () => {
    crawl('2026-01-01T00:00:00.000Z', 5);
    crawl('2026-02-01T00:00:00.000Z', 2);
    const out = path.join(dir, 's.csv');
    await exportIssuesSummary(db, out, { headers: 'keys' });
    expect(summary(out).get('issues:title-missing')).toMatchObject({ previous: '5', change: '-3' });
  });
  it('one crawl: both columns empty', async () => {
    crawl('2026-01-01T00:00:00.000Z', 5);
    const out = path.join(dir, 's.csv');
    await exportIssuesSummary(db, out);
    expect(summary(out).get('issues:title-missing')).toMatchObject({ Previous: '', Change: '' });
  });
});
