import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectDb } from './project-db.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-cat-'));
  file = path.join(dir, 'p.seoproject');
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec(`
    INSERT INTO urls (id, url, is_external) VALUES
      (1, 'https://ex.com/a', 0), (2, 'https://ex.com/b', 0),
      (3, 'https://ex.com/c', 0), (4, 'https://other.com/', 1);
    INSERT INTO images (id, src, alt, occurrences) VALUES
      (1, 'https://ex.com/1.jpg', 'logo', 1), (2, 'https://ex.com/2.jpg', 'logo', 1),
      (3, 'https://ex.com/3.jpg', 'unique', 1);
    INSERT INTO image_usages (from_url_id, image_id, alt) VALUES
      (1, 1, 'logo'), (2, 2, 'logo'), (3, 3, 'unique');
  `);
  raw.close();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('category filters', () => {
  it('issues:image-duplicate-alt lists only pages using a shared alt, not every URL', () => {
    const db = new ProjectDb(file);
    const urls = [...db.iterateUrlsByCategory('issues:image-duplicate-alt')].map((r) => r.url);
    db.close();
    expect(urls.sort()).toEqual(['https://ex.com/a', 'https://ex.com/b']);
  });
});
