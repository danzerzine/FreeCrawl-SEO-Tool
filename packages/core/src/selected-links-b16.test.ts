import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProjectDb } from '@freecrawl/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { datasetRows } from './dataset-export.js';

let dir: string;
let file: string;
let db: ProjectDb;

// A and B are chosen; C, D are not. Links: C->A, D->A, A->B, A->C, B->A, D->C.
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b16-'));
  file = path.join(dir, 'p.seoproject');
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec(`
    INSERT INTO urls (id, url, status_code, redirect_final_url) VALUES
      (1,'https://ex.com/a',301,'https://ex.com/c'),(2,'https://ex.com/b',200,NULL),
      (3,'https://ex.com/c',200,NULL),(4,'https://ex.com/d',200,NULL);
    INSERT INTO links (from_url_id, to_url, anchor, is_internal) VALUES
      (3,'https://ex.com/a','c-a',1),(4,'https://ex.com/a','d-a',1),
      (1,'https://ex.com/b','a-b',1),(1,'https://ex.com/c','a-c',1),
      (2,'https://ex.com/a','b-a',1),(4,'https://ex.com/c','d-c',1);
  `);
  raw.close();
  db = new ProjectDb(file);
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('selected-inlinks / selected-outlinks', () => {
  const ctx = { urls: ['https://ex.com/a', 'https://ex.com/b', 'https://ex.com/missing'] };

  it('inlinks: only links into the chosen pages, with final destination', () => {
    const rows = [...datasetRows(db, 'selected-inlinks', ctx)];
    expect(rows.map((r) => `${r.fromUrl}>${r.toUrl}`).sort()).toEqual([
      'https://ex.com/a>https://ex.com/b',
      'https://ex.com/b>https://ex.com/a',
      'https://ex.com/c>https://ex.com/a',
      'https://ex.com/d>https://ex.com/a',
    ]);
    const intoA = rows.find((r) => r.fromUrl === 'https://ex.com/c');
    expect(intoA).toMatchObject({
      toStatusCode: 301,
      toFinalUrl: 'https://ex.com/c',
      toFinalStatusCode: 200,
      fromStatusCode: 200,
    });
  });

  it('outlinks: only links out of the chosen pages, ids accepted too', () => {
    const rows = [...datasetRows(db, 'selected-outlinks', { urlIds: [1, 2, 99] })];
    expect(rows.map((r) => `${r.fromUrl}>${r.toUrl}`).sort()).toEqual([
      'https://ex.com/a>https://ex.com/b',
      'https://ex.com/a>https://ex.com/c',
      'https://ex.com/b>https://ex.com/a',
    ]);
  });

  it('uses the links indexes, no table scan', () => {
    const raw = new DatabaseSync(file);
    const plan = (sql: string): string =>
      (raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(1) as { detail: string }[])
        .map((r) => r.detail)
        .join('\n');
    expect(plan('SELECT * FROM links l WHERE l.to_url = ? ORDER BY l.id')).toContain('idx_links_to');
    expect(plan('SELECT * FROM links l WHERE l.from_url_id = ? ORDER BY l.id')).toContain('idx_links_from');
    raw.close();
  });
});
