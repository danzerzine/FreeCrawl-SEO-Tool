import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectDb } from './project-db.js';

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-bb-'));
  file = path.join(dir, 'p.seoproject');
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec(`INSERT INTO urls (id, url, is_external, content_kind, status_code, broken_bookmarks) VALUES
    (1, 'https://ex.com/', 0, 'html', 200, 2), (2, 'https://ex.com/a', 0, 'html', 200, 0);`);
  raw.close();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('broken bookmarks', () => {
  it('counts and lists pages with broken_bookmarks > 0', () => {
    const db = new ProjectDb(file);
    expect(db.getOverviewCounts().issues.brokenBookmark).toBe(1);
    expect([...db.iterateUrlsByCategory('issues:broken-bookmark')].map((r) => [r.url, r.brokenBookmarks])).toEqual([
      ['https://ex.com/', 2],
    ]);
    db.close();
  });
});
