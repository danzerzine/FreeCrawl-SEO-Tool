import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectDb } from './project-db.js';

let dir: string;
const opened: ProjectDb[] = [];
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b44db-'));
});
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
const open = (name: string): ProjectDb => {
  const db = new ProjectDb(path.join(dir, `${name}.seoproject`));
  opened.push(db);
  return db;
};
const put = (db: ProjectDb, url: string, over: Record<string, unknown> = {}): number =>
  db.upsertUrl({ url, depth: 0, statusCode: 200, indexability: 'indexable', contentKind: 'html', ...over });
const nums = (db: ProjectDb, id: number) => {
  const r = db.getUrlById(id)!;
  return [r.cssBytes, r.cssUnusedBytes, r.jsBytes, r.jsUnusedBytes];
};

describe('B44 stored coverage columns', () => {
  it('store, read back, and tell "measured, nothing there" (0) from "not measured" (NULL)', () => {
    const db = open('a');
    const some = put(db, 'https://ex.com/some', { cssBytes: 1000, cssUnusedBytes: 700, jsBytes: 5000, jsUnusedBytes: 1200 });
    const zero = put(db, 'https://ex.com/zero', { cssBytes: 0, cssUnusedBytes: 0, jsBytes: 0, jsUnusedBytes: 0 });
    const unmeasured = put(db, 'https://ex.com/none');
    expect(nums(db, some)).toEqual([1000, 700, 5000, 1200]);
    expect(nums(db, zero)).toEqual([0, 0, 0, 0]);
    expect(nums(db, unmeasured)).toEqual([null, null, null, null]);
  });

  it('a refresh with the option off overwrites the four columns with NULL', () => {
    const db = open('b');
    const id = put(db, 'https://ex.com/p', { cssBytes: 10, cssUnusedBytes: 5, jsBytes: 20, jsUnusedBytes: 5 });
    put(db, 'https://ex.com/p');
    expect(nums(db, id)).toEqual([null, null, null, null]);
  });
});
