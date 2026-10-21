import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProjectDb } from '@freecrawl/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportDatasetFile } from './tabular-export.js';
import { ISSUE_CATEGORIES } from '@freecrawl/shared-types';

let dir: string;
let db: ProjectDb;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b8f-'));
  const file = path.join(dir, 'p.seoproject');
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec(`INSERT INTO urls (id, url, status_code) VALUES (1,'https://ex.com/a',200);
    INSERT INTO crawl_queue (url, depth, seed_url) VALUES ('https://ex.com/q', 2, 'https://ex.com/');`);
  raw.close();
  db = new ProjectDb(file);
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('exportDatasetFile (B8)', () => {
  it('writes one dataset with its catalogue columns, labels or keys', async () => {
    const f = path.join(dir, 'sub', 'crawl-queue.csv');
    const res = await exportDatasetFile(db, f, 'crawl-queue', { label: 'Crawl Queue' });
    expect(res.rowsWritten).toBe(1);
    expect(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')).toBe(
      'URL,Depth,Seed URL\nhttps://ex.com/q,2,https://ex.com/\n',
    );
    const k = path.join(dir, 'k.csv');
    await exportDatasetFile(db, k, 'crawl-queue', { label: 'Crawl Queue', headers: 'keys' });
    expect(fs.readFileSync(k, 'utf8').replace(/^﻿/, '').split('\n')[0]).toBe('url,depth,seedUrl');
  });

  it('an empty dataset leaves no file; a size-dependent one says why', async () => {
    const f = path.join(dir, 'issues-long.csv');
    fs.writeFileSync(f, 'old\n');
    db.setDisabledIssues([...ISSUE_CATEGORIES]);
    const res = await exportDatasetFile(db, f, 'issues-long', { label: 'Issues' });
    expect(res.rowsWritten).toBe(0);
    expect(fs.existsSync(f)).toBe(false);
    const j = path.join(dir, 'page-html.jsonl');
    const html = await exportDatasetFile(db, j, 'page-html', { label: 'Page HTML', format: 'jsonl' });
    expect(fs.existsSync(j)).toBe(false);
    expect(html.skipped?.[0]?.label).toBe('Page HTML');
  });
});
