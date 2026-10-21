import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EXPENSIVE_ISSUE_DEFINITIONS, packProject, ProjectDb } from '@freecrawl/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compareCrawls, compareWithoutMmap, openCompareProject } from './compare.js';

let dir: string;
const opened: ProjectDb[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b22-'));
});
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

interface Row {
  id: number;
  url: string;
  title?: string | null;
  h1?: string | null;
  depth?: number | null;
  schema_types?: string | null;
  content_hash?: string | null;
  content_source?: string | null;
}

/** A small project file: `rows` are internal 200 HTML pages; `extra` is raw SQL run after the inserts. */
function project(name: string, rows: Row[], extra = ''): ProjectDb {
  const file = path.join(dir, `${name}.seoproject`);
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  const ins = raw.prepare(
    `INSERT INTO urls (id, url, is_external, content_kind, status_code, indexability, title, h1, depth, schema_types, content_hash, content_source)
     VALUES (?, ?, 0, 'html', 200, 'indexable', ?, ?, ?, ?, ?, ?)`,
  );
  for (const r of rows)
    ins.run(
      r.id,
      r.url,
      r.title === undefined ? 'T' : r.title,
      r.h1 === undefined ? 'H' : r.h1,
      r.depth ?? 1, r.schema_types ?? null,
      r.content_hash ?? null,
      r.content_source ?? null,
    );
  if (extra) raw.exec(extra);
  raw.close();
  const db = new ProjectDb(file);
  opened.push(db);
  return db;
}

const U = (n: string): string => `https://ex.com/${n}`;

describe('compareCrawls: page-level kinds (B22)', () => {
  it('depth and structured_data changes are counted and sampled with before and after', () => {
    const before = project('before', [
      { id: 1, url: U('a'), depth: 1, schema_types: 'Article' },
      { id: 2, url: U('b'), depth: 2, schema_types: 'Product,BreadcrumbList' },
      { id: 3, url: U('c'), depth: 2, schema_types: null },
    ]);
    const after = project('after', [
      { id: 1, url: U('a'), depth: 3, schema_types: 'Article' },
      { id: 2, url: U('b'), depth: 2, schema_types: 'Product' },
      { id: 3, url: U('c'), depth: 2, schema_types: null },
    ]);
    const s = compareCrawls(before, after);
    expect(s.counts.depth).toBe(1);
    expect(s.counts.structured_data).toBe(1);
    expect(s.samples.filter((r) => r.category === 'depth')).toEqual([
      { url: U('a'), category: 'depth', before: '1', after: '3' },
    ]);
    expect(s.samples.filter((r) => r.category === 'structured_data')).toEqual([
      { url: U('b'), category: 'structured_data', before: 'Product,BreadcrumbList', after: 'Product' },
    ]);
  });
});

describe('compareCrawls: content (B22)', () => {
  it('content changes only where both sides hashed the same content source; the rest is not comparable', () => {
    const before = project('before', [
      { id: 1, url: U('same'), content_hash: 'h1', content_source: 'main' },
      { id: 2, url: U('edited'), content_hash: 'h2', content_source: 'main' },
      { id: 3, url: U('moved-source'), content_hash: 'h3', content_source: 'main' },
      { id: 4, url: U('no-hash'), content_hash: null, content_source: 'main' },
      { id: 5, url: U('no-source'), content_hash: 'h5', content_source: null },
    ]);
    const after = project('after', [
      { id: 1, url: U('same'), content_hash: 'h1', content_source: 'main' },
      { id: 2, url: U('edited'), content_hash: 'h2b', content_source: 'main' },
      { id: 3, url: U('moved-source'), content_hash: 'h3b', content_source: 'body' },
      { id: 4, url: U('no-hash'), content_hash: 'h4', content_source: 'main' },
      { id: 5, url: U('no-source'), content_hash: 'h5b', content_source: null },
    ]);
    const s = compareCrawls(before, after);
    expect(s.counts.content).toBe(1);
    expect(s.samples.filter((r) => r.category === 'content')).toEqual([
      { url: U('edited'), category: 'content', before: 'h2', after: 'h2b' },
    ]);
    expect(s.notComparable.content?.urls).toBe(3);
    expect(s.notComparable.content?.reason).toMatch(/content source|hash/i);
  });
});

describe('compareCrawls: outlinks (B22)', () => {
  const links = (rows: [number, string, { rel?: string; type?: string; internal?: number }?][]): string =>
    rows
      .map(
        ([from, to, o]) =>
          `INSERT INTO links (from_url_id, to_url, anchor, is_internal, rel, type) VALUES (${from}, '${to}', 'x', ${o?.internal ?? 1}, ${o?.rel ? `'${o.rel}'` : 'NULL'}, '${o?.type ?? 'hyperlink'}');`,
      )
      .join('\n');

  it('the set of followed internal link targets decides; repeats, nofollow, external and images do not', () => {
    const pages = [1, 2, 3, 4].map((id) => ({ id, url: U(`p${id}`) }));
    const before = project(
      'before',
      pages,
      links([
        [1, U('x')],
        [1, U('y')],
        [2, U('x')],
        [3, U('x')],
        [4, U('x')],
      ]),
    );
    const after = project(
      'after',
      pages,
      links([
        [1, U('y')],
        [1, U('x')],
        [1, U('x')],
        [1, U('z'), { rel: 'nofollow' }],
        [1, 'https://other.org/', { internal: 0 }],
        [1, U('img.png'), { type: 'image' }],
        [2, U('x')],
        [2, U('new')],
        [3, U('y')],
      ]),
    );
    const s = compareCrawls(before, after);
    const rows = s.samples.filter((r) => r.category === 'outlinks');
    expect(s.counts.outlinks).toBe(3);
    expect(rows).toEqual([
      { url: U('p2'), category: 'outlinks', before: null, after: U('new') },
      { url: U('p3'), category: 'outlinks', before: U('x'), after: U('y') },
      { url: U('p4'), category: 'outlinks', before: U('x'), after: null },
    ]);
  });
});

describe('compareCrawls: issues (B22)', () => {
  const pagesBefore = [
    { id: 1, url: U('p1'), title: null },
    { id: 2, url: U('p2'), h1: null },
    { id: 3, url: U('p3') },
  ];
  const pagesAfter = [
    { id: 1, url: U('p1') },
    { id: 2, url: U('p2'), title: null, h1: null },
    { id: 3, url: U('p3'), h1: null },
    { id: 4, url: U('p4'), title: null },
  ];

  it('counts pages per check that appeared or resolved, and lists the checks that changed per page', () => {
    const s = compareCrawls(project('before', pagesBefore), project('after', pagesAfter));
    expect(s.issueChanges['issues:title-missing']).toEqual({ appeared: 1, resolved: 1 });
    expect(s.issueChanges['issues:h1-missing']).toEqual({ appeared: 1, resolved: 0 });
    // a check both crawls flag the same page for is no change (meta-description-missing is on every fixture page)
    expect(s.issueChanges['issues:meta-description-missing']).toBeUndefined();
    expect(s.counts.issues).toBe(3);
    const rows = s.samples.filter((r) => r.category === 'issues');
    expect(rows.map((r) => r.url)).toEqual([U('p1'), U('p2'), U('p3')]);
    expect(rows[0]!.before).toContain('issues:title-missing');
    expect(rows[0]!.after ?? '').not.toContain('issues:title-missing');
    expect(rows[1]!.after).toContain('issues:title-missing');
    expect(rows[2]!.after).toContain('issues:h1-missing');
  });

  it('a check silenced in either project is left out', () => {
    const before = project('before', pagesBefore);
    const after = project('after', pagesAfter);
    after.setDisabledIssues(['issues:h1-missing']);
    const s = compareCrawls(before, after);
    expect(s.issueChanges['issues:title-missing']).toEqual({ appeared: 1, resolved: 1 });
    expect(s.issueChanges['issues:h1-missing']).toBeUndefined();
    expect(JSON.stringify(s.samples)).not.toContain('issues:h1-missing');
  });

  it('a check silenced only in the older project is left out too', () => {
    const before = project('before', pagesBefore);
    before.setDisabledIssues(['issues:title-missing']);
    const s = compareCrawls(before, project('after', pagesAfter));
    expect(s.issueChanges['issues:title-missing']).toBeUndefined();
    expect(s.issueChanges['issues:h1-missing']).toEqual({ appeared: 1, resolved: 0 });
  });
});

describe('compareCrawls: older project (B22)', () => {
  it('a column the project lacks makes that kind not comparable, no error; other kinds still compare', () => {
    const older = project('older', [{ id: 1, url: U('a'), title: 'Old' }]);
    const file = path.join(dir, 'older.seoproject');
    older.close();
    opened.splice(opened.indexOf(older), 1);
    const raw = new DatabaseSync(file);
    raw.exec(`DROP INDEX IF EXISTS idx_urls_depth; DROP INDEX IF EXISTS idx_urls_content_hash;
      ALTER TABLE urls DROP COLUMN depth; ALTER TABLE urls DROP COLUMN schema_types;
      ALTER TABLE urls DROP COLUMN content_hash; ALTER TABLE urls DROP COLUMN content_source;
      ALTER TABLE links DROP COLUMN type;`);
    raw.close();
    const readOnly = new ProjectDb(file, { readOnly: true });
    opened.push(readOnly);
    const current = project('current', [{ id: 1, url: U('a'), title: 'New', depth: 4, content_hash: 'h', content_source: 'main' }]);

    const s = compareCrawls(readOnly, current);
    expect(s.counts.title).toBe(1);
    for (const kind of ['depth', 'structured_data', 'content', 'outlinks']) {
      expect(s.counts[kind as 'depth'], kind).toBe(0);
      expect(s.notComparable[kind]?.reason, kind).toMatch(/missing/);
      expect(s.notComparable[kind]?.urls, kind).toBe(1);
    }
  });
  it('a check whose filter cannot run on the older project is no change, even where the newer one flags the page', () => {
    const older = project('older', [{ id: 1, url: U('a') }]);
    const file = path.join(dir, 'older.seoproject');
    older.close();
    opened.splice(opened.indexOf(older), 1);
    const raw = new DatabaseSync(file);
    const idx = raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND sql LIKE '%folder_depth%'`).all() as { name: string }[];
    for (const { name } of idx) raw.exec(`DROP INDEX ${name}`);
    raw.exec('ALTER TABLE urls DROP COLUMN folder_depth');
    raw.close();
    const readOnly = new ProjectDb(file, { readOnly: true });
    opened.push(readOnly);
    const current = project('current', [{ id: 1, url: U('a') }], 'UPDATE urls SET folder_depth = 6');

    const s = compareCrawls(readOnly, current);
    expect(s.notComparable['issues:folder-depth-too-deep']?.urls).toBe(1);
    expect(s.issueChanges['issues:folder-depth-too-deep']).toBeUndefined();
    expect(JSON.stringify(s.samples)).not.toContain('issues:folder-depth-too-deep');
  });
});

describe('openCompareProject (B22)', () => {
  const compareTemps = (): string[] => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('freecrawl-compare-'));

  /** A closed project file: `rows` flat, with one page missing its title. */
  function closedProject(name: string): string {
    const db = project(name, [{ id: 1, url: U('a'), title: null }]);
    db.close();
    opened.splice(opened.indexOf(db), 1);
    return path.join(dir, `${name}.seoproject`);
  }

  it('opens an archive .seoproject through a temp copy, brings the stored checks current, deletes the copy after', async () => {
    const file = closedProject('plain');
    const archive = path.join(dir, 'packed.seoproject');
    await packProject(file, archive);
    const before = compareTemps();

    const handle = await openCompareProject(archive);
    expect(handle.db.issueMaterialisationStale()).toBe(false);
    const current = project('current', [{ id: 1, url: U('a') }]);
    const s = compareCrawls(handle.db, current);
    expect(s.totalA).toBe(1);
    expect(s.issueChanges['issues:title-missing']).toEqual({ appeared: 0, resolved: 1 });
    expect(compareTemps().length).toBe(before.length + 1);

    handle.dispose();
    expect(compareTemps()).toEqual(before);
  });

  it('a bare SQLite project with current checks is read as it is: the file is not changed, nothing is left behind', async () => {
    const file = closedProject('bare');
    // Stale checks are rebuilt and saved back (B109); current ones leave the file alone.
    const current = new ProjectDb(file);
    current.recomputeUrlsIssues(EXPENSIVE_ISSUE_DEFINITIONS);
    current.close();
    const bytes = fs.readFileSync(file);
    const before = compareTemps();

    const handle = await openCompareProject(file);
    expect(handle.db.issueMaterialisationStale()).toBe(false);
    handle.dispose();

    expect(fs.readFileSync(file).equals(bytes)).toBe(true);
    expect(compareTemps()).toEqual(before);
  });

  it('a damaged archive is refused and its temp copy deleted', async () => {
    const archive = path.join(dir, 'packed.seoproject');
    await packProject(closedProject('plain'), archive);
    const bytes = fs.readFileSync(archive);
    fs.writeFileSync(archive, bytes.subarray(0, Math.floor(bytes.length / 2)));
    const before = compareTemps();
    await expect(openCompareProject(archive)).rejects.toThrow();
    expect(compareTemps()).toEqual(before);
  });

  it('refuses a missing file and a file that is not a project', async () => {
    await expect(openCompareProject(path.join(dir, 'nope.seoproject'))).rejects.toThrow(/not found/i);
    const junk = path.join(dir, 'junk.seoproject');
    fs.writeFileSync(junk, 'hello');
    await expect(openCompareProject(junk)).rejects.toThrow(/not a FreeCrawl project/i);
  });
});

describe('compareWithoutMmap (B22)', () => {
  const mmap = (db: ProjectDb): number =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((db as any).db.prepare('PRAGMA mmap_size').get() as { mmap_size: number }).mmap_size;

  it('runs the comparison with the memory map off on both projects and restores it after', async () => {
    const a = project('a', [{ id: 1, url: U('a') }]);
    const b = project('b', [{ id: 1, url: U('a') }]);
    const before = mmap(a);
    expect(before).toBeGreaterThan(0);
    const seen = await compareWithoutMmap(a, b, () => [mmap(a), mmap(b)]);
    expect(seen).toEqual([0, 0]);
    expect([mmap(a), mmap(b)]).toEqual([before, before]);
  });
});
