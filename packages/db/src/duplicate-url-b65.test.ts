import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXPENSIVE_ISSUE_DEFINITIONS, ProjectDb } from './project-db.js';

let dir: string;
let file: string;

/** Internal HTML rows: [url, status]. NULL status = queued, never fetched. */
const ROWS: Array<[string, number | null]> = [
  // A redirect and its target are one page, not two.
  ['https://ex.com/a', 301],
  ['https://ex.com/a/', 200],
  // A link never fetched is not a page that answers twice.
  ['https://ex.com/b', null],
  ['https://ex.com/b/', 200],
  // Two spellings that both answer 200: a real duplicate.
  ['https://ex.com/c', 200],
  ['https://ex.com/C/', 200],
];

function seed(rows: Array<[string, number | null]>): void {
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  const ins = raw.prepare(
    `INSERT INTO urls (url, status_code, indexability, content_kind, is_external) VALUES (?, ?, 'indexable', 'html', 0)`,
  );
  for (const [u, s] of rows) ins.run(u, s);
  raw.close();
}

function flagged(db: ProjectDb): string[] {
  return [...db.iterateUrlsByCategory('issues:duplicate-url-post-norm')].map((r) => r.url).sort();
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b65-'));
  file = path.join(dir, 'p.seoproject');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('Duplicate URL (B65)', () => {
  it('only pages that answered 200 are compared', () => {
    seed(ROWS);
    const db = new ProjectDb(file);
    db.recomputeUrlsIssues(EXPENSIVE_ISSUE_DEFINITIONS);
    const list = flagged(db);
    const count = db.getOverviewCounts().issues.duplicateUrlPostNorm;
    db.close();
    expect(list).toEqual(['https://ex.com/C/', 'https://ex.com/c']);
    expect(count).toBe(2);
  });

  it('page 2 of a list is not a duplicate of the list; page 1 and tracking parameters are', () => {
    seed([
      ['https://ex.com/list/', 200],
      ['https://ex.com/list/?page=2', 200],
      ['https://ex.com/news/', 200],
      ['https://ex.com/news/?p=3', 200],
      ['https://ex.com/one/', 200],
      ['https://ex.com/one/?page=1', 200],
      ['https://ex.com/d/', 200],
      ['https://ex.com/d/?utm_source=x', 200],
      ['https://ex.com/g/', 200],
      ['https://ex.com/g/?pg=2', 200],
      ['https://ex.com/g/?pg=2&utm_source=x', 200],
    ]);
    const db = new ProjectDb(file);
    db.recomputeUrlsIssues(EXPENSIVE_ISSUE_DEFINITIONS);
    const list = flagged(db);
    db.close();
    expect(list).toEqual([
      'https://ex.com/d/',
      'https://ex.com/d/?utm_source=x',
      'https://ex.com/g/?pg=2',
      'https://ex.com/g/?pg=2&utm_source=x',
      'https://ex.com/one/',
      'https://ex.com/one/?page=1',
    ]);
  });

  it('with URL normalisation off nothing is flagged', () => {
    seed([
      ...ROWS,
      ['https://ex.com/one/', 200],
      ['https://ex.com/one/?page=1', 200],
      ['https://ex.com/d/', 200],
      ['https://ex.com/d/?utm_source=x', 200],
    ]);
    const db = new ProjectDb(file);
    db.applyCrawlConfigFlags({ dedupePreNormalize: false });
    db.recomputeUrlsIssues(EXPENSIVE_ISSUE_DEFINITIONS);
    const list = flagged(db);
    db.close();
    expect(list).toEqual([]);
  });

  it('a project materialised by the previous rule is rebuilt on open', () => {
    seed(ROWS);
    const db = new ProjectDb(file);
    db.recomputeUrlsIssues(EXPENSIVE_ISSUE_DEFINITIONS);
    // The old rule's leftovers: the redirect pair flagged, stamped '8'.
    db.setMeta('urlsIssuesVersion', '8');
    db.close();
    const raw = new DatabaseSync(file);
    raw.exec(`INSERT INTO urls_issues (url_id, issue_key)
                SELECT id, 'issues:duplicate-url-post-norm' FROM urls WHERE url IN ('https://ex.com/a', 'https://ex.com/a/')`);
    raw.close();
    const again = new ProjectDb(file);
    const stale = again.issueMaterialisationStale();
    if (stale) again.recomputeUrlsIssues(EXPENSIVE_ISSUE_DEFINITIONS);
    const list = flagged(again);
    const count = again.getOverviewCounts().issues.duplicateUrlPostNorm;
    again.close();
    expect(stale).toBe(true);
    expect(list).toEqual(['https://ex.com/C/', 'https://ex.com/c']);
    expect(count).toBe(list.length);
  });
});
