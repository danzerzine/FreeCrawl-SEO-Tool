import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ProjectDb } from './project-db.js';

let dir: string;
let file: string;

// /old: crawled before uncrawlable links were stored one by one (count only).
// /new: has a stored internal uncrawlable link.
// /ext: its only uncrawlable link points off-site.
// /clean: none.
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-unc-'));
  file = path.join(dir, 'p.seoproject');
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec(`
    INSERT INTO urls (id, url, is_external, content_kind, status_code, js_only_links_count) VALUES
      (1, 'https://ex.com/old', 0, 'html', 200, 2),
      (2, 'https://ex.com/new', 0, 'html', 200, 1),
      (3, 'https://ex.com/ext', 0, 'html', 200, 1),
      (4, 'https://ex.com/clean', 0, 'html', 200, 0);
    INSERT INTO uncrawlable_links (from_url_id, tag, value, target, is_internal) VALUES
      (2, 'span', '/x', 'https://ex.com/x', 1),
      (3, 'button', 'https://other.org/', 'https://other.org/', 0);
  `);
  raw.close();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

it('pages with only the stored count still count as having uncrawlable internal outlinks', () => {
  const db = new ProjectDb(file);
  const urls = [...db.iterateUrlsByCategory('issues:js-only-navigation')].map((r) => r.url).sort();
  const count = db.getOverviewCounts().issues.jsOnlyNavigation;
  db.close();
  expect(urls).toEqual(['https://ex.com/new', 'https://ex.com/old']);
  expect(count).toBe(2);
});
