import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProjectDb } from '@freecrawl/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compareCrawls } from './compare.js';

let dir: string;
const opened: ProjectDb[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b108-'));
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
const STORED = "INSERT INTO project_meta (key, value) VALUES ('schemaTypesStored', '1');";

describe('compareCrawls: structured data of a project that never stored it (B108)', () => {
  it('an old project with an empty column is not comparable and counts no change', () => {
    const old = project('old', [
      { id: 1, url: U('a') },
      { id: 2, url: U('b') },
    ]);
    const fresh = project(
      'fresh',
      [
        { id: 1, url: U('a'), schema_types: 'Article' },
        { id: 2, url: U('b'), schema_types: 'Product' },
      ],
      STORED,
    );
    const s = compareCrawls(old, fresh);
    expect(s.counts.structured_data).toBe(0);
    expect(s.notComparable.structured_data?.urls).toBe(2);
  });

  it('a crawl that stored it and found no markup is still compared', () => {
    const before = project('before', [{ id: 1, url: U('a') }], STORED);
    const after = project('after', [{ id: 1, url: U('a'), schema_types: 'Article' }], STORED);
    const s = compareCrawls(before, after);
    expect(s.counts.structured_data).toBe(1);
    expect(s.notComparable.structured_data).toBeUndefined();
  });
});
