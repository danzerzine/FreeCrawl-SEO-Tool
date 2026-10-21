import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { EXPENSIVE_ISSUE_DEFINITIONS, ProjectDb } from './project-db.js';

let dir: string;
let file: string;

// / links to /a (followed) and /nf (nofollow only). /a links back to /.
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-nfc-'));
  file = path.join(dir, 'p.seoproject');
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec(`
    INSERT INTO project_meta (key, value) VALUES ('lastStartUrl', 'https://ex.com/');
    INSERT INTO urls (id, url, is_external, content_kind, status_code) VALUES
      (1, 'https://ex.com/', 0, 'html', 200), (2, 'https://ex.com/a', 0, 'html', 200),
      (3, 'https://ex.com/nf', 0, 'html', 200);
    INSERT INTO links (from_url_id, to_url, is_internal, rel) VALUES
      (1, 'https://ex.com/a', 1, NULL),
      (1, 'https://ex.com/nf', 1, 'nofollow'),
      (2, 'https://ex.com/', 1, NULL);
  `);
  raw.close();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function run(countNofollow: boolean | null) {
  const db = new ProjectDb(file);
  if (countNofollow !== null) db.setMeta('countNofollowLinks', countNofollow ? '1' : '0');
  db.recomputeInlinks();
  db.recomputeLinkScore();
  db.recomputeUrlsIssues(EXPENSIVE_ISSUE_DEFINITIONS);
  const rows = new Map([...db.iterateUrlsByCategory('all')].map((r) => [r.url, r]));
  const orphans = [...db.iterateUrlsByCategory('issues:orphan-page')].map((r) => r.url);
  const nfOnly = [...db.iterateUrlsByCategory('issues:inlinks-nofollow-only' as never)].map(
    (r) => r.url,
  );
  db.close();
  return { nf: rows.get('https://ex.com/nf')!, orphans, nfOnly };
}

it('by default a nofollow inlink is not counted: the page is an orphan, nofollow-only, scoreless', () => {
  const { nf, orphans, nfOnly } = run(null);
  expect(nf.inlinks).toBe(0);
  expect(orphans).toEqual(['https://ex.com/nf']);
  expect(nfOnly).toEqual(['https://ex.com/nf']);
  expect(nf.linkScore).toBe(run(false).nf.linkScore);
  // No equity reaches /nf: it holds only the teleport base, well under /a.
  expect(nf.linkScore).toBeLessThan(30);
});

it('with nofollow links counted the page has an inlink and is no orphan', () => {
  const { nf, orphans, nfOnly } = run(true);
  expect(nf.inlinks).toBe(1);
  expect(orphans).toEqual([]);
  expect(nfOnly).toEqual(['https://ex.com/nf']);
  expect(nf.linkScore).toBeGreaterThan(30);
});
