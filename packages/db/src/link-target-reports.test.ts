import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXPENSIVE_ISSUE_DEFINITIONS, ProjectDb } from './project-db.js';

let dir: string;
let file: string;

const u = (p: string) => `https://ex.com${p}`;
const LONG = 'a'.repeat(120);

/*
 * 100 article pages /p1../p100, every one linking /x (301 -> /y 404) with a
 * long anchor and target=_blank (70 in the content, 30 in the footer).
 * /z (301 -> /gone, no response) is linked from p1..p3, /gone directly from
 * p4..p5, /y directly from p6, the 200 noindex page /ni from p1..p5.
 */
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b4a-'));
  file = path.join(dir, 'p.seoproject');
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  const urls: string[] = [];
  const links: string[] = [];
  for (let i = 1; i <= 100; i++) {
    urls.push(`(${i}, '${u(`/p${i}`)}', 200, 'indexable', NULL, NULL)`);
    links.push(
      `(${i}, '${u('/x')}', '${LONG}', '_blank', '${i <= 70 ? 'content' : 'footer'}')`,
    );
  }
  urls.push(
    `(101, '${u('/x')}', 301, 'non-indexable:redirect', '${u('/y')}', '${u('/y')}')`,
    `(102, '${u('/y')}', 404, 'non-indexable:client-error', NULL, NULL)`,
    `(103, '${u('/z')}', 301, 'non-indexable:redirect', '${u('/gone')}', '${u('/gone')}')`,
    `(104, '${u('/gone')}', NULL, 'non-indexable:no-response', NULL, NULL)`,
    `(105, '${u('/ni')}', 200, 'non-indexable:noindex', NULL, NULL)`,
  );
  for (let i = 1; i <= 3; i++) links.push(`(${i}, '${u('/z')}', 'z', NULL, 'header')`);
  for (let i = 4; i <= 5; i++) links.push(`(${i}, '${u('/gone')}', 'g', NULL, 'content')`);
  links.push(`(6, '${u('/y')}', 'y', NULL, 'content')`);
  for (let i = 1; i <= 5; i++) links.push(`(${i}, '${u('/ni')}', 'n', NULL, 'sidebar')`);
  raw.exec(`
    INSERT INTO project_meta (key, value) VALUES ('redirectChainsComputed', '1');
    INSERT INTO urls (id, url, status_code, indexability, redirect_target, redirect_final_url)
    VALUES ${urls.join(',\n')};
    INSERT INTO links (from_url_id, to_url, anchor, target, link_position)
    VALUES ${links.join(',\n')};
  `);
  raw.close();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('redirects-to-error report', () => {
  it('one row per redirect target whose chain ends in an error', () => {
    const db = new ProjectDb(file);
    const rows = db.linkTargetReport({ report: 'redirects-to-error', limit: 100 })!;
    db.close();
    expect(rows.map((r) => r.targetUrl)).toEqual([u('/x'), u('/z')]);
    expect(rows[0]).toEqual({
      targetUrl: u('/x'),
      statusCode: 301,
      indexability: 'non-indexable:redirect',
      finalUrl: u('/y'),
      finalStatusCode: 404,
      finalIndexability: 'non-indexable:client-error',
      sourcePages: 100,
      isTemplate: true,
      topPosition: 'content',
      sampleSourceUrl: u('/p1'),
    });
  });
});

describe('link-target reports, other cases', () => {
  it('a redirect ending in no response carries a NULL final status', () => {
    const db = new ProjectDb(file);
    const z = db
      .linkTargetReport({ report: 'redirects-to-error', limit: 100 })!
      .find((r) => r.targetUrl === u('/z'))!;
    db.close();
    expect(z.finalUrl).toBe(u('/gone'));
    expect(z.finalStatusCode).toBeNull();
    expect(z.finalIndexability).toBe('non-indexable:no-response');
    expect(z.sourcePages).toBe(3);
    expect(z.isTemplate).toBe(false);
    expect(z.topPosition).toBe('header');
  });

  it('the template filter splits a site-wide target from one on a few pages', () => {
    const db = new ProjectDb(file);
    const only = db.linkTargetReport({ report: 'redirects-to-error', templateLinks: 'only', limit: 100 })!;
    const without = db.linkTargetReport({ report: 'redirects-to-error', templateLinks: 'exclude', limit: 100 })!;
    db.close();
    expect(only.map((r) => r.targetUrl)).toEqual([u('/x')]);
    expect(without.map((r) => r.targetUrl)).toEqual([u('/z')]);
  });

  it('error-inlinks lists 4xx and no-response targets by target', () => {
    const db = new ProjectDb(file);
    const rows = db.linkTargetReport({ report: 'error-inlinks', limit: 100 })!;
    db.close();
    expect(rows.map((r) => [r.targetUrl, r.statusCode, r.sourcePages])).toEqual([
      [u('/gone'), null, 2],
      [u('/y'), 404, 1],
    ]);
  });

  it('non-indexable-inlinks groups by reason and includes a noindex target', () => {
    const db = new ProjectDb(file);
    const rows = db.linkTargetReport({ report: 'non-indexable-inlinks', limit: 100 })!;
    db.close();
    expect(rows.map((r) => [r.indexability, r.targetUrl, r.sourcePages])).toEqual([
      ['non-indexable:client-error', u('/y'), 1],
      ['non-indexable:no-response', u('/gone'), 2],
      ['non-indexable:noindex', u('/ni'), 5],
      ['non-indexable:redirect', u('/x'), 100],
      ['non-indexable:redirect', u('/z'), 3],
    ]);
    expect(rows.find((r) => r.targetUrl === u('/ni'))!.topPosition).toBe('sidebar');
  });
});

describe('link-check issue totals count targets (B63)', () => {
  it('totals are distinct targets; the per-page flags stay on every source page', () => {
    const db = new ProjectDb(file);
    db.recomputeUrlsIssues(EXPENSIVE_ISSUE_DEFINITIONS);
    const issues = db.getOverviewCounts().issues;
    const flagged = [...db.iterateUrlsByCategory('issues:internal-link-to-redirect')].length;
    const blankFlagged = [...db.iterateUrlsByCategory('issues:target-blank-no-noopener')].length;
    db.close();
    expect(issues.internalLinkToRedirect).toBe(2); // /x and /z
    expect(issues.targetBlankNoNoopener).toBe(1); // /x
    expect(issues.anchorTextTooLong).toBe(1); // /x
    expect(issues.brokenLinksInternal).toBe(2); // /y and /gone, not 3 links
    expect(flagged).toBe(100);
    expect(blankFlagged).toBe(100);
  });
});

describe('link-check totals carry both numbers', () => {
  it('targets and the source pages (or links) they are linked from', () => {
    const db = new ProjectDb(file);
    db.recomputeUrlsIssues(EXPENSIVE_ISSUE_DEFINITIONS);
    const i = db.getOverviewCounts().issues;
    const redirects = db.linkTargetReport({ report: 'redirect-inlinks', limit: 100 })!;
    db.close();
    expect([i.targetBlankNoNoopener, i.targetBlankNoNoopenerPages]).toEqual([1, 100]);
    expect([i.anchorTextTooLong, i.anchorTextTooLongPages]).toEqual([1, 100]);
    expect([i.internalLinkToRedirect, i.internalLinkToRedirectPages]).toEqual([2, 100]);
    expect([i.brokenLinksInternal, i.brokenLinksInternalLinks]).toEqual([2, 3]);
    // The by-target report behind the redirect total lists exactly its targets.
    expect(redirects.map((r) => r.targetUrl)).toEqual([u('/x'), u('/z')]);
  });
});

describe('one redirect target on 100 pages', () => {
  it('internal-link-to-redirect: targets 1, pages 100', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b4a-one-'));
    const f = path.join(d, 'p.seoproject');
    new ProjectDb(f).close();
    const raw = new DatabaseSync(f);
    const pages = Array.from({ length: 100 }, (_, i) => `(${i + 1}, '${u(`/q${i + 1}`)}', 200, NULL)`);
    raw.exec(`
      INSERT INTO urls (id, url, status_code, redirect_final_url) VALUES ${pages.join(',')},
        (101, '${u('/r')}', 301, '${u('/ok')}'), (102, '${u('/ok')}', 200, NULL);
      INSERT INTO links (from_url_id, to_url, is_internal)
        SELECT id, '${u('/r')}', 1 FROM urls WHERE id <= 100;
    `);
    raw.close();
    const db = new ProjectDb(f);
    db.recomputeUrlsIssues(EXPENSIVE_ISSUE_DEFINITIONS);
    const i = db.getOverviewCounts().issues;
    db.close();
    fs.rmSync(d, { recursive: true, force: true });
    expect([i.internalLinkToRedirect, i.internalLinkToRedirectPages]).toEqual([1, 100]);
  });
});
