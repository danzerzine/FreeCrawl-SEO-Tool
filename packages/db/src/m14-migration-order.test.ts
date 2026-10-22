import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { runMigrations } from './migrations.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-m14mig-'));
  file = path.join(dir, 'p.seoproject');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const colsOf = (raw: DatabaseSync, table: string): string[] =>
  (raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

it('a project file from before migration 121 migrates through 121-125, in that order, keeping its rows', () => {
  const old = new DatabaseSync(file);
  runMigrations(old, 120);
  old.exec(`INSERT INTO urls (id, url, is_external, content_kind, status_code) VALUES (1, 'https://ex.test/', 0, 'html', 200)`);
  expect((old.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v).toBe(120);
  expect(colsOf(old, 'urls')).not.toContain('render_diff');
  old.close();

  const raw = new DatabaseSync(file);
  runMigrations(raw);
  const versions = (
    raw.prepare('SELECT version FROM schema_version WHERE version > 120 ORDER BY applied_at, version').all() as {
      version: number;
    }[]
  ).map((r) => r.version);
  expect(versions.slice(0, 5)).toEqual([121, 122, 123, 124, 125]);
  expect(colsOf(raw, 'urls')).toEqual(expect.arrayContaining(['render_diff', 'console_log']));
  expect(colsOf(raw, 'gsc_inspection_results')).toContain('rich_results_json');
  expect(colsOf(raw, 'ga4_custom_values')).toContain('property');
  expect(colsOf(raw, 'webmaster_events')).toContain('bad_http_status');
  expect(raw.prepare('SELECT COUNT(*) AS c FROM urls').get()).toMatchObject({ c: 1 });
  raw.close();
});
