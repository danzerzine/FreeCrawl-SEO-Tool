import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProjectDb } from '@freecrawl/db';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { compareCrawls } from './compare.js';

let dir: string;
const opened: ProjectDb[] = [];
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-m5r1-'));
});
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Internal HTML rows: [url, status, words, title px, description px]. `old` strips what newer builds added. */
function project(
  name: string,
  rows: [string, number, number, number, number][],
  old = false,
): string {
  const file = path.join(dir, `${name}.seoproject`);
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  const ins = raw.prepare(
    `INSERT INTO urls (url, is_external, content_kind, status_code, indexability, title, word_count, title_pixel_width, meta_pixel_width)
     VALUES (?, 0, 'html', ?, ?, 'T', ?, ?, ?)`,
  );
  for (const [url, status, words, tpx, mpx] of rows)
    ins.run(url, status, status === 200 ? 'indexable' : 'non-indexable', words, tpx, mpx);
  if (old) {
    raw.exec('DROP TABLE sitemap_url_sources; DROP TABLE sitemap_files;');
    raw.exec('ALTER TABLE urls DROP COLUMN main_word_count');
  }
  raw.close();
  return file;
}

const open = (file: string, readOnly = false): ProjectDb => {
  const db = new ProjectDb(file, { readOnly });
  opened.push(db);
  return db;
};
const urls = (db: ProjectDb, category: string) =>
  db
    .queryUrls({ limit: 10, offset: 0, category: category as never })
    .rows.map((r) => r.url);

it('pixel-width "too short" checks count 2xx pages only', () => {
  const db = open(
    project('gate', [
      ['https://ex.com/ok', 200, 500, 50, 50],
      ['https://ex.com/missing', 404, 500, 50, 50],
    ]),
  );
  expect(urls(db, 'issues:title-pixel-width-too-short')).toEqual(['https://ex.com/ok']);
  expect(urls(db, 'issues:meta-pixel-width-too-short')).toEqual(['https://ex.com/ok']);
  const o = db.getOverviewCounts().issues;
  expect([o.titlePixelWidthTooShort, o.metaPixelWidthTooShort]).toEqual([1, 1]);
});

it('a project from an older build opened read-only: overview, thin and empty content, compare', () => {
  const rows: [string, number, number, number, number][] = [
    ['https://ex.com/thin', 200, 10, 300, 500],
    ['https://ex.com/full', 200, 900, 300, 500],
  ];
  const oldDb = open(project('old', rows, true), true);
  const o = oldDb.getOverviewCounts();
  expect(o.site?.sitemapFindings ?? null).toBeNull();
  expect(urls(oldDb, 'issues:content-thin')).toEqual(['https://ex.com/thin']);
  expect(urls(oldDb, 'issues:page-empty')).toEqual(['https://ex.com/thin']);
  expect(o.issues.pageEmpty).toBe(1);
  const s = compareCrawls(oldDb, open(project('new', rows)));
  expect(Object.keys(s.notComparable)).not.toContain('issues:content-thin');
  expect(Object.keys(s.notComparable)).not.toContain('issues:page-empty');
});
