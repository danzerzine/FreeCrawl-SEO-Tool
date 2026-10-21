import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXPENSIVE_ISSUE_DEFINITIONS, ProjectDb } from './project-db.js';

let dir: string;
let file: string;

/**
 * `ok` internal HTML pages answered 200, plus 30 never fetched and 10
 * redirects. On the 200 pages: H1 over 70 chars on the first 115, title over
 * 60 chars on the first 113, keep-alive off on all (a check switched off in
 * settings), one image without alt and one target=_blank link to a distinct
 * internal target on all. Every row, fetched or not, says HTTP/2 (the
 * HTTP/3 check used to count rows that never answered 200, B79).
 */
function seed(ok: number): void {
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  const page = raw.prepare(
    `INSERT INTO urls (id, url, status_code, indexability, content_kind, is_external, h1_length, title_length,
                       keep_alive, images_missing_alt, target_blank_no_noopener_count, http_protocol)
     VALUES (?, ?, ?, 'indexable', 'html', 0, ?, ?, ?, ?, ?, 'h2')`,
  );
  const img = raw.prepare(`INSERT INTO images (id, src, is_internal, occurrences) VALUES (?, ?, 1, 1)`);
  const use = raw.prepare(`INSERT INTO image_usages (from_url_id, image_id, alt) VALUES (?, ?, NULL)`);
  const link = raw.prepare(
    `INSERT INTO links (from_url_id, to_url, anchor, is_internal, target) VALUES (?, ?, 'x', 1, '_blank')`,
  );
  let id = 0;
  for (let i = 0; i < ok; i++) {
    id++;
    page.run(id, `https://ex.com/p${i}`, 200, i < 115 ? 80 : 10, i < 113 ? 70 : 40, 0, 1, 1);
    img.run(id, `https://ex.com/i${i}.png`);
    use.run(id, id);
    link.run(id, `https://ex.com/t${i}`);
  }
  for (let i = 0; i < 30; i++) page.run(++id, `https://ex.com/q${i}`, null, null, null, -1, 0, 0);
  for (let i = 0; i < 10; i++) page.run(++id, `https://ex.com/r${i}`, 301, null, null, -1, 0, 0);
  raw.close();
}

function open(): ProjectDb {
  const db = new ProjectDb(file);
  db.applyCrawlConfigFlags({ disabledIssues: ['issues:keepalive-disabled'] });
  db.recomputeUrlsIssues(EXPENSIVE_ISSUE_DEFINITIONS);
  return db;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b78-'));
  file = path.join(dir, 'p.seoproject');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('site-wide checks (B78)', () => {
  it('a page check on at least 95% of the pages answered 200 is site-wide', () => {
    seed(120);
    const db = open();
    const o = db.getOverviewCounts();
    const h1List = [...db.iterateUrlsByCategory('issues:h1-too-long')].length;
    const http3List = [...db.iterateUrlsByCategory('issues:http3-not-supported')].length;
    db.close();
    const siteWide = o.site?.siteWide;
    expect(siteWide?.pagesBase).toBe(120);
    const byCat = new Map(siteWide?.checks.map((c) => [c.category, c.pages]));
    // 115 of 120 is site-wide, 113 of 120 is not.
    expect(byCat.get('issues:h1-too-long')).toBe(115);
    expect(byCat.has('issues:title-too-long')).toBe(false);
    // B79 fixed the count: HTTP/3 is judged on the 120 pages answered 200 only,
    // the 10 redirects (they carry http_protocol) no longer count. Before B79 it was 160.
    expect(byCat.get('issues:http3-not-supported')).toBe(120);
    expect(o.issues.http3NotSupported).toBe(120);
    // Counted by link target, by image, or switched off: never site-wide.
    expect(byCat.has('issues:target-blank-no-noopener')).toBe(false);
    expect(byCat.has('issues:image-missing-alt')).toBe(false);
    expect(byCat.has('issues:keepalive-disabled')).toBe(false);
    // The check's own list is untouched.
    expect(h1List).toBe(115);
    expect(http3List).toBe(120); // B79: was 160, redirects counted
  });

  it('a crawl with fewer than 100 pages answered 200 has no site-wide checks', () => {
    seed(50);
    const db = open();
    const o = db.getOverviewCounts();
    db.close();
    expect(o.site?.siteWide).toEqual({ pagesBase: 50, checks: [] });
  });
});
