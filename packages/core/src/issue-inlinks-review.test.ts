import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProjectDb } from '@freecrawl/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportIssueInlinks } from './bulk-export.js';
import { ISSUE_CATEGORIES } from '@freecrawl/shared-types';

// Bare fixture rows trip many cheap checks; keep only the checks under test.
const allBut = (...keep: string[]): string[] => ISSUE_CATEGORIES.filter((c) => !keep.includes(c));
const KEPT = ['issues:duplicate-url-post-norm', 'issues:canonical-chain-multi-hop', 'issues:image-too-large'];

let dir: string;
let file: string;
let out: string;

// Page 1 has issues:duplicate-url-post-norm and is linked from page 11; the project
// also stores issue keys no check produces (a crafted or foreign project).
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b2-'));
  file = path.join(dir, 'p.seoproject');
  out = path.join(dir, 'a', 'b', 'out');
  fs.mkdirSync(out, { recursive: true });
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec(`
    INSERT INTO urls (id, url, status_code) VALUES
      (1,'https://ex.com/t1',200),(11,'https://ex.com/s11',200);
    INSERT INTO links (from_url_id, to_url, anchor, is_internal) VALUES (11,'https://ex.com/t1','x',1);
    INSERT INTO urls_issues (url_id, issue_key) VALUES
      (1,'issues:duplicate-url-post-norm'),(1,'issues:../../../evil'),(1,'issues:not-a-check');
  `);
  raw.close();
  const d = new ProjectDb(file);
  d.setDisabledIssues(allBut(...KEPT));
  d.close();
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const listAll = (root: string): string[] =>
  fs.readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => path.relative(root, path.join(d.parentPath, d.name)))
    .sort();

describe('exportIssueInlinks file names (B2)', () => {
  it('writes files only for checks of the issue catalogue, inside issue-inlinks/', async () => {
    const db = new ProjectDb(file);
    const res = await exportIssueInlinks(db, out);
    db.close();
    expect(res.errors).toEqual([]);
    expect(listAll(dir).filter((f) => !f.startsWith('p.seoproject'))).toEqual([
      path.join('a', 'b', 'out', 'issue-inlinks', 'inlinks-duplicate-url-post-norm.csv'),
    ]);
  });
});

describe('exportIssueInlinks rerun (B3)', () => {
  it('removes inlinks files of issues that are gone, keeps other files', async () => {
    const sub = path.join(out, 'issue-inlinks');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, 'inlinks-canonical-chain-multi-hop.csv'), 'stale\n');
    fs.writeFileSync(path.join(sub, 'notes.txt'), 'mine\n');
    const db = new ProjectDb(file);
    await exportIssueInlinks(db, out);
    db.close();
    expect(fs.readdirSync(sub).sort()).toEqual(['inlinks-duplicate-url-post-norm.csv', 'notes.txt']);
  });

  it('a project with no issue inlinks left clears the old files and the folder', async () => {
    const sub = path.join(out, 'issue-inlinks');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, 'inlinks-canonical-chain-multi-hop.csv'), 'stale\n');
    const raw = new DatabaseSync(file);
    raw.exec('DELETE FROM urls_issues');
    raw.close();
    const db = new ProjectDb(file);
    await exportIssueInlinks(db, out);
    db.close();
    expect(fs.existsSync(sub)).toBe(false);
  });
});
