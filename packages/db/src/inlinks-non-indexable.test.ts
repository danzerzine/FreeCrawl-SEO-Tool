import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { EXPENSIVE_ISSUE_DEFINITIONS, ProjectDb } from './project-db.js';

let dir: string;
let file: string;

// /tag (noindex) and /old (canonicalised away) are service pages.
// /only: linked from both service pages only -> flagged.
// /mixed: linked from /tag and from the indexable home -> clean.
// /nf: followed from /tag, nofollow from home -> flagged (nofollow does not count).
// /self: linked from /tag and from itself (indexable) -> flagged.
// /none: no inlinks at all -> not this check (orphan instead).
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-ini-'));
  file = path.join(dir, 'p.seoproject');
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec(`
    INSERT INTO project_meta (key, value) VALUES ('lastStartUrl', 'https://ex.com/');
    INSERT INTO urls (id, url, is_external, content_kind, status_code, indexability) VALUES
      (1, 'https://ex.com/', 0, 'html', 200, 'indexable'),
      (2, 'https://ex.com/tag', 0, 'html', 200, 'non-indexable:noindex'),
      (3, 'https://ex.com/old', 0, 'html', 200, 'non-indexable:canonical'),
      (4, 'https://ex.com/only', 0, 'html', 200, 'indexable'),
      (5, 'https://ex.com/mixed', 0, 'html', 200, 'indexable'),
      (6, 'https://ex.com/nf', 0, 'html', 200, 'indexable'),
      (7, 'https://ex.com/self', 0, 'html', 200, 'indexable'),
      (8, 'https://ex.com/none', 0, 'html', 200, 'indexable');
    INSERT INTO links (from_url_id, to_url, is_internal, rel) VALUES
      (1, 'https://ex.com/tag', 1, NULL),
      (1, 'https://ex.com/old', 1, NULL),
      (2, 'https://ex.com/only', 1, NULL),
      (3, 'https://ex.com/only', 1, NULL),
      (2, 'https://ex.com/mixed', 1, NULL),
      (1, 'https://ex.com/mixed', 1, NULL),
      (2, 'https://ex.com/nf', 1, NULL),
      (1, 'https://ex.com/nf', 1, 'nofollow'),
      (2, 'https://ex.com/self', 1, NULL),
      (7, 'https://ex.com/self', 1, NULL);
  `);
  raw.close();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

it('flags pages whose every followed inlink comes from a non-indexable page', () => {
  const db = new ProjectDb(file);
  db.recomputeInlinks();
  db.recomputeUrlsIssues(EXPENSIVE_ISSUE_DEFINITIONS);
  const urls = [...db.iterateUrlsByCategory('issues:inlinks-non-indexable-only' as never)]
    .map((r) => r.url)
    .sort();
  const count = (db.getOverviewCounts().issues as Record<string, number>)
    .inlinksNonIndexableOnly;
  db.close();
  expect(urls).toEqual(['https://ex.com/nf', 'https://ex.com/only', 'https://ex.com/self']);
  expect(count).toBe(3);
});
