import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectDb } from './project-db.js';

/**
 * B101: the three alt checks count and list only pages that answered 2xx. A
 * re-crawl where a page became 404 / 301 keeps its image rows, so the counts
 * must not follow them.
 */
let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b101-'));
  file = path.join(dir, 'p.seoproject');
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  const ins = raw.prepare(
    `INSERT INTO urls (id, url, status_code, indexability, content_kind, is_external, images_missing_alt, images_empty_alt)
     VALUES (?, ?, ?, ?, 'html', 0, ?, ?)`,
  );
  ins.run(1, 'https://ex.com/ok', 200, 'indexable', 1, 1);
  ins.run(2, 'https://ex.com/ok2', 200, 'indexable', 0, 0);
  ins.run(3, 'https://ex.com/gone', 404, 'non-indexable:client-error', 1, 1);
  ins.run(4, 'https://ex.com/moved', 301, 'non-indexable:redirect', 1, 1);
  const img = raw.prepare('INSERT INTO images (id, src, is_internal, occurrences) VALUES (?, ?, 1, 1)');
  for (let i = 1; i <= 8; i++) img.run(i, `https://ex.com/i${i}.png`);
  const use = raw.prepare('INSERT INTO image_usages (from_url_id, image_id, alt) VALUES (?, ?, ?)');
  use.run(1, 1, null); // missing, on a 200 page
  use.run(1, 2, ''); // empty, on a 200 page
  use.run(1, 3, 'dup'); // duplicate pair, both on 200 pages
  use.run(2, 4, 'dup');
  use.run(3, 1, null); // same defects on a 404 page
  use.run(3, 2, '');
  use.run(4, 5, null); // and on a redirected page
  use.run(4, 6, '');
  use.run(1, 7, 'mix'); // alt shared only with an image on a 404 page: not a duplicate
  use.run(3, 8, 'mix');
  raw.close();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('alt checks status gate (B101)', () => {
  it('the sidebar counts only usages on 2xx pages', () => {
    const db = new ProjectDb(file);
    const issues = db.getOverviewCounts().issues as unknown as Record<string, number>;
    db.close();
    expect(issues.imageMissingAlt).toBe(1);
    expect(issues.imageEmptyAlt).toBe(1);
    expect(issues.imageDuplicateAlt).toBe(2);
  });

  it('the Images tab lists the same rows as the counts', () => {
    const db = new ProjectDb(file);
    const q = (f: object) => db.queryImages({ limit: 100, offset: 0, ...f }).rows.map((r) => r.fromUrl);
    expect(q({ missingAltOnly: true })).toEqual(['https://ex.com/ok']);
    expect(q({ emptyAltOnly: true })).toEqual(['https://ex.com/ok']);
    expect(q({ duplicateAltOnly: true }).sort()).toEqual(['https://ex.com/ok', 'https://ex.com/ok2']);
    expect([...db.iterateImages({ missingAltOnly: true })].length).toBe(1);
    expect([...db.iterateImages({ duplicateAltOnly: true })].length).toBe(2);
    db.close();
  });

  it('the page lists of the three checks hold only 2xx pages', () => {
    const db = new ProjectDb(file);
    const urls = (c: string) => [...db.iterateUrlsByCategory(c as never)].map((r) => r.url).sort();
    expect(urls('issues:image-missing-alt')).toEqual(['https://ex.com/ok']);
    expect(urls('issues:image-empty-alt')).toEqual(['https://ex.com/ok']);
    expect(urls('issues:image-duplicate-alt')).toEqual(['https://ex.com/ok', 'https://ex.com/ok2']);
    db.close();
  });
});
