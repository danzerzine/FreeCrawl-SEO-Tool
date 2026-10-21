import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { packProject, ProjectDb } from '@freecrawl/db';
import { COMPARE_CATEGORIES } from '@freecrawl/shared-types';
import { cancelledCompareResult, compareWithOpenProject } from './compare-load.js';

let dir: string;
const dbs: ProjectDb[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-cmp-desktop-'));
});
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function project(name: string, title: string): string {
  const file = path.join(dir, name);
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec(`INSERT INTO urls (id, url, is_external, content_kind, status_code, indexability, title, h1)
            VALUES (1, 'https://ex.com/a', 0, 'html', 200, 'indexable', '${title}', 'H')`);
  raw.close();
  return file;
}

describe('desktop compare (B22)', () => {
  it('the open project is "after", the picked file is "before"', async () => {
    const open = new ProjectDb(project('open.seoproject', 'Newer'));
    dbs.push(open);
    const picked = project('picked.seoproject', 'Older');

    const r = await compareWithOpenProject(open, picked);

    expect(r.filePath).toBe(picked);
    expect(r.counts.title).toBe(1);
    expect(r.samples.find((s) => s.category === 'title')).toEqual({
      url: 'https://ex.com/a',
      category: 'title',
      before: 'Older',
      after: 'Newer',
    });
    expect(r).toHaveProperty('issueChanges');
    expect(r).toHaveProperty('notComparable');
  });

  it('opens an archive file as the picked project', async () => {
    const open = new ProjectDb(project('open.seoproject', 'Newer'));
    dbs.push(open);
    const archive = path.join(dir, 'picked-packed.seoproject');
    await packProject(project('picked.seoproject', 'Older'), archive);

    const r = await compareWithOpenProject(open, archive);

    expect(r.samples.find((s) => s.category === 'title')?.before).toBe('Older');
  });

  it('a cancelled pick has a zero for every kind', () => {
    const r = cancelledCompareResult();
    expect(r.filePath).toBe('');
    expect(Object.keys(r.counts)).toEqual([...COMPARE_CATEGORIES]);
    expect(Object.values(r.counts).every((n) => n === 0)).toBe(true);
  });
});
