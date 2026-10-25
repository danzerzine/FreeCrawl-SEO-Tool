import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { MIGRATIONS, runMigrations } from './migrations.js';
import { ProjectDb } from './project-db.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-up111-'));
  file = path.join(dir, 'p.seoproject');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const colsOf = (raw: DatabaseSync, table: string): string[] =>
  (raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
const versionsOf = (raw: DatabaseSync): number[] =>
  (raw.prepare('SELECT version FROM schema_version ORDER BY version').all() as { version: number }[]).map(
    (r) => r.version,
  );
const allVersions = MIGRATIONS.map((m) => m.version).sort((a, b) => a - b);
const tablesOf = (raw: DatabaseSync): string[] =>
  (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
    (r) => r.name,
  );

it('migration versions are distinct and ascending', () => {
  const versions = MIGRATIONS.map((m) => m.version);
  expect(versions).toEqual([...versions].sort((a, b) => a - b));
  expect(new Set(versions).size).toBe(versions.length);
  expect(versions.slice(-3)).toEqual([133, 134, 135]);
});

it('a project file from the build before the merge (up to 132) gains the 1.1.1 columns', () => {
  const old = new DatabaseSync(file);
  runMigrations(old, 132);
  old.exec(`INSERT INTO urls (id, url, is_external, content_kind, status_code) VALUES (1, 'https://ex.test/', 0, 'html', 200)`);
  expect(colsOf(old, 'host_certs')).not.toContain('legacy_protocol');
  old.close();

  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  expect(versionsOf(raw)).toEqual(allVersions);
  expect(colsOf(raw, 'host_certs')).toContain('legacy_protocol');
  expect(colsOf(raw, 'image_usages')).toContain('lazy');
  expect(colsOf(raw, 'urls')).toEqual(expect.arrayContaining(['og_image_src', 'twitter_image_src']));
  expect(raw.prepare('SELECT COUNT(*) AS c FROM urls').get()).toMatchObject({ c: 1 });
  raw.close();
});

it('a project file written by upstream 1.1.1 (its own 101-103) still gets this build’s 101-132', () => {
  // Upstream 1.1.1's schema: the common schema up to 100 plus its three column migrations, recorded as 101-103.
  const up = new DatabaseSync(file);
  runMigrations(up, 100);
  up.exec(`
    ALTER TABLE host_certs ADD COLUMN legacy_protocol TEXT;
    ALTER TABLE image_usages ADD COLUMN lazy INTEGER;
    ALTER TABLE urls ADD COLUMN og_image_src TEXT;
    ALTER TABLE urls ADD COLUMN twitter_image_src TEXT;
    INSERT INTO schema_version (version) VALUES (101), (102), (103);
    INSERT INTO urls (id, url, is_external, content_kind, status_code, inlinks) VALUES
      (1, 'https://ex.test/', 0, 'html', 200, 3);
  `);
  expect(colsOf(up, 'urls')).not.toContain('broken_bookmarks');
  expect(tablesOf(up)).not.toContain('uncrawlable_links');
  up.close();

  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  expect(versionsOf(raw)).toEqual(allVersions);
  // This build's 101-103.
  expect(raw.prepare("SELECT value FROM project_meta WHERE key = 'inlinksComputed'").get()).toMatchObject({
    value: '1',
  });
  expect(colsOf(raw, 'urls')).toContain('broken_bookmarks');
  expect(tablesOf(raw)).toContain('uncrawlable_links');
  // Upstream's columns kept.
  expect(colsOf(raw, 'host_certs')).toContain('legacy_protocol');
  expect(colsOf(raw, 'image_usages')).toContain('lazy');
  expect(raw.prepare('SELECT COUNT(*) AS c FROM urls').get()).toMatchObject({ c: 1 });
  raw.close();

  // Opening again changes nothing.
  new ProjectDb(file).close();
  const again = new DatabaseSync(file);
  expect(versionsOf(again)).toEqual(allVersions);
  again.close();
});
