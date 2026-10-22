import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProjectDb, runMigrations } from '@freecrawl/db';
import { afterEach, beforeEach, expect, it } from 'vitest';

let dir: string;
const opened: ProjectDb[] = [];
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b33db-'));
});
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
const open = (name: string, readOnly = false): ProjectDb => {
  const db = new ProjectDb(path.join(dir, `${name}.seoproject`), { readOnly });
  opened.push(db);
  return db;
};
const ids = [
  'h1-changed-by-js',
  'canonical-changed-by-js',
  'links-changed-by-js',
  'text-changed-by-js',
] as const;
const cat = (db: ProjectDb, k: string) =>
  db.queryUrls({ limit: 10, offset: 0, category: `issues:${k}` as never }).rows.map((r) => r.url);

it('stores the four JS verdicts and render_diff and lists the pages under the four issues', () => {
  const db = open('a');
  const page = (url: string, over: Record<string, unknown>) =>
    db.upsertUrl({ url, depth: 0, statusCode: 200, indexability: 'indexable', contentKind: 'html', ...over });
  const id = page('https://ex.com/changed', {
    jsH1Changed: 1,
    jsCanonicalChanged: 1,
    jsLinksChanged: 1,
    jsTextChanged: 1,
    renderDiff: '{"h1":{"served":"a","rendered":"b"}}',
  });
  page('https://ex.com/equal', {
    jsH1Changed: 0,
    jsCanonicalChanged: 0,
    jsLinksChanged: 0,
    jsTextChanged: 0,
  });
  page('https://ex.com/unchecked', {});
  const row = db.getUrlById(id)!;
  expect([row.jsH1Changed, row.jsCanonicalChanged, row.jsLinksChanged, row.jsTextChanged]).toEqual([
    1, 1, 1, 1,
  ]);
  expect(row.renderDiff).toBe('{"h1":{"served":"a","rendered":"b"}}');
  const un = db.getUrlById(db.getUrlIdByUrl('https://ex.com/unchecked')!)!;
  expect([un.jsH1Changed, un.jsCanonicalChanged, un.jsLinksChanged, un.jsTextChanged, un.renderDiff]).toEqual([
    null, null, null, null, null,
  ]);
  for (const k of ids) expect(cat(db, k)).toEqual(['https://ex.com/changed']);
  const o = db.getOverviewCounts().issues;
  expect([o.h1ChangedByJs, o.canonicalChangedByJs, o.linksChangedByJs, o.textChangedByJs]).toEqual([
    1, 1, 1, 1,
  ]);
});

it('a non-2xx page is not listed', () => {
  const db = open('b');
  db.upsertUrl({ url: 'https://ex.com/gone', depth: 0, statusCode: 404, contentKind: 'html', jsH1Changed: 1 });
  expect(cat(db, 'h1-changed-by-js')).toEqual([]);
});

it('a project at v120 reopens with the new columns NULL, the four counts 0, also read-only', () => {
  const file = path.join(dir, 'old.seoproject');
  const raw = new DatabaseSync(file);
  runMigrations(raw, 120);
  raw.exec(
    `INSERT INTO urls (url, is_external, content_kind, status_code, indexability, title) VALUES ('https://ex.com/', 0, 'html', 200, 'indexable', 'T')`,
  );
  raw.close();
  const ro = new ProjectDb(file, { readOnly: true });
  const o = ro.getOverviewCounts().issues;
  expect([o.h1ChangedByJs, o.canonicalChangedByJs, o.linksChangedByJs, o.textChangedByJs]).toEqual([
    0, 0, 0, 0,
  ]);
  ro.close();
  const db = new ProjectDb(file);
  opened.push(db);
  const row = db.getUrlById(db.getUrlIdByUrl('https://ex.com/')!)!;
  expect([row.jsH1Changed, row.jsCanonicalChanged, row.jsLinksChanged, row.jsTextChanged, row.renderDiff]).toEqual([
    null, null, null, null, null,
  ]);
  for (const k of ids) expect(cat(db, k)).toEqual([]);
});
