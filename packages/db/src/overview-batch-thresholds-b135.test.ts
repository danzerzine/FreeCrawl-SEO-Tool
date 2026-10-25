import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ProjectDb } from './project-db.js';

// B135: after the thresholds change, the overview counts every check in its one combined pass again,
// not one table scan per changed check.
let dir: string;
let db: ProjectDb;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b135-'));
  const file = path.join(dir, 'p.seoproject');
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  const ins = raw.prepare(
    `INSERT INTO urls (url, status_code, is_external, content_kind, indexability, title, title_length) VALUES (?, 200, 0, 'html', 'indexable', ?, ?)`,
  );
  for (let i = 1; i <= 3; i++) ins.run(`https://ex.test/${i}`, 'x'.repeat(40 + i * 10), 40 + i * 10);
  raw.close();
  db = new ProjectDb(file);
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const singles = (): number => (db as unknown as { countWhereStmtCache: Map<string, unknown> }).countWhereStmtCache.size;

it('counts follow the new threshold and still come from the batch', () => {
  const before = db.getOverviewCounts().issues.titleTooLong;
  const base = singles();
  db.setSeoThresholds({ titleMaxChars: 45 } as never);
  const after = db.getOverviewCounts().issues.titleTooLong;
  expect(after).toBeGreaterThan(before);
  expect(singles()).toBe(base);
  db.setSeoThresholds({ titleMaxChars: 60 } as never);
  expect(db.getOverviewCounts().issues.titleTooLong).toBe(before);
  expect(singles()).toBe(base);
});
