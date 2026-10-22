import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProjectDb } from '@freecrawl/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { datasetRows } from './dataset-export.js';
import { EXPORT_DATASET_COLUMNS } from '@freecrawl/shared-types';
import { BULK_EXPORT_DATASET_TASKS } from './bulk-export.js';
import { ISSUE_CATEGORIES } from '@freecrawl/shared-types';

// Bare fixture rows trip many cheap checks; keep only the checks under test.
const allBut = (...keep: string[]): string[] => ISSUE_CATEGORIES.filter((c) => !keep.includes(c));
const KEPT = ['issues:duplicate-url-post-norm', 'issues:canonical-chain-multi-hop', 'issues:image-too-large'];

let dir: string;
let file: string;
let db: ProjectDb;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b54-'));
  file = path.join(dir, 'p.seoproject');
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec(`
    INSERT INTO urls (id, url, status_code, indexability) VALUES
      (1,'https://ex.com/a',200,'indexable'),(2,'https://ex.com/b',200,'indexable'),
      (3,'https://ex.com/c',200,'indexable'),(10,'https://ex.com/gone',404,'non-indexable:client-error'),
      (11,'https://ex.com/gone2',410,'non-indexable:client-error');
    INSERT INTO links (from_url_id,to_url,anchor,is_internal,link_position) VALUES
      (1,'https://ex.com/gone','x',1,'content'),(1,'https://ex.com/gone','y',1,'footer'),
      (2,'https://ex.com/gone','z',1,'content'),(3,'https://ex.com/gone2','w',1,NULL);
    INSERT INTO urls_issues (url_id, issue_key) VALUES
      (1,'issues:duplicate-url-post-norm'),(1,'issues:canonical-chain-multi-hop'),(2,'issues:duplicate-url-post-norm'),(3,'issues:image-too-large');
    INSERT INTO sitemap_urls (url, lastmod, source_sitemap) VALUES
      ('https://ex.com/a','2026-01-02','https://ex.com/sitemap.xml'),('https://ex.com/z',NULL,'https://ex.com/s2.xml');
    INSERT INTO crawl_queue (url, depth, seed_url) VALUES ('https://ex.com/q1',2,'https://ex.com/'),('https://ex.com/q2',3,'https://ex.com/');
  `);
  raw.close();
  db = new ProjectDb(file);
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('B54 datasets', () => {
  it('issues-long: one row per (url, issue key), by check then URL id', () => {
    db.setDisabledIssues(allBut(...KEPT));
    const rows = [...datasetRows(db, 'issues-long')];
    expect(rows.map((r) => [r.url, r.issueKey])).toEqual([
      ['https://ex.com/a', 'issues:canonical-chain-multi-hop'],
      ['https://ex.com/a', 'issues:duplicate-url-post-norm'],
      ['https://ex.com/b', 'issues:duplicate-url-post-norm'],
      ['https://ex.com/c', 'issues:image-too-large'],
    ]);
  });
  it('issues-long skips disabled issues', () => {
    db.setDisabledIssues(allBut('issues:canonical-chain-multi-hop', 'issues:image-too-large'));
    const keys = [...datasetRows(db, 'issues-long')].map((r) => r.issueKey);
    expect(keys).toEqual(['issues:canonical-chain-multi-hop', 'issues:image-too-large']);
  });
  it('sitemap-urls', () => {
    const rows = [...datasetRows(db, 'sitemap-urls')];
    expect(rows).toEqual([
      { url: 'https://ex.com/a', lastmod: '2026-01-02', sourceSitemap: 'https://ex.com/sitemap.xml', sitemapCount: null },
      { url: 'https://ex.com/z', lastmod: null, sourceSitemap: 'https://ex.com/s2.xml', sitemapCount: null },
    ]);
  });
  it('crawl-queue', () => {
    const rows = [...datasetRows(db, 'crawl-queue')];
    expect(rows).toEqual([
      { url: 'https://ex.com/q1', depth: 2, seedUrl: 'https://ex.com/' },
      { url: 'https://ex.com/q2', depth: 3, seedUrl: 'https://ex.com/' },
    ]);
  });
  it('broken-links-by-target', () => {
    const rows = [...datasetRows(db, 'broken-links-by-target')];
    expect(rows).toEqual([
      { toUrl: 'https://ex.com/gone2', toStatusCode: 410, linkCount: 1, linkingPages: 1, contentLinks: 0 },
      { toUrl: 'https://ex.com/gone', toStatusCode: 404, linkCount: 3, linkingPages: 2, contentLinks: 2 },
    ]);
  });
  it('broken-links gain Position', () => {
    const rows = [...datasetRows(db, 'broken-links')];
    expect(rows.map((r) => r.position)).toEqual([null, 'content', 'footer', 'content']);
    expect(EXPORT_DATASET_COLUMNS['broken-links'].map((c) => c.header)).toContain('Link Position');
  });
  it('bulk lists the new datasets', () => {
    expect(BULK_EXPORT_DATASET_TASKS.map((t) => t.dataset)).toEqual([
      'broken-links', 'broken-links-by-target', 'issues-long', 'response-headers', 'sitemap-urls', 'sitemap-files', 'sitemap-reconciliation', 'crawl-queue',
    ]);
  });
});
