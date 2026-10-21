import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectDb } from './project-db.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-orph-'));
  file = path.join(dir, 'p.seoproject');
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec(`
    INSERT INTO project_meta (key, value) VALUES ('lastStartUrl', 'https://ex.com/');
    INSERT INTO urls (id, url, is_external, content_kind, status_code) VALUES
      (1, 'https://ex.com/', 0, 'html', 200), (2, 'https://ex.com/a', 0, 'html', 200),
      (3, 'https://ex.com/b', 0, 'html', 200);
    INSERT INTO links (from_url_id, to_url, is_internal) VALUES (1, 'https://ex.com/a', 1);
  `);
  raw.close();
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('orphan count before inlinks were computed', () => {
  it('is null and the category is empty until recomputeInlinks runs', () => {
    const db = new ProjectDb(file);
    expect(db.getOverviewCounts().issues.orphanPage).toBeNull();
    expect([...db.iterateUrlsByCategory('issues:orphan-page')]).toEqual([]);
    db.recomputeInlinks();
    expect(db.getOverviewCounts().issues.orphanPage).toBe(1);
    expect([...db.iterateUrlsByCategory('issues:orphan-page')].map((r) => r.url)).toEqual([
      'https://ex.com/b',
    ]);
    db.close();
  });
});

describe('inlinks flag lifecycle', () => {
  it('a project computed before the flag existed reads as computed after reopening', () => {
    const raw = new DatabaseSync(file);
    raw.exec(`UPDATE urls SET inlinks = 1 WHERE id = 2;
      DELETE FROM project_meta WHERE key = 'inlinksComputed';
      DELETE FROM schema_version WHERE version >= 101;`);
    raw.close();
    const db = new ProjectDb(file);
    expect(db.getOverviewCounts().issues.orphanPage).toBe(1);
    db.close();
  });

  it('a project with no inlinks stays not computed after reopening', () => {
    const db = new ProjectDb(file);
    expect(db.getOverviewCounts().issues.orphanPage).toBeNull();
    db.close();
  });

  it('markInlinksStale makes the count null again', () => {
    const db = new ProjectDb(file);
    db.recomputeInlinks();
    expect(db.getOverviewCounts().issues.orphanPage).toBe(1);
    db.markInlinksStale();
    expect(db.getOverviewCounts().issues.orphanPage).toBeNull();
    db.close();
  });
});
