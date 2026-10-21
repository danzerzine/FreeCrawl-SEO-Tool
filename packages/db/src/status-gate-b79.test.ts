import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXPENSIVE_ISSUE_DEFINITIONS, ProjectDb, STATUS_GATED_ISSUES, categoryWhereClause } from './project-db.js';

/**
 * B79: checks that read the HTTP response or the HTML body count only pages
 * that answered 2xx; URL-text checks and redirect checks keep their scope; the
 * crawl summary's indexability counts fetched internal HTML pages only.
 */
let dir: string;
let file: string;

function seed(): void {
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  const ins = raw.prepare(
    `INSERT INTO urls (id, url, status_code, indexability, content_kind, is_external, http_protocol,
                       response_time_ms, title, title_length, h1, h1_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // 200 page with every flag; a second 200 page sharing only title and h1.
  ins.run(1, 'https://ex.com/a', 200, 'indexable', 'html', 0, 'http/1.1', 5000, 'Same title', 80, 'Same h1', 3);
  ins.run(2, 'https://ex.com/b', 200, 'indexable', 'html', 0, 'h3', 10, 'Same title', 10, 'Same h1', 1);
  // Redirect and error page: same flags, same shared title/h1 with each other.
  ins.run(3, 'https://ex.com/Redir', 301, 'non-indexable:redirect', 'html', 0, 'http/1.1', 5000, 'Err title', 80, 'Err h1', 3);
  ins.run(4, 'https://ex.com/gone', 404, 'non-indexable:client-error', 'html', 0, 'http/1.1', 5000, 'Err title', 80, 'Err h1', 3);
  // Never fetched internal row and an unprobed external stub (placeholder 'indexable').
  ins.run(5, 'https://ex.com/never', null, 'indexable', 'html', 0, null, null, null, null, null, 0);
  ins.run(6, 'https://other.com/x', null, 'indexable', 'other', 1, null, null, null, null, null, 0);
  raw.close();
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b79-'));
  file = path.join(dir, 'p.seoproject');
  seed();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const GATED: [string, string, number][] = [
  // [category, overview field, expected]: A (response), B (body), duplicates
  ['issues:http3-not-supported', 'http3NotSupported', 1],
  ['issues:response-slow', 'responseSlow', 1],
  ['issues:title-too-long', 'titleTooLong', 1],
  ['issues:h1-multiple', 'h1Multiple', 1],
  ['issues:title-duplicate', 'titleDuplicate', 2],
  ['issues:h1-duplicate', 'h1Duplicate', 2],
];

describe('status gate (B79)', () => {
  it('counts only pages answered 2xx in the sidebar', () => {
    const db = new ProjectDb(file);
    const issues = db.getOverviewCounts().issues as unknown as Record<string, number>;
    db.close();
    for (const [, field, expected] of GATED) expect(issues[field], field).toBe(expected);
  });

  it('lists only pages answered 2xx in the filter, same rows as the count', () => {
    const db = new ProjectDb(file);
    for (const [cat, , expected] of GATED) {
      expect([...db.iterateUrlsByCategory(cat as never)].length, cat).toBe(expected);
    }
    db.close();
  });

  it('every gated filter carries the 2xx gate', () => {
    for (const [cat] of GATED) {
      expect(categoryWhereClause(cat as never), cat).toContain('status_code >= 200 AND status_code < 300');
    }
  });

  it('every status-gated check filters on the 2xx scope', () => {
    expect(STATUS_GATED_ISSUES.size).toBeGreaterThan(100);
    for (const cat of STATUS_GATED_ISSUES) {
      expect(categoryWhereClause(cat as never), cat).toContain('status_code >= 200 AND status_code < 300');
    }
  });

  it('a materialised link check flags only a source page answered 2xx', () => {
    const raw = new DatabaseSync(file);
    const link = raw.prepare(
      `INSERT INTO links (from_url_id, to_url, anchor, is_internal, target) VALUES (?, ?, 'x', 1, '_blank')`,
    );
    for (const [id, name] of [[7, 't1'], [8, 't2'], [9, 't3']] as const) {
      raw
        .prepare(
          `INSERT INTO urls (id, url, status_code, indexability, content_kind, is_external, h1_count)
           VALUES (?, ?, 200, 'indexable', 'html', 0, 0)`,
        )
        .run(id, `https://ex.com/${name}`);
    }
    link.run(1, 'https://ex.com/t1');
    link.run(3, 'https://ex.com/t2');
    link.run(4, 'https://ex.com/t3');
    raw.exec('UPDATE urls SET target_blank_no_noopener_count = 1 WHERE id IN (1, 3, 4)');
    raw.close();
    const db = new ProjectDb(file);
    db.recomputeUrlsIssues(EXPENSIVE_ISSUE_DEFINITIONS);
    const pages = [...db.iterateUrlsByCategory('issues:target-blank-no-noopener' as never)].length;
    const issues = db.getOverviewCounts().issues as unknown as Record<string, number>;
    db.close();
    expect(pages).toBe(1);
    expect(issues.targetBlankNoNoopenerPages).toBe(1);
    // Targets are counted from 2xx source pages too.
    expect(issues.targetBlankNoNoopener).toBe(1);
  });

  it('URL-text checks still count the redirect', () => {
    const db = new ProjectDb(file);
    const issues = db.getOverviewCounts().issues as unknown as Record<string, number>;
    const list = [...db.iterateUrlsByCategory('issues:url-uppercase' as never)].length;
    db.close();
    expect(issues.urlUppercase).toBe(1);
    expect(list).toBe(1);
  });

  it('summary.byIndexability counts fetched internal HTML pages only', () => {
    const db = new ProjectDb(file);
    const s = db.getSummary();
    db.close();
    expect(s.byIndexability).toEqual({
      indexable: 2,
      'non-indexable:redirect': 1,
      'non-indexable:client-error': 1,
    });
    expect(s.total).toBe(6);
    expect(s.byStatus['unknown']).toBe(2);
  });
});
