import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProjectDb } from '@freecrawl/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compareCrawls, compareToFiles } from './compare.js';

let dir: string;
const opened: ProjectDb[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b131-'));
});
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

interface Page {
  url: string;
  title?: string;
  canonical?: string;
  links?: string[];
}

/** A small project: every page is an internal 200 HTML page; ids follow the order. */
function project(name: string, pages: Page[]): ProjectDb {
  const file = path.join(dir, `${name}.seoproject`);
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  const ins = raw.prepare(
    `INSERT INTO urls (id, url, is_external, content_kind, status_code, indexability, title, canonical)
     VALUES (?, ?, 0, 'html', 200, 'indexable', ?, ?)`,
  );
  const link = raw.prepare(
    `INSERT INTO links (from_url_id, to_url, anchor, is_internal, rel, type) VALUES (?, ?, 'x', 1, NULL, 'hyperlink')`,
  );
  pages.forEach((p, i) => {
    ins.run(i + 1, p.url, p.title ?? 'T', p.canonical ?? null);
    for (const t of p.links ?? []) link.run(i + 1, t);
  });
  raw.close();
  const db = new ProjectDb(file);
  opened.push(db);
  return db;
}

/** The same site on a host: pages a..e, each linking to the next and canonical to itself. */
function site(base: string, titleOfC = 'T'): Page[] {
  const names = ['', 'a', 'b', 'c', 'd'];
  return names.map((n, i) => ({
    url: `${base}/${n}`,
    title: n === 'c' ? titleOfC : 'T',
    canonical: `${base}/${n}`,
    links: [`${base}/${names[(i + 1) % names.length]}`],
  }));
}

describe('compareCrawls pairs URLs across scheme and www (B131)', () => {
  it('a migration from http://www to http:// reads as the one real change', () => {
    const a = project('a', site('http://www.example.test'));
    const b = project('b', site('http://example.test', 'New'));
    const s = compareCrawls(a, b);
    expect(s.counts.added).toBe(0);
    expect(s.counts.removed).toBe(0);
    expect(s.counts.title).toBe(1);
    expect(s.counts.outlinks).toBe(0);
    expect(s.counts.canonical).toBe(0);
    expect(s.mapped.count).toBe(5);
    expect(s.mapped.examples).toHaveLength(5);
    expect(s.mapped.examples[0]).toEqual({
      before: expect.stringContaining('http://www.example.test/'),
      after: expect.stringContaining('http://example.test/'),
    });
  });

  it('http to https, host case and default ports pair too; examples stop at 20', () => {
    const many = (base: string): Page[] =>
      Array.from({ length: 30 }, (_, i) => ({ url: `${base}/p${i}` }));
    const s = compareCrawls(
      project('a', many('http://Example.test:80')),
      project('b', many('https://www.example.test:443')),
    );
    expect(s.counts.added + s.counts.removed).toBe(0);
    expect(s.mapped.count).toBe(30);
    expect(s.mapped.examples).toHaveLength(20);
  });

  it('a real outlink change on a paired page is still reported', () => {
    const a = project('a', [
      { url: 'http://www.example.test/', links: ['http://www.example.test/x'] },
      { url: 'http://www.example.test/x' },
    ]);
    const b = project('b', [
      { url: 'https://example.test/', links: ['https://example.test/y'] },
      { url: 'https://example.test/x' },
    ]);
    const s = compareCrawls(a, b);
    expect(s.counts.outlinks).toBe(1);
    expect(s.samples.find((r) => r.category === 'outlinks')).toMatchObject({
      before: 'http://www.example.test/x',
      after: 'https://example.test/y',
    });
  });

  it('on a page whose URL did not change, a target moving to https is a change', () => {
    const a = project('a', [
      { url: 'https://example.test/', canonical: 'http://example.test/', links: ['http://example.test/x'] },
    ]);
    const b = project('b', [
      { url: 'https://example.test/', canonical: 'https://example.test/', links: ['https://example.test/x'] },
    ]);
    const s = compareCrawls(a, b);
    expect(s.mapped.count).toBe(0);
    expect(s.counts.canonical).toBe(1);
    expect(s.counts.outlinks).toBe(1);
  });

  it('a key with two unmatched URLs on one side is left as added and removed', () => {
    const a = project('a', [{ url: 'http://example.test/a' }, { url: 'https://example.test/a' }]);
    const b = project('b', [{ url: 'http://www.example.test/a' }]);
    const s = compareCrawls(a, b);
    expect(s.mapped.count).toBe(0);
    expect(s.counts.removed).toBe(2);
    expect(s.counts.added).toBe(1);
  });

  it('an exact match is taken first, so the other scheme stays unpaired', () => {
    const a = project('a', [{ url: 'http://example.test/a' }, { url: 'https://example.test/a' }]);
    const b = project('b', [{ url: 'https://example.test/a' }]);
    const s = compareCrawls(a, b);
    expect(s.mapped.count).toBe(0);
    expect(s.counts.removed).toBe(1);
    expect(s.counts.added).toBe(0);
  });

  it('the export files have no added or removed rows, and the summary file carries mapped', () => {
    const a = project('a', site('http://www.example.test'));
    const b = project('b', site('http://example.test', 'New'));
    const out = path.join(dir, 'out');
    compareToFiles(a, b, out);
    expect(fs.readFileSync(path.join(out, 'compare-added.csv'), 'utf8')).toBe('url,before,after\n');
    expect(fs.readFileSync(path.join(out, 'compare-removed.csv'), 'utf8')).toBe('url,before,after\n');
    const json = JSON.parse(fs.readFileSync(path.join(out, 'compare-summary.json'), 'utf8'));
    expect(json.mapped.count).toBe(5);
  });
});
