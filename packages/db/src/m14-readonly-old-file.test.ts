import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from './migrations.js';
import { ProjectDb } from './project-db.js';

// The MCP server opens project files read-only and never migrates them, so every reader of
// the M14 state (migrations 123-125) must answer on a file written before this module.
const BEFORE_M14 = 122;
const A = 'https://ex.test/a';
const NOW = '2026-10-01T00:00:00.000Z';

let dir: string;
let db: ProjectDb;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-m14ro-'));
  const file = path.join(dir, 'p.seoproject');
  const raw = new DatabaseSync(file);
  runMigrations(raw, BEFORE_M14);
  raw.exec(`
    INSERT INTO urls (id, url, is_external, content_kind, status_code) VALUES (1, '${A}', 0, 'html', 200);
    INSERT INTO gsc_results (url, account_id, clicks, impressions, ctr, position, fetched_at) VALUES ('${A}', 'acc', 3, 30, 0.1, 4, '${NOW}');
    INSERT INTO ga4_results (url, account_id, sessions, users, pageviews, engagement_rate, avg_session_duration, fetched_at) VALUES ('${A}', 'acc', 5, 4, 9, 0.5, 12, '${NOW}');
    INSERT INTO gsc_inspection_results (url, account_id, verdict, coverage_state, status, fetched_at) VALUES ('${A}', 'acc', 'PASS', 'Indexed', 'ok', '${NOW}');
  `);
  raw.close();
  db = new ProjectDb(file, { readOnly: true });
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('a project file from before M14, opened read-only', () => {
  it('query_gsc keeps its rows and reads the five inspection columns as null', () => {
    const { rows, total } = db.queryGsc({ limit: 10, offset: 0, accountId: 'acc' });
    expect(total).toBe(1);
    expect(rows[0]!.gsc?.clicks).toBe(3);
    expect(rows[0]!.inspection?.verdict).toBe('PASS');
    expect(rows[0]!.inspection?.pageFetchState).toBeNull();
    expect(rows[0]!.inspection?.sitemaps).toBeNull();
    expect(db.queryGsc({ limit: 10, offset: 0, accountId: 'acc', filter: 'rich-result-warnings' }).total).toBe(0);
  });

  it('get_url_analytics keeps GA4 and GSC data', () => {
    const d = db.getUrlAnalytics(A, 'acc', 'acc', '', undefined, 'host');
    expect(d?.ga4?.sessions).toBe(5);
    expect(d?.gsc?.clicks).toBe(3);
    expect(d?.inspection?.pageFetchState).toBeNull();
    expect(d?.inspection?.verdict).toBe('PASS');
  });

  it('query_ga4 answers, also when custom fields are asked for', () => {
    const r = db.queryGa4({ limit: 10, offset: 0, accountId: 'acc', customFields: ['x'], customProperty: 'p' });
    expect(r.total).toBe(1);
    expect(r.rows[0]!.ga4?.sessions).toBe(5);
    expect(r.rows[0]!.custom).toBeUndefined();
    expect(db.ga4CustomFieldRowCounts('acc')).toEqual({});
    expect(db.ga4UnmatchedUrlCount('acc')).toBe(0);
    expect([...db.iterateGa4CustomLong('acc')]).toEqual([]);
  });

  it('query_webmaster readers answer empty', () => {
    expect(db.queryWebmasterExcluded({ hostId: 'h', limit: 10, offset: 0 }).rows).toEqual([]);
    expect(db.queryWebmasterBrokenLinks({ hostId: 'h', limit: 10, offset: 0 }).rows).toEqual([]);
    expect(db.countWebmasterRows('h')).toEqual({ events: 0, excluded: 0, links: 0 });
  });
});
