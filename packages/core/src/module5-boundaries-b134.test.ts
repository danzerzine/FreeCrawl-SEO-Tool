import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (p: string) => { exec(sql: string): void; close(): void } };

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b134-'));
  file = path.join(dir, 'p.seoproject');
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec(`
    INSERT INTO project_meta (key, value) VALUES ('lastStartUrl', 'https://ex.com/');
    INSERT INTO urls (id, url, is_external, content_kind, status_code, title_pixel_width, meta_pixel_width) VALUES
      (1, 'https://ex.com/w0', 0, 'html', 200, 0, 0),
      (2, 'https://ex.com/w199', 0, 'html', 200, 199, 399),
      (3, 'https://ex.com/w200', 0, 'html', 200, 200, 400),
      (4, 'https://ex.com/w600', 0, 'html', 200, 600, 990),
      (5, 'https://ex.com/w601', 0, 'html', 200, 601, 991);
    INSERT INTO urls (id, url, is_external, content_kind, status_code) VALUES
      (10, 'https://ex.com/poisk/?text=a', 0, 'html', 200),
      (11, 'https://ex.com/find/?q=a', 0, 'html', 200),
      (12, 'https://ex.com/search/?q=a', 0, 'html', 200),
      (13, 'https://ex.com/poiskovik/?text=a', 0, 'html', 200),
      (14, 'https://ex.com/finder/?q=a', 0, 'html', 200),
      (15, 'https://ex.com/research/?search=a', 0, 'html', 200),
      (16, 'https://ex.com/poisk/', 0, 'html', 200),
      (17, 'https://ex.com/shop/?q=a', 0, 'html', 200),
      (18, 'https://ex.com/search-tips/?q=a', 0, 'html', 200);
  `);
  raw.close();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const list = (db: ProjectDb, cat: string) =>
  [...db.iterateUrlsByCategory(cat as never)].map((r) => r.url.slice('https://ex.com'.length)).sort();

it('pixel widths: 0 means unmeasured, 199 is below the 200 px limit, 200 is not (B134)', () => {
  const db = new ProjectDb(file);
  expect(list(db, 'issues:title-pixel-width-too-short')).toEqual(['/w199']);
  expect(list(db, 'issues:meta-pixel-width-too-short')).toEqual(['/w199']);
  expect(list(db, 'issues:title-pixel-width-too-long')).toEqual(['/w601']);
  expect(list(db, 'issues:meta-pixel-width-too-long')).toEqual(['/w601']);
  const o = db.getOverviewCounts().issues;
  db.close();
  expect([o.titlePixelWidthTooShort, o.metaPixelWidthTooShort]).toEqual([1, 1]);
});

it('internal search: a search parameter under a whole /search/, /poisk/ or /find/ segment only (B134)', () => {
  const db = new ProjectDb(file);
  expect(list(db, 'issues:url-internal-search')).toEqual(['/find/?q=a', '/poisk/?text=a', '/search/?q=a']);
  db.close();
});
