import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { EXPENSIVE_ISSUE_DEFINITIONS, ProjectDb } from './project-db.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b19-'));
  file = path.join(dir, 'p.seoproject');
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec(`
    INSERT INTO project_meta (key, value) VALUES ('lastStartUrl', 'https://ex.com/');
    INSERT INTO urls (id, url, is_external, content_kind, status_code) VALUES
      (1, 'https://ex.com/', 0, 'html', 200), (2, 'https://ex.com/nf', 0, 'html', 200),
      (3, 'https://ex.com/mixed', 0, 'html', 200), (4, 'https://ex.com/plain', 0, 'html', 200),
      (5, 'https://ex.com/orphan', 0, 'html', 200);
    INSERT INTO links (from_url_id, to_url, is_internal, rel) VALUES
      (1, 'https://ex.com/nf', 1, 'nofollow'),
      (4, 'https://ex.com/nf', 1, 'ugc nofollow'),
      (1, 'https://ex.com/mixed', 1, 'nofollow'),
      (4, 'https://ex.com/mixed', 1, NULL),
      (1, 'https://ex.com/plain', 1, NULL),
      (2, 'https://ex.com/nf', 1, NULL);
  `);
  raw.close();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

it('a page whose every internal inlink is nofollow is flagged; one followed inlink clears it', () => {
  const db = new ProjectDb(file);
  db.recomputeInlinks();
  db.recomputeUrlsIssues(EXPENSIVE_ISSUE_DEFINITIONS);
  const urls = [...db.iterateUrlsByCategory('issues:inlinks-nofollow-only' as never)].map((r) => r.url);
  const count = (db.getOverviewCounts().issues as Record<string, number>).inlinksNofollowOnly;
  db.close();
  expect(urls).toEqual(['https://ex.com/nf']);
  expect(count).toBe(1);
});

it('is precomputed: the overview count and the list stay empty until the issue pass runs', () => {
  const db = new ProjectDb(file);
  db.recomputeInlinks();
  const before = (db.getOverviewCounts().issues as Record<string, number>).inlinksNofollowOnly;
  const listBefore = [...db.iterateUrlsByCategory('issues:inlinks-nofollow-only' as never)];
  db.recomputeUrlsIssues(EXPENSIVE_ISSUE_DEFINITIONS);
  const after = (db.getOverviewCounts().issues as Record<string, number>).inlinksNofollowOnly;
  db.close();
  expect(before).toBe(0);
  expect(listBefore).toEqual([]);
  expect(after).toBe(1);
});

it('a project materialised before the check existed is scheduled for a fresh issue pass', () => {
  const db = new ProjectDb(file);
  db.setMeta('urlsIssuesVersion', '4');
  expect(db.issueMaterialisationStale()).toBe(true);
  db.close();
});
