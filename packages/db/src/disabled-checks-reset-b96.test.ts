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

  it('the duplicate-URL comparison switch (off) survives the wipe', () => {
    const db = new ProjectDb(file);
    db.applyCrawlConfigFlags({ dedupePreNormalize: false });
    db.reset();
    const stored = db.getMeta('dedupePreNormalize');
    db.close();
    expect(stored).toBe('0');
  });

  it('custom SEO thresholds survive the wipe and still decide the count', () => {
    const db = new ProjectDb(file);
    db.applyCrawlConfigFlags({ seoThresholds: { titleMaxChars: 100 } });
    db.reset();
    db.close();

    const raw = new DatabaseSync(file);
    raw.exec(`INSERT INTO urls (id, url, is_external, content_kind, status_code, indexability, title, title_length)
              VALUES (1, 'https://ex.com/a', 0, 'html', 200, 'indexable', 'x', 80)`);
    raw.close();

    const after = new ProjectDb(file);
    const max = after.getSeoThresholds().titleMaxChars;
    const tooLong = after.getOverviewCounts().issues.titleTooLong;
    after.close();
    // 80 chars is over the default 60 but under the user's 100.
    expect(max).toBe(100);
    expect(tooLong).toBe(0);
  });

  it('the saved crawl config and start URL the desktop writes at crawl start survive the wipe', () => {
    const db = new ProjectDb(file);
    db.setMeta('lastCrawlConfig', '{"startUrl":"https://ex.com/"}');
    db.setMeta('lastStartUrl', 'https://ex.com/');
    db.reset();
    const config = db.getMeta('lastCrawlConfig');
    const start = db.getMeta('lastStartUrl');
    db.close();
    expect(config).toBe('{"startUrl":"https://ex.com/"}');
    expect(start).toBe('https://ex.com/');
  });
});
