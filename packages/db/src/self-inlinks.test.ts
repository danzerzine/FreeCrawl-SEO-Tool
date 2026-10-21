import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectDb } from './project-db.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-self-'));
  file = path.join(dir, 'p.seoproject');
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec(`
    INSERT INTO project_meta (key, value) VALUES ('lastStartUrl', 'https://ex.com/');
    INSERT INTO urls (id, url, is_external, content_kind, status_code) VALUES
      (1, 'https://ex.com/', 0, 'html', 200), (2, 'https://ex.com/a', 0, 'html', 200),
      (3, 'https://ex.com/b', 0, 'html', 200), (4, 'https://ex.com/c', 0, 'html', 200);
    INSERT INTO links (from_url_id, to_url, is_internal) VALUES
      (2, 'https://ex.com/a', 1),
      (3, 'https://ex.com/c', 1), (4, 'https://ex.com/c', 1);
  `);
  raw.close();
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('recomputeInlinks self-links', () => {
  it('a self-link is not an inlink; a link from another page is', () => {
    const db = new ProjectDb(file);
    db.recomputeInlinks();
    const raw = new DatabaseSync(file);
    const inl = Object.fromEntries(
      (raw.prepare('SELECT url, inlinks FROM urls').all() as { url: string; inlinks: number }[]).map(
        (r) => [r.url, r.inlinks],
      ),
    );
    const selfRows = raw.prepare('SELECT COUNT(*) AS c FROM links WHERE from_url_id = 2').get() as { c: number };
    raw.close();
    const orphans = [...db.iterateUrlsByCategory('issues:orphan-page')].map((r) => r.url).sort();
    db.close();
    expect(inl['https://ex.com/a']).toBe(0);
    expect(inl['https://ex.com/c']).toBe(1);
    expect(selfRows.c).toBe(1);
    expect(orphans).toEqual(['https://ex.com/a', 'https://ex.com/b']);
  });
});
