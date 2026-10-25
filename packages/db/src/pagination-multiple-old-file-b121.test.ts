import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { runMigrations } from './migrations.js';
import { ProjectDb } from './project-db.js';

// B121: a file from before migration 131, opened read-only (no migration), has no pagination_multiple column.
let dir: string;
let db: ProjectDb;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b121-'));
  const file = path.join(dir, 'p.seoproject');
  const raw = new DatabaseSync(file);
  runMigrations(raw, 130);
  raw.exec(`INSERT INTO urls (id, url, is_external, content_kind, status_code) VALUES (1, 'https://ex.test/a', 0, 'html', 200)`);
  raw.close();
  db = new ProjectDb(file, { readOnly: true });
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

it('the Multiple Pagination URLs filter matches nothing and the roll-ups still answer', () => {
  expect([...db.iterateUrlsByCategory('issues:pagination-multiple')]).toEqual([]);
  expect((db.getOverviewCounts().issues as unknown as Record<string, number>).paginationMultiple).toBe(0);
  for (const cat of ['issues:severity-warning', 'issues:severity-critical', 'issues:severity-info']) {
    expect(() => db.queryUrls({ category: cat as never, limit: 10, offset: 0 })).not.toThrow();
  }
});
