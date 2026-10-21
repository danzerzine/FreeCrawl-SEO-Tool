import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProjectDb } from '@freecrawl/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { datasetRows } from './dataset-export.js';
import { exportIssueInlinks } from './bulk-export.js';

let dir: string;
let file: string;
let db: ProjectDb;

// Cheap checks only: urls_issues stays empty, as on a real crawl where
// only the expensive checks are materialised.
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b54x-'));
  file = path.join(dir, 'p.seoproject');
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec(`
    INSERT INTO urls (id, url, status_code, indexability, content_kind, is_external, title, title_length,
                      meta_description, canonical, h1, images_missing_alt) VALUES
      (1,'https://ex.com/a',200,'indexable','html',0,'A title that is long enough here',32,NULL,NULL,'A',3),
      (2,'https://ex.com/b',200,'indexable','html',0,'B title that is long enough here',32,NULL,NULL,'B',0),
      (3,'https://ex.com/c',200,'indexable','html',0,'C title that is long enough here',32,'desc','https://ex.com/c','C',0);
    INSERT INTO links (from_url_id, to_url, anchor, is_internal) VALUES
      (3,'https://ex.com/a','x',1),(3,'https://ex.com/b','y',1);
    DELETE FROM urls_issues;
  `);
  raw.close();
  db = new ProjectDb(file);
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const pairs = (): string[][] => [...datasetRows(db, 'issues-long')].map((r) => [String(r.url), String(r.issueKey)]);

describe('issues-long covers every enabled check (B54x)', () => {
  it('lists pages of cheap checks that urls_issues does not hold', () => {
    const rows = pairs();
    expect(rows).toContainEqual(['https://ex.com/a', 'issues:canonical-missing']);
    expect(rows).toContainEqual(['https://ex.com/b', 'issues:canonical-missing']);
    expect(rows).toContainEqual(['https://ex.com/a', 'issues:meta-missing']);
    expect(rows).toContainEqual(['https://ex.com/b', 'issues:meta-missing']);
    expect(rows).not.toContainEqual(['https://ex.com/c', 'issues:meta-missing']);
  });
  it('a per-image check yields the page once', () => {
    const alt = pairs().filter(([, k]) => k === 'issues:image-missing-alt');
    expect(alt).toEqual([['https://ex.com/a', 'issues:image-missing-alt']]);
  });
  it('orders by check, then URL id, with each (url, check) once', () => {
    const rows = pairs();
    const meta = rows.filter(([, k]) => k === 'issues:meta-missing').map(([u]) => u);
    expect(meta).toEqual(['https://ex.com/a', 'https://ex.com/b']);
    expect(new Set(rows.map((r) => r.join('|'))).size).toBe(rows.length);
    const seen: string[] = [];
    for (const [, k = ""] of rows) if (seen.at(-1) !== k) seen.push(k);
    expect(new Set(seen).size).toBe(seen.length);
  });
  it('skips disabled checks', () => {
    db.setDisabledIssues(['issues:canonical-missing']);
    expect(pairs().some(([, k]) => k === 'issues:canonical-missing')).toBe(false);
    expect(pairs().some(([, k]) => k === 'issues:meta-missing')).toBe(true);
  });
});

describe('issue-inlinks covers every enabled check (B54x)', () => {
  it('writes a file for a cheap check with pages', async () => {
    const out = path.join(dir, 'out');
    const res = await exportIssueInlinks(db, out);
    expect(res.errors).toEqual([]);
    const files = fs.readdirSync(path.join(out, 'issue-inlinks'));
    expect(files).toContain('inlinks-canonical-missing.csv');
    expect(files).toContain('inlinks-meta-missing.csv');
    const csv = fs.readFileSync(path.join(out, 'issue-inlinks', 'inlinks-meta-missing.csv'), 'utf8');
    expect(csv).toContain('https://ex.com/a');
    expect(csv).toContain('https://ex.com/b');
  });
  it('dataset rows for one cheap check', () => {
    const rows = [...datasetRows(db, 'issue-inlinks', { issueKey: 'issues:meta-missing' })];
    expect(rows.length).toBe(2);
  });
  it('no file for a disabled check', async () => {
    db.setDisabledIssues(['issues:meta-missing']);
    const out = path.join(dir, 'out2');
    await exportIssueInlinks(db, out);
    expect(fs.readdirSync(path.join(out, 'issue-inlinks'))).not.toContain('inlinks-meta-missing.csv');
  });
});
