import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EXPENSIVE_ISSUE_DEFINITIONS, ProjectDb } from '@freecrawl/db';
import { issueCategoriesBySeverity } from '@freecrawl/shared-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportIssuesSummary } from './report-export.js';

let dir: string;
let db: ProjectDb;

// Page a: one target=_blank link without noopener, nothing else at info level.
// Page b: the same link plus an H1 over 70 characters (another info check).
// Both link the same external target. Every other info check is switched
// off, so a bare fixture row has no other info finding.
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b66-'));
  const file = path.join(dir, 'p.seoproject');
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec(`
    INSERT INTO urls (id, url, is_external, content_kind, status_code, indexability, title, h1, h1_length, target_blank_no_noopener_count) VALUES
      (1,'https://ex.com/a',0,'html',200,'indexable','A','A',1,1),
      (2,'https://ex.com/b',0,'html',200,'indexable','B','${'b'.repeat(80)}',80,1);
    INSERT INTO urls (id, url, is_external, content_kind, status_code, indexability) VALUES
      (3,'https://other.test/x',1,'other',200,'indexable');
    INSERT INTO links (from_url_id, to_url, anchor, is_internal, target) VALUES
      (1,'https://other.test/x','x',0,'_blank'),(2,'https://other.test/x','x',0,'_blank');
  `);
  raw.close();
  db = new ProjectDb(file);
  db.applyCrawlConfigFlags({
    disabledIssues: issueCategoriesBySeverity('info').filter(
      (c) => c !== 'issues:target-blank-no-noopener' && c !== 'issues:h1-too-long',
    ),
  });
  db.recomputeUrlsIssues(EXPENSIVE_ISSUE_DEFINITIONS);
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const list = (cat: Parameters<ProjectDb['iterateUrlsByCategory']>[0]) =>
  [...db.iterateUrlsByCategory(cat)].map((r) => r.url).sort();

describe('target=_blank without noopener stays out of page totals (B66)', () => {
  it('a page whose only info finding is that link is in the check, not in the info rollup', () => {
    expect(list('issues:target-blank-no-noopener')).toEqual(['https://ex.com/a', 'https://ex.com/b']);
    expect(list('issues:severity-info')).toEqual(['https://ex.com/b']);
  });

  it('issues summary still lists the check at info with its pages and targets', async () => {
    const out = path.join(dir, 's.csv');
    await exportIssuesSummary(db, out);
    const row = fs
      .readFileSync(out, 'utf8')
      .split('\n')
      .find((r) => r.startsWith('issues:target-blank-no-noopener,'));
    // Severity, URLs, Items: before the trailing Previous and Change (B23).
    expect(row?.split(',').slice(-5, -2)).toEqual(['info', '2', '1']);
  });
});
