import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LATER_CHECKS, MARKUP_CHECKS } from './project-db.js';
import { runMigrations } from './migrations.js';
import { ProjectDb } from './project-db.js';

let dir: string;
const opened: ProjectDb[] = [];
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b45db-'));
});
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
const open = (name: string): ProjectDb => {
  const db = new ProjectDb(path.join(dir, `${name}.seoproject`));
  opened.push(db);
  return db;
};
const cat = (db: ProjectDb, k: string): string[] =>
  db.queryUrls({ limit: 10, offset: 0, category: `issues:${k}` as never }).rows.map((r) => r.url);
const put = (db: ProjectDb, url: string, over: Record<string, unknown> = {}): number =>
  db.upsertUrl({ url, depth: 0, statusCode: 200, indexability: 'indexable', contentKind: 'html', ...over });

describe('B45 migration 128', () => {
  it('adds markup_errors and markup_codes; old rows stay NULL; a second run changes nothing', () => {
    const file = path.join(dir, 'old.seoproject');
    const old = new DatabaseSync(file);
    runMigrations(old, 127);
    old.exec(`INSERT INTO urls (id, url, is_external, content_kind, status_code) VALUES (1, 'https://ex.test/a', 0, 'html', 200)`);
    const before = (old.prepare('PRAGMA table_info(urls)').all() as { name: string }[]).map((c) => c.name);
    expect(before).not.toContain('markup_errors');
    runMigrations(old);
    const cols = (old.prepare('PRAGMA table_info(urls)').all() as { name: string; type: string }[]);
    expect(cols.filter((c) => c.name.startsWith('markup_')).map((c) => [c.name, c.type])).toEqual([
      ['markup_errors', 'INTEGER'],
      ['markup_codes', 'TEXT'],
    ]);
    expect(old.prepare('SELECT version FROM schema_version WHERE version = 128').get()).toBeDefined();
    expect(old.prepare('SELECT url, markup_errors, markup_codes FROM urls').all()).toEqual([
      { url: 'https://ex.test/a', markup_errors: null, markup_codes: null },
    ]);
    runMigrations(old);
    expect(old.prepare('SELECT COUNT(*) AS c FROM schema_version WHERE version = 128').get()).toEqual({ c: 1 });
    old.close();
  });
});

describe('B45 stored columns and issues', () => {
  it('stores both columns and lists the pages under the two issues', () => {
    const db = open('a');
    const bad = put(db, 'https://ex.com/bad', { markupErrors: 3, markupCodes: '{"duplicate-id":2,"missing-doctype":1}' });
    put(db, 'https://ex.com/no-doctype', { markupErrors: 1, markupCodes: '{"missing-doctype":1}' });
    put(db, 'https://ex.com/clean', { markupErrors: 0, markupCodes: null });
    put(db, 'https://ex.com/unchecked');
    const row = db.getUrlById(bad)!;
    expect([row.markupErrors, row.markupCodes]).toEqual([3, '{"duplicate-id":2,"missing-doctype":1}']);
    const clean = db.getUrlById(db.getUrlIdByUrl('https://ex.com/clean')!)!;
    expect([clean.markupErrors, clean.markupCodes]).toEqual([0, null]);
    const un = db.getUrlById(db.getUrlIdByUrl('https://ex.com/unchecked')!)!;
    expect([un.markupErrors, un.markupCodes]).toEqual([null, null]);
    expect(cat(db, 'markup-errors').sort()).toEqual(['https://ex.com/bad', 'https://ex.com/no-doctype']);
    expect(cat(db, 'duplicate-ids')).toEqual(['https://ex.com/bad']);
    const o = db.getOverviewCounts().issues;
    expect([o.markupErrors, o.duplicateIds]).toEqual([2, 1]);
  });

  it('a refresh with the option off overwrites both columns with NULL (B35 rule)', () => {
    const db = open('b');
    put(db, 'https://ex.com/p', { markupErrors: 2, markupCodes: '{"duplicate-id":2}' });
    put(db, 'https://ex.com/p');
    const row = db.getUrlById(db.getUrlIdByUrl('https://ex.com/p')!)!;
    expect([row.markupErrors, row.markupCodes]).toEqual([null, null]);
    expect(cat(db, 'markup-errors')).toEqual([]);
  });

  it('a non-2xx page is not listed', () => {
    const db = open('c');
    put(db, 'https://ex.com/gone', { statusCode: 404, markupErrors: 4, markupCodes: '{"duplicate-id":4}' });
    expect(cat(db, 'markup-errors')).toEqual([]);
    expect(cat(db, 'duplicate-ids')).toEqual([]);
  });

  it('both issues are later checks, grouped as MARKUP_CHECKS', () => {
    expect([...MARKUP_CHECKS]).toEqual(['issues:markup-errors', 'issues:duplicate-ids']);
    for (const k of MARKUP_CHECKS) expect(LATER_CHECKS).toContain(k);
  });

  it('a project at v127 reopens read-only: no rows under the issues, counts 0, url detail NULL', () => {
    const file = path.join(dir, 'old.seoproject');
    const raw = new DatabaseSync(file);
    runMigrations(raw, 127);
    raw.exec(
      `INSERT INTO urls (id, url, is_external, content_kind, status_code, indexability, title) VALUES (1, 'https://ex.com/', 0, 'html', 200, 'indexable', 'T')`,
    );
    raw.close();
    const ro = new ProjectDb(file, { readOnly: true });
    opened.push(ro);
    const o = ro.getOverviewCounts().issues;
    expect([o.markupErrors, o.duplicateIds]).toEqual([0, 0]);
    expect(cat(ro, 'markup-errors')).toEqual([]);
    expect(cat(ro, 'duplicate-ids')).toEqual([]);
    const d = ro.getUrlDetail(1)!;
    expect([d.row.markupErrors, d.row.markupCodes]).toEqual([null, null]);
  });
});
