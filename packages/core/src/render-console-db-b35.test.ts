import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LATER_CHECKS, ProjectDb, runMigrations } from '@freecrawl/db';
import { afterEach, beforeEach, expect, it } from 'vitest';

let dir: string;
const opened: ProjectDb[] = [];
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b35db-'));
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
const cat = (db: ProjectDb, k: string) =>
  db.queryUrls({ limit: 10, offset: 0, category: `issues:${k}` as never }).rows.map((r) => r.url);

it('stores console_errors, failed_resources and console_log and lists the pages under the two issues', () => {
  const db = open('a');
  const page = (url: string, over: Record<string, unknown>) =>
    db.upsertUrl({ url, depth: 0, statusCode: 200, indexability: 'indexable', contentKind: 'html', ...over });
  const id = page('https://ex.com/bad', {
    consoleErrors: 2,
    failedResources: 1,
    consoleLog: '[{"kind":"console","text":"x"}]',
  });
  page('https://ex.com/errors-only', { consoleErrors: 1, failedResources: 0 });
  page('https://ex.com/clean', { consoleErrors: 0, failedResources: 0 });
  page('https://ex.com/unrecorded', {});
  const row = db.getUrlById(id)!;
  expect([row.consoleErrors, row.failedResources, row.consoleLog]).toEqual([2, 1, '[{"kind":"console","text":"x"}]']);
  const un = db.getUrlById(db.getUrlIdByUrl('https://ex.com/unrecorded')!)!;
  expect([un.consoleErrors, un.failedResources, un.consoleLog]).toEqual([null, null, null]);
  expect(cat(db, 'console-errors').sort()).toEqual(['https://ex.com/bad', 'https://ex.com/errors-only']);
  expect(cat(db, 'failed-resources')).toEqual(['https://ex.com/bad']);
  const o = db.getOverviewCounts().issues;
  expect([o.consoleErrors, o.failedResources]).toEqual([2, 1]);
});

it('upserting the same URL again overwrites the three columns, also back to NULL', () => {
  const db = open('b');
  const put = (over: Record<string, unknown>) =>
    db.upsertUrl({ url: 'https://ex.com/p', depth: 0, statusCode: 200, contentKind: 'html', ...over });
  put({ consoleErrors: 3, failedResources: 2, consoleLog: '[1]' });
  put({});
  const row = db.getUrlById(db.getUrlIdByUrl('https://ex.com/p')!)!;
  expect([row.consoleErrors, row.failedResources, row.consoleLog]).toEqual([null, null, null]);
  expect(cat(db, 'console-errors')).toEqual([]);
});

it('a non-2xx page is not listed', () => {
  const db = open('c');
  db.upsertUrl({ url: 'https://ex.com/gone', depth: 0, statusCode: 404, contentKind: 'html', consoleErrors: 4 });
  expect(cat(db, 'console-errors')).toEqual([]);
});

it('the two ids are later checks', () => {
  expect(LATER_CHECKS).toContain('issues:console-errors');
  expect(LATER_CHECKS).toContain('issues:failed-resources');
});

it('a project at v121 reopens with the columns NULL and the counts 0, also read-only', () => {
  const file = path.join(dir, 'old.seoproject');
  const raw = new DatabaseSync(file);
  runMigrations(raw, 121);
  raw.exec(
    `INSERT INTO urls (url, is_external, content_kind, status_code, indexability, title) VALUES ('https://ex.com/', 0, 'html', 200, 'indexable', 'T')`,
  );
  raw.close();
  const ro = new ProjectDb(file, { readOnly: true });
  const o = ro.getOverviewCounts().issues;
  expect([o.consoleErrors, o.failedResources]).toEqual([0, 0]);
  ro.close();
  const db = new ProjectDb(file);
  opened.push(db);
  const row = db.getUrlById(db.getUrlIdByUrl('https://ex.com/')!)!;
  expect([row.consoleErrors, row.failedResources, row.consoleLog]).toEqual([null, null, null]);
  expect(cat(db, 'console-errors')).toEqual([]);
  expect(cat(db, 'failed-resources')).toEqual([]);
});
