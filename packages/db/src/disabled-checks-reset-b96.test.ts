import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectDb } from './project-db.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b96-'));
  file = path.join(dir, 'p.seoproject');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A 2xx HTML page with no title: the one thing `title-missing` counts. */
function addTitlelessPage(): void {
  const raw = new DatabaseSync(file);
  raw.exec(`INSERT INTO urls (id, url, is_external, content_kind, status_code, indexability)
            VALUES (1, 'https://ex.com/a', 0, 'html', 200, 'indexable')`);
  raw.close();
}

describe('B96: the first crawl of a new project keeps the disabled checks', () => {
  it('a check disabled before the crawl start stays disabled and uncounted after the start-of-crawl wipe', () => {
    // The desktop copies the config into the project, then the crawler wipes
    // a new site's project (`reset()`) before the first page is stored.
    const db = new ProjectDb(file);
    db.applyCrawlConfigFlags({ disabledIssues: ['issues:title-missing'] });
    db.reset();
    db.close();

    addTitlelessPage();

    const after = new ProjectDb(file);
    const disabled = [...after.getDisabledIssues()];
    const titleMissing = after.getOverviewCounts().issues.titleMissing;
    after.close();
    expect(disabled).toEqual(['issues:title-missing']);
    expect(titleMissing).toBe(0);
  });
});
