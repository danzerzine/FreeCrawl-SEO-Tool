import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { categoryWhereClause, ProjectDb } from './project-db.js';

// B97: on a 479k-URL project this one check took 312 of the overview's
// 331 s, because its per-row lookup of the cluster's other pages skipped the
// partial cluster_id index and scanned every internal URL.
const KEY = 'issues:canonical-conflict-near-duplicate';
let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b97-'));
  file = path.join(dir, 'p.seoproject');
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec(`
    INSERT INTO urls (id, url, is_external, content_kind, status_code, cluster_id, cluster_size, canonical) VALUES
      (1, 'https://ex.com/a', 0, 'html', 200, 7, 2, 'https://ex.com/a'),
      (2, 'https://ex.com/b', 0, 'html', 200, 7, 2, 'https://ex.com/b'),
      (3, 'https://ex.com/c', 0, 'html', 200, 8, 2, 'https://ex.com/c'),
      (4, 'https://ex.com/d', 0, 'html', 200, 8, 2, 'https://ex.com/c'),
      (5, 'https://ex.com/e', 0, 'html', 200, 0, 1, 'https://ex.com/x');
  `);
  raw.close();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

it('the cluster lookup runs once (one GROUP BY), not once per internal URL', () => {
  const clause = categoryWhereClause(KEY, new Set());
  const raw = new DatabaseSync(file);
  try {
    const plan = (raw.prepare(`EXPLAIN QUERY PLAN SELECT COUNT(*) FROM urls WHERE ${clause}`).all() as { detail: string }[])
      .map((r) => r.detail);
    // B94 (554a2a8) replaced the correlated EXISTS by one uncorrelated GROUP BY.
    expect(plan).toContain('LIST SUBQUERY 1');
    expect(plan.some((d) => d.includes('CORRELATED'))).toBe(false);
    expect((raw.prepare(`SELECT COUNT(*) AS c FROM urls WHERE ${clause}`).get() as { c: number }).c).toBe(2);
  } finally {
    raw.close();
  }
});

it('the sidebar count reads the same pages as the filter', () => {
  const db = new ProjectDb(file);
  try {
    expect(db.getOverviewCounts().issues.canonicalConflictNearDuplicate).toBe(2);
  } finally {
    db.close();
  }
});
