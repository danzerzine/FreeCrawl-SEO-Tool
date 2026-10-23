import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ProjectDb } from './project-db.js';

// Every fixture gets its own folder and handle; both go when the file ends.
const dirs: string[] = [];
const dbs: ProjectDb[] = [];
afterAll(() => {
  for (const db of dbs) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function fixture(): ProjectDb {
  const dir = mkdtempSync(join(tmpdir(), 'orph-'));
  dirs.push(dir);
  const db = new ProjectDb(join(dir, 'p.db'));
  dbs.push(db);
  // one crawled internal page so the Metrica host filter lets the host through
  (db as unknown as { db: { exec(s: string): void } }).db.exec(
    `INSERT INTO urls (url, status_code, is_external) VALUES ('https://ex.com/', 200, 0)`,
  );
  db.setSitemapUrls([
    { url: 'https://ex.com/blog/y', lastmod: null, priority: null, changefreq: null, source: 's' },
  ]);
  db.replaceMetricaResults(
    [{ url: 'https://ex.com/a/x', pageviews: 5, visits: 3, users: 2, searchVisits: 0 }],
    '2026-01-01',
    'c1',
  );
  return db;
}
const urls = (db: ProjectDb, ex?: string[]) =>
  db.orphanPagesCrossSource(1000, '', '', 'c1', ex).map((r) => r.url).sort();

describe('orphanPagesCrossSource path exclusions', () => {
  it('lists both without a pattern', () => {
    expect(urls(fixture())).toEqual(['https://ex.com/a/x', 'https://ex.com/blog/y']);
  });
  it('drops the analytics-only /a/ family', () => {
    expect(urls(fixture(), ['/a/'])).toEqual(['https://ex.com/blog/y']);
  });
  it('uses the persisted per-project patterns', () => {
    const db = fixture();
    db.setOrphanExcludePatterns(['^https://ex\\.com/a/']);
    expect(urls(db)).toEqual(['https://ex.com/blog/y']);
    db.setOrphanExcludePatterns([]);
    expect(urls(db)).toHaveLength(2);
  });
  it('rejects a catastrophic pattern', () => {
    const db = fixture();
    expect(() => db.setOrphanExcludePatterns(['(a+)+$'])).toThrow(/nested quantifier/);
    expect(() => urls(db, ['(.*)*x'])).toThrow(/nested quantifier/);
    expect(() => db.setOrphanExcludePatterns(['x'.repeat(300)])).toThrow(/too long/);
    expect(() => db.setOrphanExcludePatterns(['(['])).toThrow(/invalid/i);
  });
});

describe('exclusion happens inside the query', () => {
  it('limit 100 over 1500 orphans, 1000 excluded, still returns 100 kept rows', () => {
    const db = fixture();
    db.setSitemapUrls(
      Array.from({ length: 1500 }, (_, i) => ({
        url: i < 1000 ? `https://ex.com/a/${i}` : `https://ex.com/blog/${i}`,
        lastmod: null,
        priority: null,
        changefreq: null,
        source: 's',
      })),
    );
    const rows = db.orphanPagesCrossSource(100, '', '', 'c1', ['/a/']);
    expect(rows).toHaveLength(100);
    expect(rows.every((r) => !r.url.includes('/a/'))).toBe(true);
  });
});
