import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CHECKS_FILLED_META_KEY, LATER_CHECKS, ProjectDb } from '@freecrawl/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compareCrawls } from './compare.js';
import { parseHtml } from './html-parser.js';

const PAGE = 'https://ex.com/a';
const doc = (head: string): string => `<!doctype html><html><head>${head}</head><body><p>x</p></body></html>`;

describe('og:* written with name= (B25)', () => {
  it('reads og:image and og:title from name= and marks the page', () => {
    const p = parseHtml(doc('<meta name="og:image" content="https://ex.com/i.png"><meta name="og:title" content="T">'), PAGE);
    expect(p.ogImage).toBe('https://ex.com/i.png');
    expect(p.ogTitle).toBe('T');
    expect(p.ogNameAttr).toBe(1);
  });
  it('property wins when both are present, and the page is not marked', () => {
    const p = parseHtml(
      doc('<meta name="og:image" content="https://ex.com/n.png"><meta property="og:image" content="https://ex.com/p.png">'),
      PAGE,
    );
    expect(p.ogImage).toBe('https://ex.com/p.png');
    expect(p.ogNameAttr).toBe(0);
  });
  it('a property-only page is unchanged', () => {
    const p = parseHtml(doc('<meta property="og:image" content="https://ex.com/p.png">'), PAGE);
    expect(p.ogImage).toBe('https://ex.com/p.png');
    expect(p.ogNameAttr).toBe(0);
  });
});

let dir: string;
const opened: ProjectDb[] = [];
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b25-'));
});
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Two pages flagged by og-name-attribute: one 200, one 404. `filled` = the meta key, absent when null. */
function project(name: string, flag: number, filled: readonly string[] | null): ProjectDb {
  const file = path.join(dir, `${name}.seoproject`);
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec(`INSERT INTO urls (id, url, is_external, content_kind, status_code, indexability, og_name_attr)
    VALUES (1, 'https://ex.com/a', 0, 'html', 200, 'indexable', ${flag}),
           (2, 'https://ex.com/b', 0, 'html', 404, 'non-indexable:client-error', ${flag})`);
  raw.close();
  const db = new ProjectDb(file);
  if (filled) db.setMeta(CHECKS_FILLED_META_KEY, JSON.stringify(filled));
  opened.push(db);
  return db;
}

describe('og-name-attribute check and checks a build fills (B25, M5 F1)', () => {
  it('counts 2xx pages only', () => {
    const db = project('p', 1, LATER_CHECKS);
    expect(db.getOverviewCounts().issues.ogNameAttribute).toBe(1);
  });
  it('an older crawl that did not fill the check: not comparable, not "appeared"', () => {
    const old = project('old', 0, null);
    const now = project('now', 1, LATER_CHECKS);
    const s = compareCrawls(old, now);
    expect(s.issueChanges['issues:og-name-attribute']).toBeUndefined();
    expect(s.notComparable['issues:og-name-attribute']?.reason).toMatch(/not checked by the build/);
  });
  it('both crawls filled it: compared', () => {
    const s = compareCrawls(project('a', 0, LATER_CHECKS), project('b', 1, LATER_CHECKS));
    expect(s.issueChanges['issues:og-name-attribute']).toEqual({ appeared: 1, resolved: 0 });
    expect(s.notComparable['issues:og-name-attribute']).toBeUndefined();
  });
});
