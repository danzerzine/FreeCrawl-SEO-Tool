import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectDb } from './project-db.js';

// B106: near-duplicate groups hold 2xx pages only, whatever "only indexable" says.
let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b106-'));
  file = path.join(dir, 'p.seoproject');
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  const ins = raw.prepare(
    `INSERT INTO urls (id, url, is_external, content_kind, status_code, indexability, simhash)
     VALUES (?, ?, 0, 'html', ?, 'indexable', '0000000000000000')`,
  );
  for (const [id, status] of [
    [1, 200],
    [2, 200],
    [3, 404],
    [4, 500],
  ] as const) {
    ins.run(id, `https://ex.com/p${id}`, status);
  }
  raw.close();
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('recomputeDuplicateClusters status filter (B106)', () => {
  it.each([true, false])('clusters only 2xx pages with onlyIndexable=%s', (onlyIndexable) => {
    const db = new ProjectDb(file);
    try {
      const res = db.recomputeDuplicateClusters(3, onlyIndexable);
      expect(res.clusteredUrls).toBe(2);
      const members = db
        .listDuplicateClusters(0, 100)
        .flatMap((c) => JSON.stringify(c).match(/p\d/g) ?? []);
      expect(new Set(members)).toEqual(new Set(['p1', 'p2']));
    } finally {
      db.close();
    }
  });
});
