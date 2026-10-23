import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from './migrations.js';
import { ProjectDb } from './project-db.js';

// The MCP server opens project files read-only and never migrates them, so every reader of the
// M17 state (migration 126 and later) must answer on a file written before this module.
const BEFORE_M17 = 125;
const A = 'https://ex.test/a';
const NOW = '2026-10-01T00:00:00.000Z';

let dir: string;
let db: ProjectDb;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-m17ro-'));
  const file = path.join(dir, 'p.seoproject');
  const raw = new DatabaseSync(file);
  runMigrations(raw, BEFORE_M17);
  raw.exec(`
    INSERT INTO urls (id, url, is_external, content_kind, status_code) VALUES (1, '${A}', 0, 'html', 200);
    INSERT INTO pagespeed_results (url, strategy, performance, lcp, status, fetched_at) VALUES ('${A}', 'mobile', 71, 2500, 'ok', '${NOW}');
  `);
  expect(raw.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'pagespeed_audits'`).get()).toBeUndefined();
  raw.close();
  db = new ProjectDb(file, { readOnly: true });
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('a project file from before M17 (version 125), opened read-only', () => {
  it('queryPagespeed keeps its rows and total and reads the opportunity counts as 0 / null', () => {
    const { rows, total } = db.queryPagespeed({ limit: 10, offset: 0 });
    expect(total).toBe(1);
    expect(rows[0]!.mobile?.performance).toBe(71);
    expect(rows[0]!.mobileOpportunityCount).toBe(0);
    expect(rows[0]!.mobileTopSavingsMs).toBeNull();
    expect(rows[0]!.desktopOpportunityCount).toBe(0);
    expect(rows[0]!.desktopTopSavingsMs).toBeNull();
    expect(db.queryPagespeed({ limit: 10, offset: 0, filter: 'tested' }).total).toBe(1);
  });

  it('queryPagespeedAudits answers with no rows, with and without filters', () => {
    expect(db.queryPagespeedAudits({ limit: 10, offset: 0 })).toEqual({ rows: [], total: 0 });
    expect(db.queryPagespeedAudits({ url: A, strategy: 'mobile', kind: 'insight', auditId: 'x', limit: 10, offset: 0 })).toEqual({ rows: [], total: 0 });
  });
});
