import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProjectDb } from '@freecrawl/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { datasetRows } from './dataset-export.js';
import { exportIssueInlinks, runBulkExport } from './bulk-export.js';
import { parseExportWhat } from './export-items.js';
import { ISSUE_CATEGORIES } from '@freecrawl/shared-types';

// Bare fixture rows trip many cheap checks; keep only the checks under test.
const allBut = (...keep: string[]): string[] => ISSUE_CATEGORIES.filter((c) => !keep.includes(c));
const KEPT = ['issues:duplicate-url-post-norm', 'issues:canonical-chain-multi-hop', 'issues:image-too-large'];

let dir: string;
let file: string;
let db: ProjectDb;

// 3 pages with issues:duplicate-url-post-norm (ids 1..3), linked from 5 pages (ids 11..15),
// each source linking every target once → 15 inlink rows. Page 2 redirects to 4.
// Page 5 has issues:canonical-chain-multi-hop but no inlinks; page 1 also has issues:image-too-large
// (disabled in one test).
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b13-'));
  file = path.join(dir, 'p.seoproject');
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec(`
    INSERT INTO urls (id, url, status_code, indexability, redirect_final_url) VALUES
      (1,'https://ex.com/t1',200,'indexable',NULL),
      (2,'https://ex.com/t2',301,'non-indexable:redirect','https://ex.com/t4'),
      (3,'https://ex.com/t3',200,'indexable',NULL),
      (4,'https://ex.com/t4',200,'indexable',NULL),
      (5,'https://ex.com/lonely',200,'indexable',NULL);
  `);
  const insUrl = raw.prepare('INSERT INTO urls (id, url, status_code) VALUES (?, ?, 200)');
  const insLink = raw.prepare(
    'INSERT INTO links (from_url_id, to_url, anchor, rel, is_internal, link_position) VALUES (?, ?, ?, ?, 1, ?)',
  );
  for (let s = 11; s <= 15; s++) {
    insUrl.run(s, `https://ex.com/s${s}`);
    for (const t of [1, 2, 3]) {
      insLink.run(
        s,
        `https://ex.com/t${t}`,
        `a${s}-${t}`,
        s === 15 ? 'nofollow' : null,
        s % 2 === 0 ? 'footer' : 'content',
      );
    }
  }
  raw.exec(`
    INSERT INTO urls_issues (url_id, issue_key) VALUES
      (1,'issues:duplicate-url-post-norm'),(2,'issues:duplicate-url-post-norm'),(3,'issues:duplicate-url-post-norm'),
      (5,'issues:canonical-chain-multi-hop'),(1,'issues:image-too-large');
  `);
  raw.close();
  db = new ProjectDb(file);
  db.setDisabledIssues(allBut(...KEPT));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function readCsv(p: string): string[][] {
  return fs
    .readFileSync(p, 'utf8')
    .replace(/^﻿/, '')
    .trimEnd()
    .split('\n')
    .map((l) => l.split(','));
}

describe('B13 issue inlinks', () => {
  it('dataset for one issue: every inlink to every page with it', () => {
    const rows = [...datasetRows(db, 'issue-inlinks', { issueKey: 'issues:duplicate-url-post-norm' })];
    expect(rows).toHaveLength(15);
    expect(rows[0]).toEqual({
      issueKey: 'issues:duplicate-url-post-norm',
      toUrl: 'https://ex.com/t1',
      toStatusCode: 200,
      toStatus: 'OK',
      toSize: null,
      toFinalUrl: null,
      toFinalStatusCode: null,
      fromUrl: 'https://ex.com/s11',
      fromStatusCode: 200,
      type: 'hyperlink',
      anchor: 'a11-1',
      altText: null,
      rel: null,
      follow: true,
      target: null,
      pathType: null,
      linkPath: null,
      linkPosition: 'content',
      linkOrigin: 'html',
    });
    const t2 = rows.find((r) => r.toUrl === 'https://ex.com/t2' && r.fromUrl === 'https://ex.com/s15');
    expect(t2).toMatchObject({ toFinalUrl: 'https://ex.com/t4', toFinalStatusCode: 200, follow: false });
  });

  it('dataset without an issue key covers every enabled issue', () => {
    db.setDisabledIssues(allBut('issues:duplicate-url-post-norm', 'issues:canonical-chain-multi-hop'));
    const keys = new Set([...datasetRows(db, 'issue-inlinks')].map((r) => r.issueKey));
    expect([...keys]).toEqual(['issues:duplicate-url-post-norm']);
  });

  it('bulk leaves issue inlinks out (tens of GB on a big site): on request only', async () => {
    const out = path.join(dir, 'bulk');
    fs.mkdirSync(out);
    const result = await runBulkExport(db, out);
    expect(result.errors).toEqual([]);
    expect(fs.existsSync(path.join(out, 'issue-inlinks'))).toBe(false);
    expect(result.files.some((f) => f.dataset === 'issue-inlinks')).toBe(false);
  });

  it('the issue inlinks export writes one file per issue, skipping empty and disabled ones', async () => {
    db.setDisabledIssues(allBut('issues:duplicate-url-post-norm', 'issues:canonical-chain-multi-hop'));
    const out = path.join(dir, 'out');
    fs.mkdirSync(out);
    const result = await exportIssueInlinks(db, out);
    expect(result.errors).toEqual([]);
    const sub = path.join(out, 'issue-inlinks');
    expect(fs.readdirSync(sub)).toEqual(['inlinks-duplicate-url-post-norm.csv']);
    const csv = readCsv(path.join(sub, 'inlinks-duplicate-url-post-norm.csv'));
    expect(csv[0]).toEqual(expect.arrayContaining(['Source', 'Anchor', 'Link Position', 'Destination']));
    expect(csv).toHaveLength(1 + 15);
    const src = csv[0]!.indexOf('Source');
    expect(new Set(csv.slice(1).map((r) => r[src])).size).toBe(5);
    const file = result.files.find((f) => f.filePath.endsWith('inlinks-duplicate-url-post-norm.csv'));
    expect(file).toMatchObject({ rowsWritten: 15, dataset: 'issue-inlinks' });
  });
});

describe('issue inlinks of chosen checks', () => {

  it('parses issue-inlinks:<check> and rejects unknown checks', () => {
    expect(parseExportWhat('issue-inlinks:duplicate-url-post-norm')).toEqual([
      { kind: 'issue-inlinks', name: 'issue-inlinks:duplicate-url-post-norm', issueKeys: ['issues:duplicate-url-post-norm'] },
    ]);
    expect(() => parseExportWhat('issue-inlinks:no-such-check')).toThrow(/Unknown check/);
    expect(() => parseExportWhat('issue-inlinks:../../x')).toThrow(/Unknown check/);
  });

  it('writes only the chosen check and keeps other checks files from an earlier run', async () => {
    const out = path.join(dir, 'out');
    const sub = path.join(out, 'issue-inlinks');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'inlinks-h1-missing.csv'), 'old');
    const [item] = parseExportWhat('issue-inlinks:duplicate-url-post-norm');
    const result = await exportIssueInlinks(db, out, { issueKeys: item!.kind === 'issue-inlinks' ? item!.issueKeys : [] });
    expect(result.errors).toEqual([]);
    expect(fs.readdirSync(sub).sort()).toEqual(['inlinks-duplicate-url-post-norm.csv', 'inlinks-h1-missing.csv']);
    expect(result.files.map((f) => path.basename(f.filePath))).toEqual(['inlinks-duplicate-url-post-norm.csv']);
  });
});
