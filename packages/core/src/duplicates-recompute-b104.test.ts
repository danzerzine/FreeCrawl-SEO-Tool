import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { DEFAULT_CRAWL_CONFIG } from '@freecrawl/shared-types';
import { recomputeDuplicateGroups } from './duplicates-recompute.js';

// B104: a project crawled before representatives were stored lists its groups without one until recomputed.
let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b104-'));
  file = path.join(dir, 'p.seoproject');
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  const ins = raw.prepare(
    `INSERT INTO urls (id, url, is_external, content_kind, status_code, indexability, simhash, cluster_id, cluster_size, cluster_rep_id)
     VALUES (?, ?, 0, 'html', 200, 'indexable', ?, ?, ?, NULL)`,
  );
  // Two near-identical pages and a third one close to them: grouped by the old build, no representative stored.
  ins.run(1, 'https://ex.com/a', '0000000000000000', 1, 3);
  ins.run(2, 'https://ex.com/b', '0000000000000001', 1, 3);
  ins.run(3, 'https://ex.com/c', '0000000000000003', 1, 3);
  ins.run(4, 'https://ex.com/other', 'ffffffffffffffff', 0, 1);
  raw.close();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

it('before: the group has no representative; after: every page of every group has one', () => {
  let db = new ProjectDb(file);
  expect(db.listDuplicateClusters(0, 100).every((r) => r.repUrl === null)).toBe(true);
  const res = recomputeDuplicateGroups(db, { ...DEFAULT_CRAWL_CONFIG, nearDuplicateHammingThreshold: 3, nearDuplicateSimilarity: 0 });
  expect(res?.clusters).toBe(1);
  db.close();
  db = new ProjectDb(file);
  const rows = db.listDuplicateClusters(0, 100);
  db.close();
  expect(rows).toHaveLength(3);
  expect(new Set(rows.map((r) => r.repUrl)).size).toBe(1);
  for (const r of rows) expect(r.repUrl).toMatch(/^https:\/\/ex\.com\/[abc]$/);
});

it('clustering switched off touches nothing', () => {
  const db = new ProjectDb(file);
  expect(recomputeDuplicateGroups(db, { ...DEFAULT_CRAWL_CONFIG, nearDuplicateHammingThreshold: 0, nearDuplicateSimilarity: 0 })).toBeNull();
  expect(db.listDuplicateClusters(0, 100)).toHaveLength(3);
  db.close();
});
