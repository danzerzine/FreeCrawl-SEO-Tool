import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProjectDb, workFolder } from '@freecrawl/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openCompareProject } from './compare.js';

// B120: a project in a read-only folder, or a read-only project file, is compared
// through a temp copy; the original's folder gets no -wal / -shm. The checks go by
// the mode bits (not access(2)), so they hold when the tests run as root.
let dir: string;
let work: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b120-'));
  work = path.join(dir, 'work-root');
  fs.mkdirSync(work);
});
afterEach(() => {
  fs.chmodSync(path.join(dir, 'proj'), 0o755);
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A closed project with one page in `<dir>/proj`; its stored checks are behind this build, so a compare rebuilds them. */
function project(): string {
  fs.mkdirSync(path.join(dir, 'proj'));
  const file = path.join(dir, 'proj', 'site.seoproject');
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec(`INSERT INTO urls (id, url, is_external, content_kind, status_code, indexability, title)
    VALUES (1, 'https://ex.com/a', 0, 'html', 200, 'indexable', NULL)`);
  raw.exec(`UPDATE project_meta SET value = 'old' WHERE key = 'urlsIssuesVersion'`);
  raw.close();
  return file;
}

const copies = (): string[] =>
  fs.existsSync(workFolder(work)) ? fs.readdirSync(workFolder(work)) : [];
const listing = (): string[] => fs.readdirSync(path.join(dir, 'proj')).sort();
const rows = (db: ProjectDb): number =>
  (db.iterateRows<{ n: number }>('SELECT count(*) AS n FROM urls')[Symbol.iterator]().next()
    .value as { n: number }).n;

describe('read-only project (B120)', () => {
  it.each([
    ['folder', (file: string) => fs.chmodSync(path.dirname(file), 0o555)],
    ['file', (file: string) => fs.chmodSync(file, 0o444)],
  ] as const)('read-only %s: compared through a copy, nothing left beside the original', async (_, lock) => {
    const file = project();
    const before = listing();
    lock(file);

    const handle = await openCompareProject(file, work);
    try {
      expect(handle.rebuiltSaved).toBe(false);
      expect(handle.db.issueMaterialisationStale()).toBe(false);
      expect(rows(handle.db)).toBe(1);
      // The copy lives in the work folder, not beside the original.
      expect(copies()).toHaveLength(1);
    } finally {
      handle.dispose();
    }
    expect(copies()).toEqual([]);
    expect(listing()).toEqual(before);

    // Once writing is allowed again the project opens for writing as before.
    fs.chmodSync(path.dirname(file), 0o755);
    fs.chmodSync(file, 0o644);
    const writer = new ProjectDb(file);
    writer.close();
    expect(listing()).toEqual(before);
  });
});

describe('read-only project with rows still in its log (B120)', () => {
  it('the copy holds them and the original folder is untouched', async () => {
    const file = project();
    const writer = new DatabaseSync(file);
    writer.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;');
    writer.exec(`INSERT INTO urls (id, url, is_external, content_kind, status_code, indexability)
      VALUES (2, 'https://ex.com/b', 0, 'html', 200, 'indexable')`);
    fs.chmodSync(file, 0o444);
    const before = listing();
    let after: string[] = [];
    const handle = await openCompareProject(file, work);
    try {
      expect(rows(handle.db)).toBe(2);
    } finally {
      handle.dispose();
      after = listing();
      writer.close();
      fs.chmodSync(file, 0o644);
    }
    expect(after).toEqual(before);
  });
});

describe('writable project (B120)', () => {
  it('is still read in place, with no copy', async () => {
    const file = project();
    const handle = await openCompareProject(file, work);
    try {
      expect(rows(handle.db)).toBe(1);
      expect(copies()).toEqual([]);
    } finally {
      handle.dispose();
    }
  });
});
