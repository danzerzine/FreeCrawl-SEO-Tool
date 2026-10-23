import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProjectDb } from './project-db.js';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'fc-m21-time-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const raw = (db: ProjectDb) =>
  (db as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } }).db;

describe('latestCrawlTime: the crawl date a task states', () => {
  it('is null for an empty project', () => {
    const db = new ProjectDb(join(dir, 'empty.seoproject'));
    expect(db.latestCrawlTime()).toBeNull();
    db.close();
  });

  it('is the newest URL fetch time while no crawl has finished', () => {
    const db = new ProjectDb(join(dir, 'running.seoproject'));
    db.upsertUrl({ url: 'https://example.test/a', depth: 0 });
    db.upsertUrl({ url: 'https://example.test/b', depth: 0 });
    raw(db).prepare("UPDATE urls SET crawled_at = '2026-09-01 10:00:00' WHERE url LIKE '%/a'").run();
    raw(db).prepare("UPDATE urls SET crawled_at = '2026-09-02 11:00:00' WHERE url LIKE '%/b'").run();
    expect(db.latestCrawlTime()).toBe('2026-09-02 11:00:00');
    db.close();
  });

  it('is the newer of the newest run finish and the newest URL fetch', () => {
    const db = new ProjectDb(join(dir, 'done.seoproject'));
    db.upsertUrl({ url: 'https://example.test/a', depth: 0 });
    raw(db).prepare("UPDATE urls SET crawled_at = '2026-09-05 10:00:00'").run();
    const snapshot = { counts: {} } as never;
    for (const finishedAt of ['2026-08-01T00:00:00.000Z', '2026-09-03T12:00:00.000Z']) {
      db.appendCrawlRun({ finishedAt, startUrl: 'https://example.test/', mode: 'spider', durationMs: 1, toolVersion: null, snapshot });
    }
    // URLs fetched after the last finished run (cleared and re-crawled, stopped): the URL time wins.
    expect(db.latestCrawlTime()).toBe('2026-09-05 10:00:00');
    db.close();
  });

  it('is the finish time of the newest run when it is newer than every URL fetch', () => {
    const db = new ProjectDb(join(dir, 'done2.seoproject'));
    db.upsertUrl({ url: 'https://example.test/a', depth: 0 });
    raw(db).prepare("UPDATE urls SET crawled_at = '2026-09-03 10:00:00'").run();
    const snapshot = { counts: {} } as never;
    db.appendCrawlRun({ finishedAt: '2026-09-03T12:00:00.000Z', startUrl: 'https://example.test/', mode: 'spider', durationMs: 1, toolVersion: null, snapshot });
    expect(db.latestCrawlTime()).toBe('2026-09-03T12:00:00.000Z');
    db.close();
  });
});
